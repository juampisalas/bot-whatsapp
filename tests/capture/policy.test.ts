import { expect, test } from 'bun:test'
import { shouldCapture } from '../../src/capture/policy.ts'

test('modo all captura cualquier conversación', () => {
  expect(shouldCapture({ mode: 'all', rules: new Set() }, 'c1')).toBe(true)
  expect(shouldCapture({ mode: 'all', rules: new Set(['c9']) }, 'c1')).toBe(true)
})

test('modo whitelist captura solo lo listado', () => {
  const policy = { mode: 'whitelist' as const, rules: new Set(['c1']) }

  expect(shouldCapture(policy, 'c1')).toBe(true)
  expect(shouldCapture(policy, 'c2')).toBe(false)
})

test('modo blacklist captura todo menos lo listado', () => {
  const policy = { mode: 'blacklist' as const, rules: new Set(['c1']) }

  expect(shouldCapture(policy, 'c1')).toBe(false)
  expect(shouldCapture(policy, 'c2')).toBe(true)
})

test('whitelist vacía no captura nada', () => {
  expect(shouldCapture({ mode: 'whitelist', rules: new Set() }, 'c1')).toBe(false)
})
