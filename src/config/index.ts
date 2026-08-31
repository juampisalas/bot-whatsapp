// src/config/index.ts
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PROVIDER: z.enum(['whatsapp', 'fake']).default('whatsapp'),
  WHATSAPP_AUTH_DIR: z.string().min(1).default('./data/wa-auth'),
  MEDIA_DIR: z.string().min(1).default('./data/media'),
  CONTROL_PROVIDER: z.enum(['whatsapp', 'fake']).default('whatsapp'),
  CONTROL_CONVERSATION_ID: z.string().optional(),
  CAPTURE_BUFFER_MAX: z.coerce.number().int().positive().default(1000),
  TIMEZONE: z.string().min(1).default('America/Argentina/Buenos_Aires'),
  // Levels the Logger can emit. A new one arrives together with its emitter, not before.
  LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${detail}`)
  }
  return parsed.data
}
