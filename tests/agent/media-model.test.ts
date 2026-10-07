import { expect, test } from 'bun:test'
import { createMediaModel } from '../../src/agent/media/model.ts'
import { loadConfig } from '../../src/config/index.ts'
import { silentLogger } from '../../src/domain/logger.ts'

const base = { DATABASE_URL: 'postgres://bot:bot@localhost:5433/botwhatsapp' }

test('createMediaModel transcribe logs and rejects without Whisper', async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
  const log = {
    ...silentLogger,
    warn(message: string, meta?: Record<string, unknown>) {
      warnings.push({ message, meta })
    },
  }
  const media = createMediaModel(loadConfig({ ...base, LLM_PROVIDER: 'ollama', WHISPER_ENABLED: 'false' }), log)
  expect(media.describeModel).toBe('qwen3.6:35b-a3b')
  expect(media.model).toBe('qwen3.6:35b-a3b')
  await expect(media.transcribe('/tmp/voice.ogg', 'audio/ogg')).rejects.toThrow(
    /audio transcription unavailable with this provider/,
  )
  expect(warnings).toEqual([
    {
      message: 'audio transcription unavailable with this provider',
      meta: { path: '/tmp/voice.ogg', mime: 'audio/ogg' },
    },
  ])
})
