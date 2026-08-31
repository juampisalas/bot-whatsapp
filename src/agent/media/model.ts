import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { readFile } from 'node:fs/promises'
import type { Config } from '../../config/index.ts'
import type { Logger } from '../../domain/logger.ts'
import type { MediaModel } from './port.ts'

const AUDIO_UNAVAILABLE = 'audio transcription unavailable with this provider'

/**
 * Ollama (and cloud chat models) accept image file parts in generateText.
 * Audio is not supported through this provider path — no Whisper sidecar.
 */
export function createMediaModel(config: Config, log: Logger): MediaModel {
  const modelId = config.LLM_MODEL
  const model = (): LanguageModel => {
    switch (config.LLM_PROVIDER) {
      case 'ollama':
        return createOllama({ baseURL: config.LLM_BASE_URL })(modelId)
      case 'openai':
        return createOpenAI({ apiKey: config.OPENAI_API_KEY })(modelId)
      case 'anthropic':
        return createAnthropic({ apiKey: config.ANTHROPIC_API_KEY })(modelId)
      case 'deepseek':
        return createDeepSeek({ apiKey: config.DEEPSEEK_API_KEY })(modelId)
    }
  }

  return {
    model: modelId,
    async transcribe(path: string, mime: string | null): Promise<string> {
      log.warn(AUDIO_UNAVAILABLE, { path, mime })
      throw new Error(AUDIO_UNAVAILABLE)
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
