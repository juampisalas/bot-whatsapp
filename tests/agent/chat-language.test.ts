import { expect, test } from 'bun:test'
import { inferChatLanguagePrior } from '../../src/agent/media/chat-language.ts'

test('detects Spanish from mixed chat text', () => {
  const prior = inferChatLanguagePrior([
    'Hola che, cómo estás? Mañana nos vemos en el partido.',
    'Dale, gracias por avisar. Estoy en el trabajo ahora.',
  ])
  expect(prior).toBe('es')
})

test('detects English from mixed chat text', () => {
  const prior = inferChatLanguagePrior([
    'Hello, thanks for the update about tomorrow.',
    'I would be there around noon if that works for you.',
  ])
  expect(prior).toBe('en')
})

test('returns null when there is too little text', () => {
  expect(inferChatLanguagePrior(['ok', 'si'])).toBeNull()
})
