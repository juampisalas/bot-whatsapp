import { expect, test } from 'bun:test'
import { resolvePreferences } from '../../src/agent/preferences.ts'

test('chat overrides global, global overrides default', () => {
  const resolved = resolvePreferences(
    { language: 'en', length: null, format: null, tone: null, timezone: null },
    {
      language: null,
      length: 'short',
      format: null,
      tone: null,
      timezone: null,
      focus: 'plazos',
      ignoreKinds: ['sticker'],
      alias: 'la facu',
    },
  )
  expect(resolved.language).toBe('en')
  expect(resolved.length).toBe('short')
  expect(resolved.format).toBe('bullets')
  expect(resolved.focus).toBe('plazos')
  expect(resolved.alias).toBe('la facu')
})
