import { expect, test } from 'bun:test'
import type { Logger } from '../../../src/domain/logger.ts'
import { createBaileysLogger } from '../../../src/providers/whatsapp/baileys-logger.ts'

interface Line {
  level: 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

function spy(): { log: Logger; lines: Line[] } {
  const lines: Line[] = []
  return {
    lines,
    log: {
      info: (message, meta) => lines.push({ level: 'info', message, meta }),
      warn: (message, meta) => lines.push({ level: 'warn', message, meta }),
      error: (message, meta) => lines.push({ level: 'error', message, meta }),
    },
  }
}

test('reenvía advertencias y errores con su texto', () => {
  const { log, lines } = spy()
  const baileys = createBaileysLogger(log)

  baileys.warn({}, 'keep alive called when WS not open')
  baileys.error({ err: new Error('x') }, 'stream errored out')

  expect(lines).toEqual([
    { level: 'warn', message: 'baileys: keep alive called when WS not open', meta: undefined },
    { level: 'error', message: 'baileys: stream errored out', meta: undefined },
  ])
})

test('no reenvía la carga que acompaña a la línea', () => {
  const { log, lines } = spy()
  const baileys = createBaileysLogger(log)

  // Baileys manda JIDs, nodos binarios y datos de pairing en ese objeto.
  baileys.warn({ jid: '5491111111111@s.whatsapp.net' }, 'failed to store user device lists')

  expect(lines[0]?.meta).toBeUndefined()
  expect(JSON.stringify(lines)).not.toContain('5491111111111')
})

test('acepta la forma de una sola línea de texto', () => {
  const { log, lines } = spy()
  const baileys = createBaileysLogger(log)

  baileys.warn('⚠️ Using the Android browser is experimental')

  expect(lines[0]?.message).toBe('baileys: ⚠️ Using the Android browser is experimental')
})

test('descarta trace, debug e info', () => {
  const { log, lines } = spy()
  const baileys = createBaileysLogger(log)

  baileys.trace({}, 'recv')
  baileys.debug({}, 'decoded node')
  baileys.info({ me: { id: '5491100000000@s.whatsapp.net' } }, 'pairing configured successfully')

  expect(lines).toEqual([])
})

test('descarta una línea sin texto en vez de volcar el objeto', () => {
  const { log, lines } = spy()
  const baileys = createBaileysLogger(log)

  baileys.error({ node: { contenido: 'privado' } })

  expect(lines).toEqual([])
})

test('declara un nivel que no dispara el trabajo extra de trace ni debug', () => {
  const baileys = createBaileysLogger(spy().log)

  // Baileys compara `logger.level` con 'trace' y 'debug' para decidir si serializa nodos.
  expect(baileys.level).not.toBe('trace')
  expect(baileys.level).not.toBe('debug')
})

test('child sigue escribiendo en el mismo destino', () => {
  const { log, lines } = spy()
  const baileys = createBaileysLogger(log)

  baileys.child({ class: 'ns' }).warn({}, 'algo pasó')

  expect(lines[0]?.message).toBe('baileys: algo pasó')
})
