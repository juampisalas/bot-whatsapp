import { BOT_PREFIX } from './classify.ts'

const HELP_REPLY = `${BOT_PREFIX}I can reply here. Summaries are not ready yet.`
const DEFAULT_REPLY = `${BOT_PREFIX}I cannot summarize yet. Type help to see what I can do.`

export function replyFor(text: string): string {
  return text.trim().toLowerCase() === 'help' ? HELP_REPLY : DEFAULT_REPLY
}
