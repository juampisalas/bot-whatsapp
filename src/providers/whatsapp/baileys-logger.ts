import type { Logger } from '../../domain/logger.ts'

/**
 * The logger shape Baileys expects in its `logger` option (pino-like).
 *
 * Declared here instead of imported: Baileys does not re-export it from the package root,
 * and depending on an internal path would couple us to its file tree.
 */
export interface BaileysLogger {
  level: string
  child(bindings: Record<string, unknown>): BaileysLogger
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

/**
 * Routes Baileys logging through the project Logger instead of letting it write on its own.
 *
 * Without this option Baileys builds its own pino at `info` on stdout: even with
 * `LOG_LEVEL=error`, raw JSON lines with JIDs and pairing data still appear, in a format
 * that does not match the rest of the log.
 *
 * Passing a silent pino would also mute the only Baileys lines useful in production:
 * connection and decrypt warnings that explain drops the adapter otherwise sees only as
 * `connection: 'close'`. This shim keeps those and filters the rest:
 *
 * - `trace`, `debug`, and `info` are dropped entirely. That is where per-message noise lives,
 *   and the most sensitive bits too (`pairing configured successfully` carries credentials;
 *   some info lines dump full nodes in the message text).
 * - For `warn` and `error` only the text is forwarded — a Baileys constant. The accompanying
 *   object (JIDs, binary nodes, participants) is discarded: that is what must not reach an
 *   ops log.
 */
export function createBaileysLogger(log: Logger): BaileysLogger {
  /** Baileys uses both pino forms: `(obj, msg)` and `(msg)`. */
  function text(obj: unknown, msg?: string): string | null {
    if (typeof msg === 'string') return msg
    return typeof obj === 'string' ? obj : null
  }

  function emit(level: 'warn' | 'error') {
    return (obj: unknown, msg?: string): void => {
      const line = text(obj, msg)
      // Without text only the object remains, which is exactly what we do not forward.
      if (line !== null) log[level](`baileys: ${line}`)
    }
  }

  const logger: BaileysLogger = {
    // Baileys compares this to 'trace' and 'debug' before serializing full nodes: declaring
    // the level we actually emit avoids that work and those dumps.
    level: 'warn',
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: emit('warn'),
    error: emit('error'),
  }

  return logger
}
