import { expect, test } from 'bun:test'
import { pickTranscriptionLanguage } from '../../src/agent/media/language-policy.ts'

const THRESHOLD = 0.8

test('high-confidence detection overrides chat prior', () => {
  expect(
    pickTranscriptionLanguage('es', { language: 'en', confidence: 0.91 }, THRESHOLD),
  ).toBe('en')
})

test('low-confidence detection falls back to chat prior', () => {
  expect(
    pickTranscriptionLanguage('es', { language: 'en', confidence: 0.55 }, THRESHOLD),
  ).toBe('es')
})

test('null prior uses detected language', () => {
  expect(
    pickTranscriptionLanguage(null, { language: 'en', confidence: 0.4 }, THRESHOLD),
  ).toBe('en')
})

test('missing detection returns undefined for whisper auto-select', () => {
  expect(pickTranscriptionLanguage(null, { language: '', confidence: 0 }, THRESHOLD)).toBeUndefined()
})
