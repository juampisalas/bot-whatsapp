export type DayBucket = {
  /** Calendar day in the given timezone, `YYYY-MM-DD`. */
  day: string
  from: Date
  to: Date
}

/**
 * Splits `[from, to)` into calendar-day buckets in `timezone`.
 * Day boundaries follow the preferences timezone, not UTC.
 */
export function splitIntoDayBuckets(from: Date, to: Date, timezone: string): DayBucket[] {
  if (!(from.getTime() < to.getTime())) return []

  const zonedFrom = Temporal.Instant.fromEpochMilliseconds(from.getTime()).toZonedDateTimeISO(
    timezone,
  )
  let dayStart = zonedFrom.startOfDay()
  const endMs = to.getTime()
  const buckets: DayBucket[] = []

  while (dayStart.epochMilliseconds < endMs) {
    const dayEnd = dayStart.add({ days: 1 })
    const bucketFromMs = Math.max(from.getTime(), dayStart.epochMilliseconds)
    const bucketToMs = Math.min(endMs, dayEnd.epochMilliseconds)

    if (bucketFromMs < bucketToMs) {
      buckets.push({
        day: dayStart.toPlainDate().toString(),
        from: new Date(bucketFromMs),
        to: new Date(bucketToMs),
      })
    }

    dayStart = dayEnd
  }

  return buckets
}
