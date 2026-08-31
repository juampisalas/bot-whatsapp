export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * Arma la línea de `error` de un log sin stack trace.
 *
 * Encadena las causas porque quien envuelve suele no nombrarlas: drizzle reporta
 * "Failed query" y deja el `ECONNREFUSED` adentro, que es lo único que le sirve a
 * quien está mirando por qué no arrancó.
 */
export function describirError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)

  const codigo = 'code' in error && typeof error.code === 'string' ? error.code : null
  const propio = error.message || codigo || error.name
  return error.cause === undefined ? propio : `${propio}: ${describirError(error.cause)}`
}
