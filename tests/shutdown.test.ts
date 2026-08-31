import { expect, test } from 'bun:test'
import type { Logger } from '../src/domain/logger.ts'
import { createShutdown } from '../src/shutdown.ts'

interface EnvironmentOptions {
  /** How many messages are queued when the signal arrives. */
  pending?: number
  /** How many of those the database rejects on every attempt; default none. */
  unrecoverable?: number
  /**
   * How many enter the buffer while the first flush runs. Emulates `flushBuffer`
   * coalescing: the number shutdown receives comes from a flush that already drained,
   * so these stay queued without having had their attempt.
   */
  late?: number
  /**
   * How many enter the buffer during disconnect. Emulates the message that was in
   * flight when the signal arrived: the provider waits for it before releasing the
   * socket and that attempt fails against a database that no longer responds, so it
   * ends up queued.
   */
  inFlight?: number
  flushError?: Error
  disconnectError?: Error
  closeDbError?: Error
  /** Breaks the flush notice, which runs after the loss is already measured. */
  logError?: Error
  /** Hard deadline passed to `createShutdown`. */
  timeoutMs?: number
  /** If true, `flushBuffer` never resolves (hangs until the timeout wins). */
  hangFlush?: boolean
}

interface Line {
  message: string
  meta?: Record<string, unknown>
}

function createEnvironment(options: EnvironmentOptions = {}) {
  const order: string[] = []
  const infos: Line[] = []
  const errors: Line[] = []
  const log: Logger = {
    info: (message, meta) => {
      infos.push({ message, meta })
      if (options.logError && message === 'shutdown: buffer flushed') throw options.logError
    },
    warn: () => {},
    error: (message, meta) => errors.push({ message, meta }),
  }

  // The buffer keeps a live count instead of returning a fixed value: flush lowers it by
  // what it claims to have persisted, so the expected `lost` only appear if shutdown
  // measures them after the last attempt and not before.
  let pending = options.pending ?? 0
  let late = options.late ?? 0

  const shutdown = createShutdown({
    pipeline: {
      flushBuffer: async () => {
        order.push('flush')
        if (options.hangFlush) return new Promise(() => {})
        if (options.flushError) throw options.flushError
        const persisted = Math.max(0, pending - (options.unrecoverable ?? 0))
        pending -= persisted
        pending += late
        late = 0
        return persisted
      },
      get bufferSize() {
        return pending
      },
    },
    provider: {
      disconnect: async () => {
        order.push('disconnect')
        pending += options.inFlight ?? 0
        if (options.disconnectError) throw options.disconnectError
      },
    },
    closeDb: async () => {
      order.push('closeDb')
      if (options.closeDbError) throw options.closeDbError
    },
    stopRetries: () => order.push('stopRetries'),
    log,
    timeoutMs: options.timeoutMs,
  })

  return {
    shutdown,
    order,
    infos,
    errors,
    get pending(): number {
      return pending
    },
  }
}

test('disconnects before flushing the buffer and closes the database last', async () => {
  const environment = createEnvironment({ pending: 3 })

  expect(await environment.shutdown.shutDown()).toBe(0)

  expect(environment.order).toEqual(['stopRetries', 'disconnect', 'flush', 'closeDb'])
  expect(environment.infos.find((line) => line.meta?.persisted !== undefined)?.meta?.persisted)
    .toBe(3)
  expect(environment.errors).toHaveLength(0)
})

test('persists the message that was in flight when the signal arrived', async () => {
  const environment = createEnvironment({ inFlight: 1 })

  // Flushing before disconnect leaves this message queued after the last attempt:
  // shutdown would return zero lost and nobody would read that buffer again.
  expect(await environment.shutdown.shutDown()).toBe(0)

  expect(environment.pending).toBe(0)
  expect(environment.infos.find((line) => line.meta?.persisted !== undefined)?.meta?.persisted)
    .toBe(1)
})

test('reports how many messages are lost if the buffer does not fully drain', async () => {
  const environment = createEnvironment({ pending: 5, unrecoverable: 4 })

  expect(await environment.shutdown.shutDown()).toBe(4)

  expect(environment.errors).toHaveLength(1)
  expect(environment.errors[0]?.meta?.lost).toBe(4)
  expect(environment.order).toContain('closeDb')
})

test('retries the flush for what entered the buffer during the previous one', async () => {
  const environment = createEnvironment({ pending: 2, late: 1 })

  expect(await environment.shutdown.shutDown()).toBe(0)

  expect(environment.order).toEqual([
    'stopRetries',
    'disconnect',
    'flush',
    'flush',
    'closeDb',
  ])
  expect(
    environment.infos.find((line) => line.meta?.persisted !== undefined)?.meta?.persisted,
  ).toBe(3)
  expect(environment.errors).toHaveLength(0)
})

test('reports how many messages are lost if the flush fails', async () => {
  const environment = createEnvironment({ pending: 2, flushError: new Error('database down') })

  expect(await environment.shutdown.shutDown()).toBe(2)

  expect(environment.errors).toHaveLength(1)
  expect(environment.errors[0]?.meta?.lost).toBe(2)
  expect(environment.errors[0]?.meta?.error).toBe('database down')
  expect(environment.order).toEqual(['stopRetries', 'disconnect', 'flush', 'closeDb'])
})

test('two consecutive signals shut down only once', async () => {
  const environment = createEnvironment()

  await Promise.all([environment.shutdown.shutDown(), environment.shutdown.shutDown()])
  await environment.shutdown.shutDown()

  expect(environment.order.filter((step) => step === 'flush')).toHaveLength(1)
  expect(environment.order.filter((step) => step === 'disconnect')).toHaveLength(1)
  expect(environment.order.filter((step) => step === 'closeDb')).toHaveLength(1)
})

test('inProgress stays true from the moment shutdown starts', async () => {
  const environment = createEnvironment()

  expect(environment.shutdown.inProgress).toBe(false)
  const shuttingDown = environment.shutdown.shutDown()
  expect(environment.shutdown.inProgress).toBe(true)

  await shuttingDown

  // Still true after finishing: a late rejection is also a consequence of it.
  expect(environment.shutdown.inProgress).toBe(true)
})

test('closes the database even if provider disconnect fails', async () => {
  const environment = createEnvironment({ disconnectError: new Error('socket hung') })

  await environment.shutdown.shutDown()

  expect(environment.order).toContain('closeDb')
  expect(environment.errors.some((line) => line.meta?.error === 'socket hung')).toBe(true)
})

test('finishes shutdown even if closing the database fails', async () => {
  const environment = createEnvironment({ closeDbError: new Error('pool busy') })

  await environment.shutdown.shutDown()

  expect(environment.errors.some((line) => line.meta?.error === 'pool busy')).toBe(true)
  expect(environment.infos.some((line) => line.message === 'shutdown complete')).toBe(true)
})

test('a broken notice is not reported as loss and does not interrupt shutdown', async () => {
  const environment = createEnvironment({
    pending: 5,
    unrecoverable: 4,
    logError: new Error('stdout closed'),
  })

  // The notice breaks between measuring the loss and returning it: if shutdown threw
  // there, it would exit with zero after dropping four messages.
  expect(await environment.shutdown.shutDown()).toBe(4)

  expect(environment.errors.some((line) => line.message.includes('buffer flush failed'))).toBe(
    false,
  )
  expect(environment.errors.some((line) => line.meta?.error === 'stdout closed')).toBe(true)
  expect(environment.order).toEqual([
    'stopRetries',
    'disconnect',
    'flush',
    'flush',
    'closeDb',
  ])
})

test('a circular cause does not erase the lost message count', async () => {
  // `describeError` walks the cause chain to build the log line: if it overflows the
  // stack, the failure takes with it the number that decides the exit code.
  const top = new Error('database down')
  top.cause = new Error('socket broken', { cause: top })
  const environment = createEnvironment({ pending: 4, flushError: top })

  expect(await environment.shutdown.shutDown()).toBe(4)

  expect(environment.order).toContain('closeDb')
})

test('a hung flush still exits when the timeout wins', async () => {
  const environment = createEnvironment({ pending: 3, hangFlush: true, timeoutMs: 50 })

  expect(await environment.shutdown.shutDown()).toBe(3)

  expect(environment.errors.some((line) => line.message === 'shutdown: timed out')).toBe(true)
  expect(environment.errors.find((line) => line.message === 'shutdown: timed out')?.meta?.lost)
    .toBe(3)
})
