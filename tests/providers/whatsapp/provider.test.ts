import { expect, jest, test } from 'bun:test'
import { DisconnectReason, type WASocket } from 'baileys'
import { WhatsAppProvider } from '../../../src/providers/whatsapp/index.ts'

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
  endCalls = 0

  constructor(private closeWhenBound = false) {}

  readonly value = {
    ev: {
      on: (event: string, handler: (update: unknown) => void) => {
        if (event !== 'connection.update') return
        this.connectionHandlers.push(handler)
        if (this.closeWhenBound) {
          this.closeWhenBound = false
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
    user: { id: 'self@s.whatsapp.net' },
  } as unknown as WASocket

  emitOpen(): void {
    for (const handler of this.connectionHandlers) handler({ connection: 'open' })
  }

  emitClose(statusCode?: number): void {
    const error = statusCode === undefined ? undefined : { output: { statusCode } }
    for (const handler of this.connectionHandlers) {
      handler({ connection: 'close', lastDisconnect: { error } })
    }
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

test('un close durante la publicación del socket conserva el reconnect supervisado', async () => {
  jest.useFakeTimers()
  try {
    const sockets = [new TestSocket(true), new TestSocket()]
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
