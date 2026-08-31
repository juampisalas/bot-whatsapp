import { expect, test } from 'bun:test'
import { splitIntoDayBuckets } from '../../src/agent/buckets.ts'

const TZ = 'America/Argentina/Buenos_Aires'

test('range crossing midnight in Buenos Aires yields two buckets', () => {
  // 2026-08-29 23:00 ART → 2026-08-30 03:00 ART
  const from = new Date('2026-08-30T02:00:00.000Z')
  const to = new Date('2026-08-30T06:00:00.000Z')

  const buckets = splitIntoDayBuckets(from, to, TZ)

  expect(buckets).toHaveLength(2)
  expect(buckets[0]?.day).toBe('2026-08-29')
  expect(buckets[0]?.from).toEqual(from)
  expect(buckets[0]?.to).toEqual(new Date('2026-08-30T03:00:00.000Z'))
  expect(buckets[1]?.day).toBe('2026-08-30')
  expect(buckets[1]?.from).toEqual(new Date('2026-08-30T03:00:00.000Z'))
  expect(buckets[1]?.to).toEqual(to)
})

test('UTC midnight-crossing range that is one day in Buenos Aires yields one bucket', () => {
  // Both instants are 2026-08-30 in UTC, but 2026-08-29 in ART.
  const from = new Date('2026-08-30T01:00:00.000Z')
  const to = new Date('2026-08-30T02:00:00.000Z')

  const buckets = splitIntoDayBuckets(from, to, TZ)

  expect(buckets).toHaveLength(1)
  expect(buckets[0]?.day).toBe('2026-08-29')
  expect(buckets[0]?.from).toEqual(from)
  expect(buckets[0]?.to).toEqual(to)
})

test('empty or inverted range yields no buckets', () => {
  const instant = new Date('2026-08-30T12:00:00.000Z')
  expect(splitIntoDayBuckets(instant, instant, TZ)).toEqual([])
  expect(splitIntoDayBuckets(instant, new Date('2026-08-30T11:00:00.000Z'), TZ)).toEqual([])
})
