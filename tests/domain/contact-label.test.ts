import { expect, test } from 'bun:test'
import { canonicalContactLabel, formatPhoneFromJid } from '../../src/domain/contact-label.ts'

test('formatPhoneFromJid formats WhatsApp phone JIDs', () => {
  expect(formatPhoneFromJid('5491149800824@s.whatsapp.net')).toBe('+5491149800824')
  expect(formatPhoneFromJid('28106349916326@lid')).toBeNull()
})

test('canonicalContactLabel prefers address book over phone and push name', () => {
  expect(
    canonicalContactLabel({
      kind: 'dm',
      externalId: '5491149800824@s.whatsapp.net',
      addressBookName: 'Mariano Mangialavori',
      pushName: 'Marian',
    }),
  ).toBe('Mariano Mangialavori')
})

test('canonicalContactLabel falls back to phone then push name', () => {
  expect(
    canonicalContactLabel({
      kind: 'dm',
      externalId: '5491149800824@s.whatsapp.net',
      pushName: 'Marian',
    }),
  ).toBe('+5491149800824')

  expect(
    canonicalContactLabel({
      kind: 'dm',
      externalId: '28106349916326@lid',
      pushName: 'Marian',
    }),
  ).toBe('Marian')
})
