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

test('fails with an explicit message if DATABASE_URL is missing', () => {
  expect(() => loadConfig({})).toThrow(/Invalid environment configuration/)
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
})

test('rejects an unknown provider', () => {
  expect(() => loadConfig({ ...base, PROVIDER: 'telegram' })).toThrow(
    /Invalid environment configuration/,
  )
  expect(() => loadConfig({ ...base, PROVIDER: 'telegram' })).toThrow(/PROVIDER/)
})

test('usa info como nivel de log por defecto', () => {
  expect(loadConfig(base).LOG_LEVEL).toBe('info')
})

test('applies SHUTDOWN_TIMEOUT_MS by default', () => {
  expect(loadConfig(base).SHUTDOWN_TIMEOUT_MS).toBe(15_000)
})

test('coerces SHUTDOWN_TIMEOUT_MS to a number', () => {
  expect(loadConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '8' }).SHUTDOWN_TIMEOUT_MS).toBe(8)
})

// El nivel solo existe si el Logger lo emite: aceptar 'debug' promete un detalle que nadie escribe.
test('rechaza el nivel de log debug', () => {
  expect(() => loadConfig({ ...base, LOG_LEVEL: 'debug' })).toThrow(/LOG_LEVEL/)
})

test('LLM defaults to ollama / qwen3.6:35b-a3b', () => {
  const config = loadConfig(base)
  expect(config.LLM_PROVIDER).toBe('ollama')
  expect(config.LLM_MODEL).toBe('qwen3.6:35b-a3b')
  expect(config.LLM_BASE_URL).toBe('http://127.0.0.1:11434')
  expect(config.EMBEDDING_MODEL).toBe('embeddinggemma:300m')
})

test('rejects an unknown LLM_PROVIDER', () => {
  expect(() => loadConfig({ ...base, LLM_PROVIDER: 'gemini' })).toThrow(/LLM_PROVIDER/)
})

test('strips non-digits from WHATSAPP_PHONE_NUMBER', () => {
  const config = loadConfig({ ...base, WHATSAPP_PHONE_NUMBER: '+54 9 11 1234-5678' })
  expect(config.WHATSAPP_PHONE_NUMBER).toBe('5491112345678')
})

test('WHISPER defaults to enabled medium model', () => {
  const config = loadConfig(base)
  expect(config.WHISPER_ENABLED).toBe(true)
  expect(config.WHISPER_MODEL).toBe('medium')
  expect(config.WHISPER_LANGUAGE_CONFIDENCE).toBe(0.8)
  expect(config.FFMPEG_PATH).toBe('ffmpeg')
  expect(config.WHISPER_PYTHON).toBe('python3')
})

test('WHISPER_ENABLED=false disables whisper runner', () => {
  expect(loadConfig({ ...base, WHISPER_ENABLED: 'false' }).WHISPER_ENABLED).toBe(false)
})
