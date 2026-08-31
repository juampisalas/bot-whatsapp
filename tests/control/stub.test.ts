import { expect, test } from 'bun:test'
import { BOT_PREFIX } from '../../src/control/classify.ts'
import { replyFor } from '../../src/control/stub.ts'

test('help explains current capabilities', () => {
  expect(replyFor('help')).toBe(
    `${BOT_PREFIX}I can reply here. Summaries are not ready yet.`,
  )
  expect(replyFor('HELP')).toBe(
    `${BOT_PREFIX}I can reply here. Summaries are not ready yet.`,
  )
})

test('anything else says summaries are not ready', () => {
  expect(replyFor('summarize the group')).toStartWith(BOT_PREFIX)
  expect(replyFor('summarize the group')).toContain('I cannot summarize yet')
  expect(replyFor('summarize the group')).toBe(
    `${BOT_PREFIX}I cannot summarize yet. Type help to see what I can do.`,
  )
})
