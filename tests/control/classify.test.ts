import { expect, test } from 'bun:test'
import { BOT_PREFIX, classifyControlMessage } from '../../src/control/classify.ts'
import { mensaje } from '../helpers/fixtures.ts'

const control = { provider: 'fake' as const, conversationId: 'ctrl' }

test('own message in control, no prefix, unknown id, is request', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: 'help',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('request')
})

test('ignores messages outside the control conversation', () => {
  expect(
    classifyControlMessage({
      message: mensaje({ fromSelf: true, text: 'help' }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})

test('ignores messages that are not from self', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: false,
        text: 'help',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})

test('ignores an id already recorded as sent by the bot', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: 'help',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: true,
    }),
  ).toBe('ignore')
})

test('ignores the bot prefix even when the id is not recorded', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: `${BOT_PREFIX}done`,
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})

test('ignores the diamond mark alone without a trailing space', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: '✦done',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})

test('ignores empty or whitespace-only text', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: '   ',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})
