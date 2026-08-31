// tests/config.test.ts
import { test, expect } from 'bun:test'
import { loadConfig } from '../src/config/index.ts'

const base = { DATABASE_URL: 'postgres://bot:bot@localhost:5433/botwhatsapp' }

test('aplica los valores por defecto', () => {
  const config = loadConfig(base)
  expect(config.PROVIDER).toBe('whatsapp')
  expect(config.CAPTURE_BUFFER_MAX).toBe(1000)
  expect(config.TIMEZONE).toBe('America/Argentina/Buenos_Aires')
})

test('convierte CAPTURE_BUFFER_MAX a número', () => {
  const config = loadConfig({ ...base, CAPTURE_BUFFER_MAX: '25' })
  expect(config.CAPTURE_BUFFER_MAX).toBe(25)
})

test('falla con mensaje explícito si falta DATABASE_URL', () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
})

test('rechaza un proveedor desconocido', () => {
  expect(() => loadConfig({ ...base, PROVIDER: 'telegram' })).toThrow(/PROVIDER/)
})

test('usa info como nivel de log por defecto', () => {
  expect(loadConfig(base).LOG_LEVEL).toBe('info')
})

// El nivel solo existe si el Logger lo emite: aceptar 'debug' prometía un detalle que nadie escribe.
test('rechaza el nivel de log debug', () => {
  expect(() => loadConfig({ ...base, LOG_LEVEL: 'debug' })).toThrow(/LOG_LEVEL/)
})
