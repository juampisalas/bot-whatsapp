import type { ResolvedPreferences } from '../preferences.ts'

/** Bump when partial or combo prompt text changes so cached chunks are invalidated. */
export const SUMMARY_PROMPT_VERSION = 2

const PARTIAL_TASK = 'Task: summarize one calendar day of messages.'
const COMBO_TASK = 'Task: combine daily summaries into one overall summary.'

export function buildPartialSystemPrompt(
  preferences: ResolvedPreferences,
  focus: string | null,
): string {
  return [PARTIAL_TASK, ...preferenceLines(preferences, focus)].join('\n')
}

export function buildComboSystemPrompt(
  preferences: ResolvedPreferences,
  focus: string | null,
): string {
  return [COMBO_TASK, ...preferenceLines(preferences, focus)].join('\n')
}

export function buildPartialUserPrompt(day: string, transcript: string): string {
  return `Summarize the following messages from ${day}.\n\n${transcript}`
}

export function buildComboUserPrompt(partials: Array<{ day: string; text: string }>): string {
  const body = partials.map((partial) => `## ${partial.day}\n${partial.text}`).join('\n\n')
  return `Combine these daily summaries into one coherent summary.\n\n${body}`
}

export function isPartialSystemPrompt(system: string): boolean {
  return system.startsWith(PARTIAL_TASK)
}

export function isComboSystemPrompt(system: string): boolean {
  return system.startsWith(COMBO_TASK)
}

function preferenceLines(preferences: ResolvedPreferences, focus: string | null): string[] {
  const effectiveFocus = focus ?? preferences.focus
  const lines = [
    `Language: ${preferences.language}`,
    `Length: ${preferences.length}`,
    `Format: ${preferences.format}`,
    `Tone: ${preferences.tone}`,
  ]
  if (effectiveFocus) lines.push(`Focus: ${effectiveFocus}`)
  return lines
}
