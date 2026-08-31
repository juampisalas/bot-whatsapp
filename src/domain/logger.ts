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
  return describirCadena(error, new Set())
}

/**
 * Corta si la cadena de causas se cierra en ciclo (`a.cause = b`, `b.cause = a`): sin eso
 * la recursión desborda la pila justo cuando se está intentando reportar un fallo, y quien
 * llama suele estar en un camino de error donde ya no queda dónde avisar.
 */
function describirCadena(error: unknown, vistos: Set<unknown>): string {
  if (!(error instanceof Error)) return String(error)

  const codigo = 'code' in error && typeof error.code === 'string' ? error.code : null
  const propio = error.message || codigo || error.name
  vistos.add(error)
  return error.cause === undefined || vistos.has(error.cause)
    ? propio
    : `${propio}: ${describirCadena(error.cause, vistos)}`
}
