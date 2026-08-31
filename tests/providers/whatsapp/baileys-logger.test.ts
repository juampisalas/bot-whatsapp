import { expect, test } from 'bun:test'
import type { Logger } from '../../../src/domain/logger.ts'
import { createBaileysLogger } from '../../../src/providers/whatsapp/baileys-logger.ts'

interface Linea {
  nivel: 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

function espia(): { log: Logger; lineas: Linea[] } {
  const lineas: Linea[] = []
  return {
    lineas,
    log: {
      info: (message, meta) => lineas.push({ nivel: 'info', message, meta }),
      warn: (message, meta) => lineas.push({ nivel: 'warn', message, meta }),
      error: (message, meta) => lineas.push({ nivel: 'error', message, meta }),
    },
  }
}

test('reenvía advertencias y errores con su texto', () => {
  const { log, lineas } = espia()
  const baileys = createBaileysLogger(log)

  baileys.warn({}, 'keep alive called when WS not open')
  baileys.error({ err: new Error('x') }, 'stream errored out')

  expect(lineas).toEqual([
    { nivel: 'warn', message: 'baileys: keep alive called when WS not open', meta: undefined },
    { nivel: 'error', message: 'baileys: stream errored out', meta: undefined },
  ])
})

test('no reenvía la carga que acompaña a la línea', () => {
  const { log, lineas } = espia()
  const baileys = createBaileysLogger(log)

  // Baileys manda JIDs, nodos binarios y datos de pairing en ese objeto.
  baileys.warn({ jid: '5491111111111@s.whatsapp.net' }, 'failed to store user device lists')

  expect(lineas[0]?.meta).toBeUndefined()
  expect(JSON.stringify(lineas)).not.toContain('5491111111111')
})

test('acepta la forma de una sola línea de texto', () => {
  const { log, lineas } = espia()
  const baileys = createBaileysLogger(log)

  baileys.warn('⚠️ Using the Android browser is experimental')

  expect(lineas[0]?.message).toBe('baileys: ⚠️ Using the Android browser is experimental')
})

test('descarta trace, debug e info', () => {
  const { log, lineas } = espia()
  const baileys = createBaileysLogger(log)

  baileys.trace({}, 'recv')
  baileys.debug({}, 'decoded node')
  baileys.info({ me: { id: '5491100000000@s.whatsapp.net' } }, 'pairing configured successfully')

  expect(lineas).toEqual([])
})

test('descarta una línea sin texto en vez de volcar el objeto', () => {
  const { log, lineas } = espia()
  const baileys = createBaileysLogger(log)

  baileys.error({ node: { contenido: 'privado' } })

  expect(lineas).toEqual([])
})

test('declara un nivel que no dispara el trabajo extra de trace ni debug', () => {
  const baileys = createBaileysLogger(espia().log)

  // Baileys compara `logger.level` con 'trace' y 'debug' para decidir si serializa nodos.
  expect(baileys.level).not.toBe('trace')
  expect(baileys.level).not.toBe('debug')
})

test('child sigue escribiendo en el mismo destino', () => {
  const { log, lineas } = espia()
  const baileys = createBaileysLogger(log)

  baileys.child({ class: 'ns' }).warn({}, 'algo pasó')

  expect(lineas[0]?.message).toBe('baileys: algo pasó')
})
