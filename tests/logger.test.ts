import { expect, test } from 'bun:test'
import { describeError } from '../src/domain/logger.ts'
import { createLogger } from '../src/logger.ts'

function captureLines(write: () => void): string[] {
  const lines: string[] = []
  const original = console.log
  console.log = (line: string) => lines.push(line)
  try {
    write()
  } finally {
    console.log = original
  }
  return lines
}

test('filters by level', () => {
  const lines = captureLines(() => {
    const log = createLogger('warn')
    log.info('this is hidden')
    log.warn('this shows')
  })

  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('this shows')
})

test('error is emitted at the highest level', () => {
  const lines = captureLines(() => {
    const log = createLogger('error')
    log.warn('this is hidden')
    log.error('it crashed')
  })

  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('ERROR')
  expect(lines[0]).toContain('it crashed')
})

test('includes metadata as JSON', () => {
  const lines = captureLines(() => {
    createLogger('info').info('hello', { a: 1 })
  })

  expect(lines[0]).toContain('{"a":1}')
})

test('omits metadata when there is none', () => {
  const lines = captureLines(() => {
    createLogger('info').info('no metadata')
  })

  expect(lines[0]).toEndWith('no metadata')
})

test('describeError chains the cause that the outer error does not name', () => {
  const cause = new Error('conexión rechazada')
  const wrapper = new Error('Failed query: select 1', { cause })

  expect(describeError(wrapper)).toBe('Failed query: select 1: conexión rechazada')
})

test('describeError names a message-less cause by its code', () => {
  // Node network errors arrive with an empty `message`: without the code nothing useful remains.
  const cause = Object.assign(new Error(''), { code: 'ECONNREFUSED' })

  expect(describeError(new Error('Failed query', { cause }))).toBe(
    'Failed query: ECONNREFUSED',
  )
})

test('describeError does not break on a non-Error value', () => {
  expect(describeError('se cayó todo')).toBe('se cayó todo')
})

test('describeError cuts a cause chain that closes in a cycle', () => {
  const top = new Error('Failed query')
  top.cause = new Error('conexión rechazada', { cause: top })

  expect(describeError(top)).toBe('Failed query: conexión rechazada')
})

test('describeError cuts an error that names itself as its own cause', () => {
  const alone = new Error('se muerde la cola')
  alone.cause = alone

  expect(describeError(alone)).toBe('se muerde la cola')
})
