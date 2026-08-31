import { expect, test } from 'bun:test'
import { parseCommand } from '../src/cli.ts'

test('sin subcomando corre la captura', () => {
  expect(parseCommand([])).toBe('run')
})

test('reconoce el listado de conversaciones', () => {
  expect(parseCommand(['list-conversations'])).toBe('list-conversations')
})

// A typo must not fall through to the default path: that would start capture instead of listing.
test('rejects an unknown subcommand and names the valid ones', () => {
  expect(() => parseCommand(['lst-conversations'])).toThrow(/Unknown subcommand/)
  expect(() => parseCommand(['lst-conversations'])).toThrow(/lst-conversations/)
  expect(() => parseCommand(['lst-conversations'])).toThrow(/run/)
  expect(() => parseCommand(['lst-conversations'])).toThrow(/list-conversations/)
})
