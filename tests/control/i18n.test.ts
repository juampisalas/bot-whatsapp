import { expect, test } from 'bun:test'
import {
  helpReply,
  languagePrompt,
  parseLanguageChoice,
  parseLanguageCommand,
  rangeHelp,
} from '../../src/control/i18n.ts'

test('parses a language choice and an explicit change', () => {
  expect(parseLanguageChoice('1')).toBe('es')
  expect(parseLanguageChoice('español')).toBe('es')
  expect(parseLanguageChoice('2')).toBe('en')
  expect(parseLanguageChoice('english')).toBe('en')
  expect(parseLanguageChoice('resumí Tom hoy')).toBeNull()

  expect(parseLanguageCommand('idioma')).toBe('ask')
  expect(parseLanguageCommand('idioma inglés')).toBe('en')
  expect(parseLanguageCommand('language spanish')).toBe('es')
  expect(parseLanguageCommand('en español')).toBe('es')
})

test('spanish replies differ from the english ones', () => {
  expect(rangeHelp('es')).toContain('¿Qué período uso?')
  expect(rangeHelp('en')).toContain('What time range')
  expect(helpReply('es')).toContain('resumí Gusma hoy')
  expect(languagePrompt()).toContain('¿Qué idioma preferís?')
})
