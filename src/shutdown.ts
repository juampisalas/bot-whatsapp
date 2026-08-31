import type { Logger } from './domain/logger.ts'
import { describeError } from './domain/logger.ts'
import type { MessagingProvider } from './domain/provider.ts'

export interface ShutdownDeps {
  /** Minimum ingest pipeline surface: flush queued messages and report what remains. */
  pipeline: {
    flushBuffer(): Promise<number>
    readonly bufferSize: number
  }
  provider: Pick<MessagingProvider, 'disconnect'>
  closeDb: () => Promise<void>
  /** Stops the periodic buffer retry timer. */
  stopRetries: () => void
  log: Logger
  /** Hard deadline for the whole shutdown sequence. Default 15s. */
  timeoutMs?: number
}

export interface Shutdown {
  /**
   * Runs once and returns how many messages were left unpersisted.
   *
   * Never rejects: signal handlers call this, and an uncaught rejection would kill
   * the process mid-shutdown; the cached promise would then reject on every later signal.
   */
  shutDown(): Promise<number>
  /**
   * True once a shutdown has started or finished. Callers waiting on the provider use
   * this to tell a connect failure apart from the disconnect they themselves requested.
   */
  readonly inProgress: boolean
}

/**
 * Ordered shutdown: cut input first, then flush the buffer, then release resources.
 *
 * Order matters. Disconnect does not touch the buffer, so cutting input first is free:
 * the flush that follows still drains what was queued. Flushing first would miss the
 * message that was in flight when the signal arrived — the provider waits for it on
 * disconnect, its persist fails against a closing database, and it lands in the buffer
 * after the last flush attempt, where nobody reads it.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  const timeoutMs = deps.timeoutMs ?? 15_000

  /** Last resort: if the log channel itself is broken, shutdown still continues. */
  function report(failure: string, error: unknown): void {
    try {
      deps.log.error(`shutdown: ${failure}`, { error: describeError(error) })
    } catch {
      // Nowhere to report. Aborting shutdown here costs more than losing the notice.
    }
  }

  /** Isolates a step: none may skip later ones or make shutdown reject. */
  async function step(failure: string, action: () => void | Promise<void>): Promise<boolean> {
    try {
      await action()
      return true
    } catch (error) {
      report(failure, error)
    }
    return false
  }

  /**
   * Returns messages that will be lost: those that survive the last attempt.
   *
   * Retries if anything remains queued. `flushBuffer` coalesces, so the first call may
   * return the result of an in-flight flush that already drained, leaving arrivals in
   * between without an attempt. By the second call `stopRetries` has run and the prior
   * flush finished: it starts without competition.
   */
  async function flush(): Promise<number> {
    let persisted = 0
    try {
      persisted = await deps.pipeline.flushBuffer()
      if (deps.pipeline.bufferSize > 0) persisted += await deps.pipeline.flushBuffer()
    } catch (error) {
      const lost = deps.pipeline.bufferSize
      deps.log.error('shutdown: buffer flush failed', {
        lost,
        error: describeError(error),
      })
      return lost
    }

    deps.log.info('shutdown: buffer flushed', { persisted })

    // `flushBuffer` does not propagate per-message failures: it requeues what did not land.
    const lost = deps.pipeline.bufferSize
    if (lost > 0) {
      deps.log.error('shutdown: dropping messages that could not be persisted', { lost })
    }
    return lost
  }

  async function run(): Promise<number> {
    let lost = 0
    let timedOut = false
    let settleTimeout: (() => void) | null = null
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, timeoutMs)
      settleTimeout = () => {
        clearTimeout(timer)
        resolve()
      }
    })

    const work = (async (): Promise<number> => {
      await step('could not stop buffer retries', () => deps.stopRetries())
      await step('could not close the provider', () => deps.provider.disconnect())
      if (timedOut) return deps.pipeline.bufferSize
      const flushed = await step('buffer flush finished incompletely', async () => {
        lost = await flush()
      })
      // If `flush` never returned, read the count from the buffer. A broken log after the
      // loss already happened would otherwise hide the number that decides the exit code.
      if (!flushed) lost = deps.pipeline.bufferSize
      if (timedOut) return deps.pipeline.bufferSize
      await step('could not close the database', () => deps.closeDb())
      await step('could not announce completion', () => deps.log.info('shutdown complete'))
      return lost
    })()

    const result = await Promise.race([
      work.finally(() => settleTimeout?.()),
      deadline.then(() => {
        if (timedOut) {
          deps.log.error('shutdown: timed out', { lost: deps.pipeline.bufferSize })
          void deps.provider.disconnect().catch(() => {})
          void deps.closeDb().catch(() => {})
          return deps.pipeline.bufferSize
        }
        return work
      }),
    ])

    return result
  }

  let inProgress: Promise<number> | null = null

  return {
    // An impatient Ctrl-C fires two signals: the second waits on the same shutdown.
    shutDown: () => (inProgress ??= run()),
    get inProgress(): boolean {
      return inProgress !== null
    },
  }
}
