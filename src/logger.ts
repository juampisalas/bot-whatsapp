import type { Config } from './config/index.ts'
import type { Logger } from './domain/logger.ts'

const levels = { info: 20, warn: 30, error: 40 } as const

export function createLogger(level: Config['LOG_LEVEL']): Logger {
  const minimum = levels[level]

  const emit =
    (current: keyof typeof levels) =>
    (message: string, meta?: Record<string, unknown>): void => {
      if (levels[current] < minimum) return
      const suffix = meta ? ` ${JSON.stringify(meta)}` : ''
      console.log(`${new Date().toISOString()} ${current.toUpperCase()} ${message}${suffix}`)
    }

  return { info: emit('info'), warn: emit('warn'), error: emit('error') }
}
