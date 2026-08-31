import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, jest, test } from 'bun:test'
import { DisconnectReason, type WASocket } from 'baileys'
import { WhatsAppProvider } from '../../../src/providers/whatsapp/index.ts'
import { mensaje } from '../../helpers/fixtures.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

class TestSocket {
  private readonly connectionHandlers: ((update: unknown) => void)[] = []
  private readonly upsertHandlers: ((update: unknown) => void)[] = []
  endCalls = 0
  readonly value: WASocket

  constructor(
    private closeEventsWhenBound = 0,
    selfId = 'self@s.whatsapp.net',
  ) {
    this.value = {
      ev: {
        on: (event: string, handler: (update: unknown) => void) => {
          if (event === 'messages.upsert') {
            this.upsertHandlers.push(handler)
            return
          }
          if (event !== 'connection.update') return
          this.connectionHandlers.push(handler)
          while (this.closeEventsWhenBound > 0) {
            this.closeEventsWhenBound -= 1
            handler({ connection: 'close', lastDisconnect: { error: undefined } })
          }
        },
      },
      end: async () => {
        this.endCalls += 1
      },
      sendMessage: async () => {
        throw new Error('Baileys recibió una operación sobre un socket cerrado')
      },
      groupFetchAllParticipating: async () => {
        throw new Error('Baileys recibió una operación sobre un socket cerrado')
      },
      user: { id: selfId },
    } as unknown as WASocket
  }

  emitOpen(): void {
    for (const handler of this.connectionHandlers) handler({ connection: 'open' })
  }

  emitClose(statusCode?: number): void {
    const error = statusCode === undefined ? undefined : { output: { statusCode } }
    for (const handler of this.connectionHandlers) {
      handler({ connection: 'close', lastDisconnect: { error } })
    }
  }

  emitUpsert(messages: unknown[]): void {
    for (const handler of this.upsertHandlers) handler({ messages })
  }
}

function provider(): WhatsAppProvider {
  return new WhatsAppProvider({
    authDir: './data/test-wa-auth',
    mediaDir: './data/test-media',
  })
}

test('acepta una factory de sockets para probar el ciclo de conexión sin red', () => {
  const adapter = new WhatsAppProvider({
    authDir: './unused',
    mediaDir: './unused',
    socketFactory: () => ({}) as WASocket,
  })

  expect(adapter.id).toBe('whatsapp')
})

test('dos eventos close concurrentes producen un solo socket de reemplazo', async () => {
  jest.useFakeTimers()
  try {
    const sockets: TestSocket[] = []
    const adapter = new WhatsAppProvider({
      authDir: './unused',
      mediaDir: './unused',
      socketFactory: () => {
        const socket = new TestSocket()
        sockets.push(socket)
        return socket.value
      },
    })
    await adapter.connect()
    sockets[0]?.emitOpen()

    sockets[0]?.emitClose()
    sockets[0]?.emitClose()
    jest.advanceTimersByTime(2_000)
    await flushMicrotasks()

    expect(sockets).toHaveLength(2)
  } finally {
    jest.useRealTimers()
  }
})

test('close concurrentes durante la publicación conservan un reconnect único', async () => {
  jest.useFakeTimers()
  try {
    const sockets = [new TestSocket(2), new TestSocket()]
    let attempts = 0
    const adapter = new WhatsAppProvider({
      authDir: './unused',
      mediaDir: './unused',
      socketFactory: () => {
        const socket = sockets[attempts]
        attempts += 1
        if (!socket) throw new Error('factory agotada')
        return socket.value
      },
    })

    await adapter.connect()
    jest.advanceTimersByTime(1_000)
    await flushMicrotasks()

    expect(attempts).toBe(2)
  } finally {
    jest.useRealTimers()
  }
})

test('disconnect durante setup invalida y cierra el socket tardío', async () => {
  const setup = deferred<WASocket>()
  const socket = new TestSocket()
  const adapter = new WhatsAppProvider({
    authDir: './unused',
    mediaDir: './unused',
    socketFactory: () => setup.promise,
  })

  const connecting = adapter.connect()
  await adapter.disconnect()
  setup.resolve(socket.value)
  await connecting
  socket.emitOpen()

  expect(socket.endCalls).toBe(1)
  await expect(
    adapter.send(
      { provider: 'whatsapp', externalId: 'chat@s.whatsapp.net' },
      { text: 'hola' },
      'late-send',
    ),
  ).rejects.toThrow('Se cerró la conexión antes de estar lista')
})

test('un setup fallido durante reconnect se reintenta hasta crear un socket', async () => {
  jest.useFakeTimers()
  try {
    const first = new TestSocket()
    const recovered = new TestSocket()
    let attempts = 0
    const adapter = new WhatsAppProvider({
      authDir: './unused',
      mediaDir: './unused',
      socketFactory: () => {
        attempts += 1
        if (attempts === 1) return first.value
        if (attempts === 2) throw new Error('fallo transitorio de setup')
        return recovered.value
      },
    })
    await adapter.connect()
    first.emitOpen()
    first.emitClose()

    jest.advanceTimersByTime(1_000)
    await flushMicrotasks()
    jest.advanceTimersByTime(2_000)
    await flushMicrotasks()

    expect(attempts).toBe(3)
  } finally {
    jest.useRealTimers()
  }
})

test('logout queda terminal para readiness y operaciones posteriores', async () => {
  const socket = new TestSocket()
  const recovered = new TestSocket()
  let attempts = 0
  const adapter = new WhatsAppProvider({
    authDir: './unused',
    mediaDir: './unused',
    socketFactory: () => {
      attempts += 1
      return attempts === 1 ? socket.value : recovered.value
    },
  })
  await adapter.connect()
  socket.emitOpen()
  socket.emitClose(DisconnectReason.loggedOut)

  let readinessOutcome = 'pending'
  void adapter.waitUntilReady(10_000).then(
    () => {
      readinessOutcome = 'resolved'
    },
    (error: unknown) => {
      readinessOutcome = error instanceof Error ? error.message : String(error)
    },
  )
  await flushMicrotasks()
  const readinessBeforeDisconnect = readinessOutcome
  const sendOutcome = await adapter
    .send(
      { provider: 'whatsapp', externalId: 'chat@s.whatsapp.net' },
      { text: 'hola' },
      'logged-out-send',
    )
    .then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

  await adapter.connect()
  recovered.emitOpen()
  await expect(adapter.waitUntilReady()).resolves.toBeUndefined()
  await adapter.disconnect()

  expect(readinessBeforeDisconnect).toBe(
    'La sesión de WhatsApp fue cerrada desde el teléfono',
  )
  expect(sendOutcome).toBe('La sesión de WhatsApp fue cerrada desde el teléfono')
})

function waMessageDePrueba(id: string, fromMe = false): unknown {
  return {
    key: { remoteJid: '5491111111111@s.whatsapp.net', id, fromMe },
    messageTimestamp: 1788091200,
    pushName: 'Ana',
    message: { conversation: 'hola' },
  }
}

test('disconnect espera el despacho que estaba en vuelo', async () => {
  const socket = new TestSocket()
  const adapter = new WhatsAppProvider({
    authDir: './unused',
    mediaDir: './unused',
    socketFactory: () => socket.value,
  })

  const enManejador = deferred<void>()
  const terminaManejador = deferred<void>()
  adapter.onMessage(async () => {
    enManejador.resolve()
    await terminaManejador.promise
  })
  await adapter.connect()
  socket.emitOpen()
  socket.emitUpsert([waMessageDePrueba('EN-VUELO')])
  await enManejador.promise

  let desconectado = false
  const desconectando = adapter.disconnect().then(() => {
    desconectado = true
  })
  await flushMicrotasks()
  const antesDeTerminarElManejador = desconectado

  terminaManejador.resolve()
  await desconectando

  // Si `disconnect` devuelve con el manejador corriendo, el apagado vacía un buffer al que
  // ese mensaje todavía no llegó y cierra la base debajo de él.
  expect(antesDeTerminarElManejador).toBe(false)
  expect(desconectado).toBe(true)
})

test('normaliza el sufijo de dispositivo del JID propio', async () => {
  const socket = new TestSocket(0, '5491100000000:12@s.whatsapp.net')
  const adapter = new WhatsAppProvider({
    authDir: './unused',
    mediaDir: './unused',
    socketFactory: () => socket.value,
  })

  const remitentes: (string | undefined)[] = []
  adapter.onMessage(async (message) => {
    remitentes.push(message.sender?.externalId)
  })
  await adapter.connect()
  socket.emitOpen()
  socket.emitUpsert([waMessageDePrueba('PROPIO', true)])
  await adapter.disconnect()

  expect(remitentes).toEqual(['5491100000000@s.whatsapp.net'])
})

test('un logout avisa por el canal de fallo terminal', async () => {
  const socket = new TestSocket()
  const adapter = new WhatsAppProvider({
    authDir: './unused',
    mediaDir: './unused',
    socketFactory: () => socket.value,
  })

  const fatales: string[] = []
  adapter.onFatal((error) => fatales.push(error.message))
  await adapter.connect()
  socket.emitOpen()
  socket.emitClose(DisconnectReason.loggedOut)

  expect(fatales).toEqual(['La sesión de WhatsApp fue cerrada desde el teléfono'])
})

test('una caída recuperable no avisa como fallo terminal', async () => {
  jest.useFakeTimers()
  try {
    const sockets: TestSocket[] = []
    const adapter = new WhatsAppProvider({
      authDir: './unused',
      mediaDir: './unused',
      socketFactory: () => {
        const socket = new TestSocket()
        sockets.push(socket)
        return socket.value
      },
    })

    const fatales: string[] = []
    adapter.onFatal((error) => fatales.push(error.message))
    await adapter.connect()
    sockets[0]?.emitOpen()
    sockets[0]?.emitClose(DisconnectReason.connectionLost)
    jest.advanceTimersByTime(2_000)
    await flushMicrotasks()

    expect(fatales).toEqual([])
  } finally {
    jest.useRealTimers()
  }
})

test('un manejador de fallo terminal que rompe no se lleva puesto el cierre', async () => {
  const socket = new TestSocket()
  const adapter = new WhatsAppProvider({
    authDir: './unused',
    mediaDir: './unused',
    socketFactory: () => socket.value,
  })

  adapter.onFatal(() => {
    throw new Error('el aviso rompió')
  })
  await adapter.connect()
  socket.emitOpen()
  socket.emitClose(DisconnectReason.loggedOut)

  await expect(adapter.waitUntilReady()).rejects.toThrow(
    'La sesión de WhatsApp fue cerrada desde el teléfono',
  )
})

test('waitUntilReady rechaza cuando vence el tiempo', async () => {
  await expect(provider().waitUntilReady(5)).rejects.toThrow(
    'La conexión no estuvo lista en 5 ms',
  )
})

test('disconnect rechaza una espera pendiente', async () => {
  const adapter = provider()
  const pending = adapter.waitUntilReady(10_000)

  await adapter.disconnect()

  await expect(pending).rejects.toThrow('Se cerró la conexión antes de estar lista')
})

test('send falla claramente si no hay conexión', async () => {
  await expect(
    provider().send(
      { provider: 'whatsapp', externalId: '5491111111111@s.whatsapp.net' },
      { text: 'hola' },
      'message-id',
    ),
  ).rejects.toThrow('WhatsAppProvider sin conectar')
})

test('listConversations falla claramente si no hay conexión', async () => {
  await expect(provider().listConversations()).rejects.toThrow('WhatsAppProvider sin conectar')
})

const directoriosDeMedios: string[] = []

afterAll(async () => {
  for (const directorio of directoriosDeMedios) await rm(directorio, { recursive: true, force: true })
})

async function adaptadorConDescarga(bytes: Uint8Array): Promise<WhatsAppProvider> {
  const mediaDir = await mkdtemp(join(tmpdir(), 'bot-whatsapp-medios-'))
  directoriosDeMedios.push(mediaDir)
  return new WhatsAppProvider({
    authDir: './unused',
    mediaDir,
    socketFactory: () => new TestSocket().value,
    downloadMedia: async () => bytes,
  })
}

function mensajeConAdjunto(
  conversationExternalId: string,
  attachmentExternalId: string,
  mimeType: string | null = 'audio/ogg; codecs=opus',
) {
  return mensaje({
    provider: 'whatsapp',
    conversation: { externalId: conversationExternalId, kind: 'dm', name: null },
    attachments: [
      { externalId: attachmentExternalId, kind: 'audio', mimeType, sizeBytes: 2, durationMs: null },
    ],
  })
}

test('dos adjuntos con el mismo id en chats distintos no se pisan', async () => {
  const adapter = await adaptadorConDescarga(new Uint8Array([1, 2]))

  // El id de mensaje de WhatsApp es único por chat, no globalmente: dos chats pueden
  // traer el mismo y la ruta tiene que seguir distinguiéndolos.
  const primero = await adapter.downloadAttachment(
    mensajeConAdjunto('5491111111111@s.whatsapp.net', 'ABC123:0'),
    'ABC123:0',
  )
  const segundo = await adapter.downloadAttachment(
    mensajeConAdjunto('120363000000000000@g.us', 'ABC123:0'),
    'ABC123:0',
  )

  expect(primero.localPath).not.toBe(segundo.localPath)
  expect(await Bun.file(primero.localPath).exists()).toBe(true)
  expect(await Bun.file(segundo.localPath).exists()).toBe(true)
})

test('la ruta del adjunto sanea los separadores del JID', async () => {
  const adapter = await adaptadorConDescarga(new Uint8Array([1, 2]))

  const { localPath } = await adapter.downloadAttachment(
    mensajeConAdjunto('5491111111111:12@s.whatsapp.net', 'AB/CD:0'),
    'AB/CD:0',
  )

  expect(localPath).toContain('5491111111111_12@s.whatsapp.net')
  expect(localPath.endsWith('AB_CD_0.ogg')).toBe(true)
})

test('la extensión sale del mimetype del adjunto', async () => {
  const adapter = await adaptadorConDescarga(new Uint8Array([1, 2]))

  const conMime = await adapter.downloadAttachment(
    mensajeConAdjunto('c1@s.whatsapp.net', 'A1:0', 'image/jpeg'),
    'A1:0',
  )
  const sinMime = await adapter.downloadAttachment(
    mensajeConAdjunto('c1@s.whatsapp.net', 'A2:0', null),
    'A2:0',
  )
  const raro = await adapter.downloadAttachment(
    mensajeConAdjunto('c1@s.whatsapp.net', 'A3:0', 'application/vnd.openxmlformats-officedocument'),
    'A3:0',
  )

  expect(conMime.localPath.endsWith('A1_0.jpeg')).toBe(true)
  expect(sinMime.localPath.endsWith('A2_0')).toBe(true)
  expect(raro.localPath.endsWith('A3_0')).toBe(true)
})

test('devuelve el tamaño realmente escrito', async () => {
  const adapter = await adaptadorConDescarga(new Uint8Array([1, 2, 3, 4, 5]))

  const { localPath, sizeBytes } = await adapter.downloadAttachment(
    mensajeConAdjunto('c1@s.whatsapp.net', 'A1:0'),
    'A1:0',
  )

  expect(sizeBytes).toBe(5)
  expect(await Bun.file(localPath).size).toBe(5)
})

test('disconnect permite que el proceso termine sin esperar el timeout pendiente', async () => {
  const source = `
    import { WhatsAppProvider } from './src/providers/whatsapp/index.ts'
    const provider = new WhatsAppProvider({ authDir: './unused', mediaDir: './unused' })
    const pending = provider.waitUntilReady(10_000)
    await provider.disconnect()
    await pending.catch(() => {})
  `
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const result = await Promise.race([
    child.exited.then((exitCode) => ({ kind: 'exited' as const, exitCode })),
    Bun.sleep(500).then(() => ({ kind: 'timed-out' as const })),
  ])

  if (result.kind === 'timed-out') child.kill()
  expect(result).toEqual({ kind: 'exited', exitCode: 0 })
})
