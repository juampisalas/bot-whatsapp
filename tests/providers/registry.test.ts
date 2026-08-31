import { expect, test } from 'bun:test'
import { loadConfig } from '../../src/config/index.ts'
import { createProvider } from '../../src/providers/registry.ts'

const config = loadConfig({
  DATABASE_URL: 'postgres://bot:bot@localhost:5433/botwhatsapp',
})

test('devuelve el adaptador falso', () => {
  expect(createProvider('fake', config).id).toBe('fake')
})

test('devuelve el adaptador de WhatsApp sin conectar', () => {
  expect(createProvider('whatsapp', config).id).toBe('whatsapp')
})

test('rechaza un proveedor no implementado', () => {
  expect(() => createProvider('telegram', config)).toThrow(/no implementado/)
})
