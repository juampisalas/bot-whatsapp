import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { readFile } from 'node:fs/promises'
import type { Config } from '../../config/index.ts'
import type { Logger } from '../../domain/logger.ts'
import type { MediaModel, TranscribeOptions } from './port.ts'
import { createWhisperRunner, transcribeWithWhisper } from './whisper.ts'

const AUDIO_UNAVAILABLE = 'audio transcription unavailable with this provider'

/**
 * Ollama (and cloud chat models) accept image file parts in generateText.
 * Audio uses local faster-whisper when WHISPER_ENABLED and prerequisites exist.
 */
export function createMediaModel(config: Config, log: Logger): MediaModel {
  const describeModel = config.LLM_MODEL
  const whisper = createWhisperRunner(config, log)
  const transcriptModel = whisper?.model ?? describeModel
  if (whisper) {
    log.info('whisper transcription enabled', { model: config.WHISPER_MODEL })
  }

  const model = (): LanguageModel => {
    switch (config.LLM_PROVIDER) {
      case 'ollama':
        return createOllama({ baseURL: config.LLM_BASE_URL })(describeModel)
      case 'openai':
        return createOpenAI({ apiKey: config.OPENAI_API_KEY })(describeModel)
      case 'anthropic':
        return createAnthropic({ apiKey: config.ANTHROPIC_API_KEY })(describeModel)
      case 'deepseek':
        return createDeepSeek({ apiKey: config.DEEPSEEK_API_KEY })(describeModel)
    }
  }

  return {
    describeModel,
    transcriptModel,
    get model() {
      return describeModel
    },
    async transcribe(path: string, mime: string | null, options?: TranscribeOptions): Promise<string> {
      if (!whisper) {
        log.warn(AUDIO_UNAVAILABLE, { path, mime })
        throw new Error(AUDIO_UNAVAILABLE)
      }
      return transcribeWithWhisper(whisper, config, log, path, options)
    },
    async describe(path: string, mime: string | null): Promise<string> {
      const data = await readFile(path)
      const mediaType = mime?.startsWith('image/') ? mime : 'image/jpeg'
      const { text } = await generateText({
        model: model(),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe this image briefly for a chat summary.',
              },
              { type: 'file', mediaType, data },
            ],
          },
        ],
      })
      return text
    },
  }
}
