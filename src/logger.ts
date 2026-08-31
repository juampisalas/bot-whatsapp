import type { Config } from './config/index.ts'
import type { Logger } from './domain/logger.ts'

const orden = { info: 20, warn: 30, error: 40 } as const

export function createLogger(level: Config['LOG_LEVEL']): Logger {
  const minimo = orden[level]

  const emitir =
    (nivel: keyof typeof orden) =>
    (message: string, meta?: Record<string, unknown>): void => {
      if (orden[nivel] < minimo) return
      const sufijo = meta ? ` ${JSON.stringify(meta)}` : ''
      console.log(`${new Date().toISOString()} ${nivel.toUpperCase()} ${message}${sufijo}`)
    }

  return { info: emitir('info'), warn: emitir('warn'), error: emitir('error') }
}
