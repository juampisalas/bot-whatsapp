import {
  helpReply,
  refreshNamesDone,
  refreshNamesFailed,
  refreshNamesStarted,
  refreshNamesUnavailable,
  type ReplyLanguage,
} from './i18n.ts'

export type ControlCommand = 'help' | 'refresh_names'

export const HELP_REPLY = helpReply('en')
export const REFRESH_NAMES_STARTED_REPLY = refreshNamesStarted('en')
export const REFRESH_NAMES_UNAVAILABLE_REPLY = refreshNamesUnavailable('en')

export function formatRefreshDoneReply(
  result: {
    addressBookNames: number
    pushNames: number
    groupNames: number
    contacts: number
  },
  language: ReplyLanguage = 'en',
): string {
  return refreshNamesDone(language, result)
}

export function formatRefreshFailedReply(error: string, language: ReplyLanguage = 'en'): string {
  return refreshNamesFailed(language, error)
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Fast-path control commands that must not wait on the LLM. */
export function matchControlCommand(text: string): ControlCommand | null {
  const normalized = normalizeCommand(text)
  if (normalized === 'help' || normalized === 'ayuda') return 'help'

  if (
    /^refresh(?: names| contact names| chat names)?$/.test(normalized) ||
    /^update(?: chat names| names)?$/.test(normalized) ||
    /^sync(?: names| contacts)?$/.test(normalized) ||
    /^actualizar(?: los nombres(?: de(?: mis)? chats)?| nombres(?: de(?: mis)? chats)?)?$/.test(
      normalized,
    )
  ) {
    return 'refresh_names'
  }

  return null
}
