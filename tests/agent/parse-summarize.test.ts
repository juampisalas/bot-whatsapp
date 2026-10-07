import { expect, test } from 'bun:test'
import { tryParseRangeOnly, tryParseSummarizeIntent } from '../../src/agent/parse-summarize.ts'

test('parses English summarize my chat with X today', () => {
  expect(tryParseSummarizeIntent('Summarize my chat with Mariano Mangialavori today')).toEqual({
    intent: 'summarize',
    conversationQuery: 'Mariano Mangialavori',
    range: 'today',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
  })
})

test('parses short English summarize X today', () => {
  expect(tryParseSummarizeIntent('summarize la facu today')).toEqual({
    intent: 'summarize',
    conversationQuery: 'la facu',
    range: 'today',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
  })
})

test('parses Spanish resumi without accent', () => {
  expect(tryParseSummarizeIntent('resumi mi chat con Mariano Mangialavori hoy')).toEqual({
    intent: 'summarize',
    conversationQuery: 'Mariano Mangialavori',
    range: 'today',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
  })
})

test('parses Spanish resume mi chat con X hoy', () => {
  expect(tryParseSummarizeIntent('Resumí mi chat con Mariano Mangialavori hoy')).toEqual({
    intent: 'summarize',
    conversationQuery: 'Mariano Mangialavori',
    range: 'today',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
  })
})

test('parses Spanish de ayer without leaving de in the query', () => {
  expect(tryParseSummarizeIntent('Resumí mi chat con Mariano Mangialavori de ayer')).toEqual({
    intent: 'summarize',
    conversationQuery: 'Mariano Mangialavori',
    range: 'yesterday',
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
  })
})

test('incomplete de ay asks later by leaving range null', () => {
  expect(tryParseSummarizeIntent('Resumí mi chat con Mariano Mangialavori de ay')).toEqual({
    intent: 'summarize',
    conversationQuery: 'Mariano Mangialavori',
    range: null,
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
  })
})

test('parses last hour and last N hours', () => {
  expect(tryParseSummarizeIntent('Resumí mi chat con Mariano la última hora')).toMatchObject({
    conversationQuery: 'Mariano',
    range: 'last_n_hours',
    lastNHours: 1,
  })
  expect(tryParseSummarizeIntent('summarize la facu last 2 hours')).toMatchObject({
    conversationQuery: 'la facu',
    range: 'last_n_hours',
    lastNHours: 2,
  })
})

test('parses standalone range replies', () => {
  expect(tryParseRangeOnly('últimas 2 horas')).toEqual({
    range: 'last_n_hours',
    lastNDays: null,
    lastNHours: 2,
    isoFrom: null,
    isoTo: null,
  })
  expect(tryParseRangeOnly('ayer')).toMatchObject({ range: 'yesterday' })
  expect(tryParseRangeOnly('ay')).toBeNull()
})

test('returns null for free-form text', () => {
  expect(tryParseSummarizeIntent('what did Mariano say about dinner')).toBeNull()
})
