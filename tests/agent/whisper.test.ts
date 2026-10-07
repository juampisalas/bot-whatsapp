import { expect, test } from 'bun:test'
import { loadConfig } from '../../src/config/index.ts'
import { silentLogger } from '../../src/domain/logger.ts'
import { createWhisperRunner, transcribeWithWhisper } from '../../src/agent/media/whisper.ts'

const base = {
  DATABASE_URL: 'postgres://bot:bot@localhost:5433/botwhatsapp',
  WHISPER_ENABLED: 'true',
  WHISPER_MODEL: 'medium',
}

test('transcribeWithWhisper converts and runs process in one whisper call', async () => {
  const config = loadConfig(base)
  const calls: string[] = []
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args].join(' '))
    if (command === 'ffmpeg') return ''
    if (args.includes('process')) {
      return JSON.stringify({ text: 'hello there', language: 'es', confidence: 0.55 })
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const runner = createWhisperRunner(config, silentLogger, { run })!
  const text = await transcribeWithWhisper(
    runner,
    config,
    silentLogger,
    '/tmp/voice.ogg',
    { preferredLanguage: 'es' },
    {
      run,
      convert: async () => ({
        wavPath: '/tmp/converted.wav',
        cleanup: async () => undefined,
      }),
    },
  )

  expect(text).toBe('hello there')
  expect(calls.some((call) => call.includes('process') && call.includes('--preferred-language es'))).toBe(
    true,
  )
})

test('createWhisperRunner returns null when disabled', () => {
  const config = loadConfig({ ...base, WHISPER_ENABLED: 'false' })
  expect(createWhisperRunner(config, silentLogger)).toBeNull()
})
