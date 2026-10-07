import { expect, test } from 'bun:test'
import { matchControlCommand } from '../../src/control/commands.ts'

test('matchControlCommand recognizes help', () => {
  expect(matchControlCommand('help')).toBe('help')
  expect(matchControlCommand(' HELP ')).toBe('help')
})

test('matchControlCommand recognizes refresh name commands in English', () => {
  expect(matchControlCommand('refresh names')).toBe('refresh_names')
  expect(matchControlCommand('refresh')).toBe('refresh_names')
  expect(matchControlCommand('update chat names')).toBe('refresh_names')
  expect(matchControlCommand('sync contacts')).toBe('refresh_names')
})

test('matchControlCommand recognizes refresh name commands in Spanish', () => {
  expect(matchControlCommand('actualizar nombres')).toBe('refresh_names')
  expect(matchControlCommand('actualizar los nombres de mis chats')).toBe('refresh_names')
})

test('matchControlCommand ignores summary requests', () => {
  expect(matchControlCommand('summarize la facu today')).toBeNull()
})
