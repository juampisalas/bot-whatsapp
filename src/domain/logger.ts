export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * Builds a single-line error string with no stack trace.
 *
 * Walks the cause chain because wrappers often hide the useful bit: drizzle reports
 * "Failed query" and leaves `ECONNREFUSED` inside, which is what you need when
 * diagnosing a failed start.
 */
export function describeError(error: unknown): string {
  return describeCauseChain(error, new Set())
}

/**
 * Stops if the cause chain cycles (`a.cause = b`, `b.cause = a`): without that the
 * recursion overflows the stack exactly when we are trying to report a failure.
 */
function describeCauseChain(error: unknown, seen: Set<unknown>): string {
  if (!(error instanceof Error)) return String(error)

  const code = 'code' in error && typeof error.code === 'string' ? error.code : null
  const own = error.message || code || error.name
  seen.add(error)
  return error.cause === undefined || seen.has(error.cause)
    ? own
    : `${own}: ${describeCauseChain(error.cause, seen)}`
}
