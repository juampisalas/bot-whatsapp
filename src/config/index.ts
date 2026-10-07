// src/config/index.ts
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PROVIDER: z.enum(['whatsapp', 'fake']).default('whatsapp'),
  WHATSAPP_AUTH_DIR: z.string().min(1).default('./data/wa-auth'),
  /**
   * Digits only, with country code (e.g. 54911…). When set, link with a pairing code
   * instead of a QR. Empty/omitted keeps QR linking.
   */
  WHATSAPP_PHONE_NUMBER: z
    .string()
    .optional()
    .transform((value) => {
      if (!value?.trim()) return undefined
      return value.replace(/\D/g, '')
    })
    .refine((value) => value === undefined || /^\d{8,15}$/.test(value), {
      message: 'must be 8–15 digits including country code',
    }),
  MEDIA_DIR: z.string().min(1).default('./data/media'),
  CONTROL_PROVIDER: z.enum(['whatsapp', 'fake']).default('whatsapp'),
  CONTROL_CONVERSATION_ID: z.string().optional(),
  CAPTURE_BUFFER_MAX: z.coerce.number().int().positive().default(1000),
  // Hard deadline for the whole shutdown sequence, not only disconnect.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  TIMEZONE: z.string().min(1).default('America/Argentina/Buenos_Aires'),
  // Levels the Logger can emit. A new one arrives together with its emitter, not before.
  LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
  LLM_PROVIDER: z.enum(['ollama', 'openai', 'anthropic', 'deepseek']).default('ollama'),
  LLM_MODEL: z.string().min(1).default('qwen3.6:35b-a3b'),
  LLM_BASE_URL: z.string().min(1).default('http://127.0.0.1:11434'),
  EMBEDDING_MODEL: z.string().min(1).default('embeddinggemma:300m'),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  WHISPER_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  WHISPER_MODEL: z.string().min(1).default('medium'),
  WHISPER_LANGUAGE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  WHISPER_PYTHON: z.string().min(1).default('python3'),
  /** Override path to scripts/whisper_transcribe.py when not using the bundled script. */
  WHISPER_SCRIPT: z.string().optional(),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${detail}`)
  }
  return parsed.data
}
