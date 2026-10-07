import type { InterpretOutput } from './interpret.ts'

export type ParsedRange = {
  range: NonNullable<InterpretOutput['range']>
  lastNDays: number | null
  lastNHours: number | null
  isoFrom: string | null
  isoTo: string | null
}

const NAMED_RANGES: Record<string, ParsedRange> = {
  today: { range: 'today', lastNDays: null, lastNHours: null, isoFrom: null, isoTo: null },
  yesterday: {
    range: 'yesterday',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
  },
  'this week': {
    range: 'this_week',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
  },
  hoy: { range: 'today', lastNDays: null, lastNHours: null, isoFrom: null, isoTo: null },
  ayer: { range: 'yesterday', lastNDays: null, lastNHours: null, isoFrom: null, isoTo: null },
  'esta semana': {
    range: 'this_week',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
  },
  'last hour': {
    range: 'last_n_hours',
    lastNDays: null,
    lastNHours: 1,
    isoFrom: null,
    isoTo: null,
  },
  'the last hour': {
    range: 'last_n_hours',
    lastNDays: null,
    lastNHours: 1,
    isoFrom: null,
    isoTo: null,
  },
  'ultima hora': {
    range: 'last_n_hours',
    lastNDays: null,
    lastNHours: 1,
    isoFrom: null,
    isoTo: null,
  },
  'última hora': {
    range: 'last_n_hours',
    lastNDays: null,
    lastNHours: 1,
    isoFrom: null,
    isoTo: null,
  },
  'la ultima hora': {
    range: 'last_n_hours',
    lastNDays: null,
    lastNHours: 1,
    isoFrom: null,
    isoTo: null,
  },
  'la última hora': {
    range: 'last_n_hours',
    lastNDays: null,
    lastNHours: 1,
    isoFrom: null,
    isoTo: null,
  },
}

const NAMED_RANGE_PATTERN =
  'today|yesterday|this week|hoy|ayer|esta semana|last hour|the last hour|ultima hora|última hora|la ultima hora|la última hora'

/**
 * Parses a standalone time-range reply (e.g. while clarifying).
 * Does not guess truncated words like "ay".
 */
export function tryParseRangeOnly(text: string): ParsedRange | null {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase()
  if (normalized.length === 0) return null

  const named = NAMED_RANGES[normalized]
  if (named) return { ...named }

  const withDe = normalized.match(new RegExp(`^de\\s+(${NAMED_RANGE_PATTERN})$`, 'i'))
  if (withDe?.[1]) {
    const hit = NAMED_RANGES[withDe[1].toLowerCase()]
    if (hit) return { ...hit }
  }

  const hours = normalized.match(
    /^(?:(?:the|las?)\s+)?(?:last|ultimas?|últimas?)\s+(\d+)\s+hours?$/,
  )
  if (hours?.[1]) {
    return {
      range: 'last_n_hours',
      lastNDays: null,
      lastNHours: Number(hours[1]),
      isoFrom: null,
      isoTo: null,
    }
  }

  const hoursEs = normalized.match(/^(?:las?\s+)?(?:ultimas?|últimas?)\s+(\d+)\s+horas?$/)
  if (hoursEs?.[1]) {
    return {
      range: 'last_n_hours',
      lastNDays: null,
      lastNHours: Number(hoursEs[1]),
      isoFrom: null,
      isoTo: null,
    }
  }

  const days = normalized.match(
    /^(?:(?:the|los?|las?)\s+)?(?:last|ultimos?|últimos?|ultimas?|últimas?)\s+(\d+)\s+days?$/,
  )
  if (days?.[1]) {
    return {
      range: 'last_n_days',
      lastNDays: Number(days[1]),
      lastNHours: null,
      isoFrom: null,
      isoTo: null,
    }
  }

  const daysEs = normalized.match(
    /^(?:los?\s+)?(?:ultimos?|últimos?)\s+(\d+)\s+d[ií]as?$/,
  )
  if (daysEs?.[1]) {
    return {
      range: 'last_n_days',
      lastNDays: Number(daysEs[1]),
      lastNHours: null,
      isoFrom: null,
      isoTo: null,
    }
  }

  return null
}

/**
 * Parses common summarize phrasings without calling the LLM.
 * Range may be null when the chat is clear but the time window is missing —
 * the caller should ask for a range instead of guessing.
 */
export function tryParseSummarizeIntent(text: string): InterpretOutput | null {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) return null

  const rangeTail = `(?:de\\s+)?(${NAMED_RANGE_PATTERN}|(?:(?:the|las?|los?)\\s+)?(?:last|ultimas?|últimas?|ultimos?|últimos?)\\s+\\d+\\s+(?:hours?|horas?|days?|d[ií]as?))`
  const patternsWithRange = [
    new RegExp(
      `^(?:please\\s+)?summarize\\s+(?:my\\s+)?(?:(?:chat|conversation)\\s+with\\s+)?(.+?)\\s+${rangeTail}$`,
      'i',
    ),
    new RegExp(
      `^summary(?:\\s+of)?\\s+(?:my\\s+)?(?:(?:chat|conversation)\\s+with\\s+)?(.+?)\\s+${rangeTail}$`,
      'i',
    ),
    new RegExp(
      `^resum(?:e|é|í|i)\\s+(?:mi\\s+)?(?:(?:chat|conversaci[oó]n)\\s+con\\s+)?(.+?)\\s+${rangeTail}$`,
      'i',
    ),
  ]

  for (const pattern of patternsWithRange) {
    const match = normalized.match(pattern)
    if (!match) continue
    const query = (match[1]?.trim() ?? '').replace(/\s+de$/i, '')
    const rangeText = match[2]?.trim() ?? ''
    const parsedRange = tryParseRangeOnly(rangeText) ?? tryParseRangeOnly(`de ${rangeText}`)
    if (!query || !parsedRange) continue

    return {
      intent: 'summarize',
      conversationQuery: query,
      range: parsedRange.range,
      lastNDays: parsedRange.lastNDays,
      lastNHours: parsedRange.lastNHours,
      isoFrom: parsedRange.isoFrom,
      isoTo: parsedRange.isoTo,
      focus: null,
    }
  }

  const patternsWithoutRange = [
    /^(?:please\s+)?summarize\s+(?:my\s+)?(?:(?:chat|conversation)\s+with\s+)?(.+)$/i,
    /^summary(?:\s+of)?\s+(?:my\s+)?(?:(?:chat|conversation)\s+with\s+)?(.+)$/i,
    /^resum(?:e|é|í|i)\s+(?:mi\s+)?(?:(?:chat|conversaci[oó]n)\s+con\s+)?(.+)$/i,
  ]

  for (const pattern of patternsWithoutRange) {
    const match = normalized.match(pattern)
    if (!match) continue
    let query = match[1]?.trim() ?? ''
    // Strip incomplete range tails only — never guess them (e.g. "de ay").
    query = query
      .replace(/\s+de\s+ay$/i, '')
      .replace(/\s+de\s+ho$/i, '')
      .replace(/\s+de$/i, '')
      .trim()
    if (!query) continue

    return {
      intent: 'summarize',
      conversationQuery: query,
      range: null,
      lastNDays: null,
      lastNHours: null,
      isoFrom: null,
      isoTo: null,
      focus: null,
    }
  }

  return null
}
