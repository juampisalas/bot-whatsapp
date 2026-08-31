import { expect, test } from 'bun:test'
import { parseCommand } from '../src/cli.ts'

test('sin subcomando corre la captura', () => {
  expect(parseCommand([])).toBe('run')
})

test('reconoce el listado de conversaciones', () => {
  expect(parseCommand(['list-conversations'])).toBe('list-conversations')
})

// Un dedazo no puede caer en el camino por defecto: arrancaría la captura en lugar de listar.
test('rechaza un subcomando desconocido y nombra los válidos', () => {
  expect(() => parseCommand(['lst-conversations'])).toThrow(/lst-conversations/)
  expect(() => parseCommand(['lst-conversations'])).toThrow(/run/)
  expect(() => parseCommand(['lst-conversations'])).toThrow(/list-conversations/)
})
