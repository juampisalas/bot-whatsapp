import { expect, test } from 'bun:test'
import {
  chatLabelFromBaileys,
  contactMetaFromBaileys,
  contactMetaFromChat,
  contactMetaFromLidMapping,
} from '../../../src/providers/whatsapp/contact-meta.ts'

test('chatLabelFromBaileys prefers displayName then chat name', () => {
  expect(
    chatLabelFromBaileys({
      id: '5491125337329@s.whatsapp.net',
      displayName: 'Gusma',
      name: 'Other',
    }),
  ).toBe('Gusma')
  expect(
    chatLabelFromBaileys({
      id: '5491125337329@s.whatsapp.net',
      name: 'Gusma',
    }),
  ).toBe('Gusma')
})

test('contactMetaFromChat maps saved chat labels to address-book names', () => {
  expect(
    contactMetaFromChat({
      id: '5491125337329@s.whatsapp.net',
      name: 'Gusma',
      lidJid: '278679036923957@lid',
    }),
  ).toEqual({
    externalIds: ['5491125337329@s.whatsapp.net', '278679036923957@lid'],
    addressBookName: 'Gusma',
    pushName: null,
  })
})

test('contactMetaFromBaileys prefers saved address-book name over push name', () => {
  expect(
    contactMetaFromBaileys({
      id: '5491149800824@s.whatsapp.net',
      lid: '28106349916326@lid',
      name: 'Mariano Mangialavori',
      notify: 'Marian',
    }),
  ).toEqual({
    externalIds: ['5491149800824@s.whatsapp.net', '28106349916326@lid'],
    addressBookName: 'Mariano Mangialavori',
    pushName: 'Marian',
  })
})

test('contactMetaFromLidMapping carries both jids without names', () => {
  expect(
    contactMetaFromLidMapping({
      pn: '5491149800824@s.whatsapp.net',
      lid: '28106349916326@lid',
    }),
  ).toEqual({
    externalIds: ['5491149800824@s.whatsapp.net', '28106349916326@lid'],
    addressBookName: null,
    pushName: null,
  })
})
