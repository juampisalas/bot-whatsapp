import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import type { Config } from '../../config/index.ts'
import { describeError, type Logger } from '../../domain/logger.ts'
import type { LanguageDetection } from './language-policy.ts'
import type { TranscribeOptions } from './port.ts'

export type WhisperRunner = {
  readonly model: string
  detectLanguage(wavPath: string): Promise<LanguageDetection>
  transcribe(wavPath: string, language?: string): Promise<string>
}

type RunCommand = (command: string, args: string[], env?: Record<string, string>) => Promise<string>

const DEFAULT_WHISPER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/whisper_transcribe.py',
)

function defaultWhisperScript(config: Config): string {
  return config.WHISPER_SCRIPT?.trim() || DEFAULT_WHISPER_SCRIPT
}

function runCommand(command: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
    })
  })
}

async function convertToWav(
  inputPath: string,
  ffmpegPath: string,
  run: RunCommand,
): Promise<{ wavPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'bot-whisper-'))
  const wavPath = join(dir, 'audio.wav')
  await run(ffmpegPath, [
    '-y',
    '-i',
    inputPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    wavPath,
  ])
  return {
    wavPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function parseJsonLine<T>(output: string): T {
  const line = output
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean)
  if (!line) throw new Error('whisper runner returned empty output')
  return JSON.parse(line) as T
}

export function resolveWhisperScript(config: Config): string {
  return defaultWhisperScript(config)
}

export function createWhisperRunner(
  config: Config,
  _log: Logger,
  deps: { run?: RunCommand } = {},
): WhisperRunner | null {
  if (!config.WHISPER_ENABLED) return null

  const run = deps.run ?? runCommand
  const python = config.WHISPER_PYTHON
  const script = resolveWhisperScript(config)
  const model = config.WHISPER_MODEL
  const env = { WHISPER_MODEL: model }

  return {
    model: `whisper:${model}`,
    async detectLanguage(wavPath: string): Promise<LanguageDetection> {
      const output = await run(python, [script, 'detect', wavPath], env)
      const parsed = parseJsonLine<{ language?: string; confidence?: number }>(output)
      return {
        language: parsed.language ?? '',
        confidence: parsed.confidence ?? 0,
      }
    },
    async transcribe(wavPath: string, language?: string): Promise<string> {
      const args = [script, 'transcribe', wavPath]
      if (language) args.push('--language', language)
      const output = await run(python, args, env)
      const parsed = parseJsonLine<{ text?: string }>(output)
      return parsed.text ?? ''
    },
  }
}

export async function transcribeWithWhisper(
  _runner: WhisperRunner,
  config: Config,
  log: Logger,
  inputPath: string,
  options: TranscribeOptions | undefined,
  deps: { run?: RunCommand; convert?: typeof convertToWav } = {},
): Promise<string> {
  const run = deps.run ?? runCommand
  const convert = deps.convert ?? convertToWav
  let cleanup: (() => Promise<void>) | null = null
  try {
    const converted = await convert(inputPath, config.FFMPEG_PATH, run)
    cleanup = converted.cleanup
    const args = [
      resolveWhisperScript(config),
      'process',
      converted.wavPath,
      '--confidence-threshold',
      String(config.WHISPER_LANGUAGE_CONFIDENCE),
    ]
    if (options?.preferredLanguage) {
      args.push('--preferred-language', options.preferredLanguage)
    }
    const output = await run(config.WHISPER_PYTHON, args, { WHISPER_MODEL: config.WHISPER_MODEL })
    const parsed = parseJsonLine<{ text?: string }>(output)
    return parsed.text ?? ''
  } catch (error) {
    log.warn('whisper transcription failed', {
      path: inputPath,
      error: describeError(error),
    })
    throw error
  } finally {
    if (cleanup) {
      await cleanup().catch(() => undefined)
    }
  }
}

export async function isWhisperAvailable(config: Config): Promise<boolean> {
  try {
    await readFile(resolveWhisperScript(config))
    await runCommand(config.FFMPEG_PATH, ['-version'])
    return true
  } catch {
    return false
  }
}
