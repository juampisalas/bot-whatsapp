import { expect, test } from 'bun:test'
import {
  formatContactSearchResults,
  parseSearchContactCommand,
} from '../../src/control/search-contact.ts'

test('parseSearchContactCommand accepts Spanish and English variants', () => {
  expect(parseSearchContactCommand('buscar contacto Gusma')).toBe('Gusma')
  expect(parseSearchContactCommand('search contact Gusma')).toBe('Gusma')
  expect(parseSearchContactCommand('buscar Gusma en contactos')).toBe('Gusma')
})

test('formatContactSearchResults lists numbered options for partial matches', () => {
  const text = formatContactSearchResults('Gus', [
    {
      id: '1',
      externalId: '5491125337329@s.whatsapp.net',
      kind: 'dm',
      name: 'Gusma',
      addressBookName: 'Gusma',
      pushName: null,
      lastMessageAt: null,
      messageCount: 13,
      matchType: 'fuzzy',
    },
    {
      id: '2',
      externalId: '5491100000000@s.whatsapp.net',
      kind: 'dm',
      name: 'Gustavo',
      addressBookName: 'Gustavo',
      pushName: 'Gus',
      lastMessageAt: null,
      messageCount: 0,
      matchType: 'fuzzy',
    },
  ])

  expect(text).toContain('Did you mean')
  expect(text).toContain('1. Gusma')
  expect(text).toContain('2. Gustavo')
})

test('formatContactSearchResults confirms a single exact match', () => {
  const text = formatContactSearchResults('Gusma', [
    {
      id: '1',
      externalId: '5491125337329@s.whatsapp.net',
      kind: 'dm',
      name: 'Gusma',
      addressBookName: 'Gusma',
      pushName: null,
      lastMessageAt: null,
      messageCount: 13,
      matchType: 'exact',
    },
  ])

  expect(text).toContain('Found contact "Gusma"')
})
