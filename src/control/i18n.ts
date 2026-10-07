import { BOT_PREFIX } from './classify.ts'

export type ReplyLanguage = 'en' | 'es'

const LANGUAGE_PROMPT =
  'Which language do you prefer? / ¿Qué idioma preferís?\n' +
  '1. Español\n' +
  '2. English'

export function languagePrompt(): string {
  return `${BOT_PREFIX}${LANGUAGE_PROMPT}`
}

export function languageSaved(language: ReplyLanguage): string {
  return language === 'es'
    ? `${BOT_PREFIX}Listo. Te voy a hablar en español. Para cambiarlo decime "idioma inglés".`
    : `${BOT_PREFIX}Done. I will talk to you in English. To change it, say "language spanish".`
}

export function helpReply(language: ReplyLanguage): string {
  if (language === 'es') {
    return (
      `${BOT_PREFIX}Pedime un resumen por el nombre del contacto (por ejemplo "resumí Gusma hoy"). ` +
      'Puedo usar hoy, ayer, esta semana, la última hora, las últimas 2 horas o los últimos N días. ' +
      'Si no decís el período, te lo pregunto. ' +
      'Decí "actualizar nombres" para sincronizar contactos. ' +
      'Si no encuentro a alguien, decí "buscar contacto NOMBRE". ' +
      'Si hay varios parecidos, te muestro opciones numeradas. ' +
      'Para cambiar el idioma: "idioma inglés" o "idioma español".'
    )
  }
  return (
    `${BOT_PREFIX}Ask me to summarize a chat by saved contact name (e.g. "summarize Gusma today"). ` +
    'I can use today, yesterday, this week, last hour, last 2 hours, or last N days. ' +
    'If you omit the time range, I will ask for one. ' +
    'Say "refresh names" or "actualizar nombres" to sync contacts from your phone. ' +
    'If I cannot find someone, say "buscar contacto NAME" to search your address book again. ' +
    'When several contacts match, I will show numbered options. ' +
    'To change the language, say "language spanish" or "language english".'
  )
}

export function refreshNamesStarted(language: ReplyLanguage): string {
  return language === 'es'
    ? `${BOT_PREFIX}Actualizando nombres desde WhatsApp...`
    : `${BOT_PREFIX}Updating chat names from WhatsApp...`
}

export function refreshNamesUnavailable(language: ReplyLanguage): string {
  return language === 'es'
    ? `${BOT_PREFIX}Actualizar nombres no está disponible en este proveedor.`
    : `${BOT_PREFIX}Chat name refresh is not available for this messaging provider.`
}

export function refreshNamesDone(
  language: ReplyLanguage,
  result: { addressBookNames: number; groupNames: number; contacts: number },
): string {
  if (result.addressBookNames === 0) {
    return language === 'es'
      ? `${BOT_PREFIX}Terminó la sincronización, pero WhatsApp no envió nombres de la agenda. ` +
          `Sincronicé ${result.contacts} contacto(s) y ${result.groupNames} grupo(s). ` +
          'Abrí WhatsApp en el teléfono, esperá unos segundos y decime "actualizar nombres" de nuevo.'
      : `${BOT_PREFIX}Contact sync finished, but WhatsApp did not send any saved address-book names. ` +
          `Synced ${result.contacts} contact(s) and ${result.groupNames} group(s). ` +
          'Open WhatsApp on your phone, wait a few seconds, then say "actualizar nombres" again.'
  }
  return language === 'es'
    ? `${BOT_PREFIX}Nombres actualizados: ${result.addressBookNames} contacto(s) de la agenda, ` +
        `${result.groupNames} grupo(s), ${result.contacts} contacto(s) en total.`
    : `${BOT_PREFIX}Chat names updated: ${result.addressBookNames} address-book contact(s), ` +
        `${result.groupNames} group(s), ${result.contacts} total contact(s).`
}

export function refreshNamesFailed(language: ReplyLanguage, error: string): string {
  return language === 'es'
    ? `${BOT_PREFIX}No pude actualizar los nombres: ${error}`
    : `${BOT_PREFIX}Could not refresh chat names: ${error}`
}

export function requestFailed(language: ReplyLanguage, error: string): string {
  return language === 'es'
    ? `${BOT_PREFIX}No pude completar el pedido: ${error}`
    : `${BOT_PREFIX}Could not complete the request: ${error}`
}

export function cancelled(language: ReplyLanguage): string {
  return language === 'es' ? 'Cancelado.' : 'Cancelled.'
}

export function rangeHelp(language: ReplyLanguage): string {
  return language === 'es'
    ? '¿Qué período uso? Por ejemplo: hoy, ayer, última hora, últimas 2 horas, últimos 3 días.\n0. Cancelar'
    : 'What time range should I use? Examples: today, yesterday, last hour, last 2 hours, last 3 days.\n0. Cancel'
}

export function didNotUnderstand(language: ReplyLanguage): string {
  return language === 'es'
    ? 'No entendí. Pedime el resumen de un chat, o decí ayuda.'
    : 'I did not understand that. Ask for a summary of a chat, or say help.'
}

export function couldNotUnderstand(language: ReplyLanguage): string {
  return language === 'es'
    ? 'No pude entender el pedido. Probá: "resumí <chat> hoy/ayer", o decí ayuda.'
    : 'I could not understand that request. Try: "summarize <chat> today/yesterday", or say help.'
}

export function whichConversation(language: ReplyLanguage): string {
  return language === 'es'
    ? '¿Qué conversación resumo?'
    : 'Which conversation should I summarize?'
}

export function contactNotFound(language: ReplyLanguage, query: string): string {
  return language === 'es'
    ? `No encontré "${query}" en los contactos sincronizados. ` +
        'Abrí WhatsApp en el teléfono y decime ' +
        `"buscar contacto ${query}" para buscar de nuevo.`
    : `I could not find "${query}" in your synced contacts. ` +
        'Open WhatsApp on your phone, then say ' +
        `"buscar contacto ${query}" to search again.`
}

export function whichContact(language: ReplyLanguage, lines: string[]): string {
  const title = language === 'es' ? '¿Qué contacto quisiste decir?' : 'Which contact did you mean?'
  const footer = language === 'es' ? '0. Cancelar\nRespondé con un número.' : '0. Cancel\nReply with a number.'
  return `${title}\n${lines.join('\n')}\n${footer}`
}

export function contactActivity(language: ReplyLanguage, messageCount: number): string {
  if (messageCount <= 0) {
    return language === 'es' ? 'sin mensajes todavía' : 'no messages yet'
  }
  if (language === 'es') {
    return messageCount === 1 ? '1 mensaje' : `${messageCount} mensajes`
  }
  return `${messageCount} message${messageCount === 1 ? '' : 's'}`
}

export function contactsNotFound(language: ReplyLanguage, query: string): string {
  return language === 'es'
    ? `${BOT_PREFIX}Sincronicé tus contactos y no encontré "${query}" en la agenda. ` +
        'Abrí WhatsApp en el teléfono, esperá unos segundos y probá de nuevo.'
    : `${BOT_PREFIX}I synced your contacts but could not find "${query}" in your address book. ` +
        'Open WhatsApp on your phone, wait a few seconds, then try again.'
}

export function contactFound(language: ReplyLanguage, label: string): string {
  return language === 'es'
    ? `${BOT_PREFIX}Encontré el contacto "${label}". Ya podés pedir el resumen por ese nombre.`
    : `${BOT_PREFIX}Found contact "${label}". You can summarize that chat by name now.`
}

export function contactOptions(language: ReplyLanguage, query: string, lines: string[]): string {
  const title =
    language === 'es'
      ? `No encontré una coincidencia exacta para "${query}". ¿Quisiste decir:`
      : `I did not find an exact match for "${query}". Did you mean:`
  const footer =
    language === 'es'
      ? 'Respondé con un número para elegir, o 0 para cancelar.'
      : 'Reply with a number to pick one, or 0 to cancel.'
  return `${BOT_PREFIX}${title}\n${lines.join('\n')}\n${footer}`
}

export function noContact(language: ReplyLanguage, query: string): string {
  return language === 'es'
    ? `${BOT_PREFIX}No encontré un contacto para "${query}".`
    : `${BOT_PREFIX}No contact found for "${query}".`
}

export function chatNotFound(language: ReplyLanguage, query: string): string {
  return language === 'es'
    ? `${BOT_PREFIX}No encontré un chat que coincida con "${query}".`
    : `${BOT_PREFIX}I could not find a chat matching "${query}".`
}

export function chatNameSaved(language: ReplyLanguage, displayName: string, label: string, kind: string): string {
  return language === 'es'
    ? `${BOT_PREFIX}Guardé "${displayName}" para ${label} (${kind}).`
    : `${BOT_PREFIX}Saved "${displayName}" for ${label} (${kind}).`
}

export function whichChat(language: ReplyLanguage, lines: string[]): string {
  const title = language === 'es' ? '¿Qué chat quisiste decir?' : 'Which chat did you mean?'
  const footer =
    language === 'es' ? 'Usá: nombre TU NOMBRE para CHAT' : 'Use: name YOUR NAME for CHAT'
  return `${title}\n${lines.join('\n')}\n${footer}`
}

export function emptyPeriod(language: string): string {
  return language === 'es' || language.startsWith('es')
    ? 'No hay mensajes en ese período.'
    : 'No messages in that period.'
}

/** A reply to the first-run language question, or null when the text is something else. */
export function parseLanguageChoice(text: string): ReplyLanguage | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (normalized === '1' || /^(es|espa[nñ]ol|castellano|spanish)$/.test(normalized)) return 'es'
  if (normalized === '2' || /^(en|english|ingl[eé]s)$/.test(normalized)) return 'en'
  return null
}

/**
 * An explicit language change. `'ask'` means they want the question again
 * without naming a language.
 */
export function parseLanguageCommand(text: string): ReplyLanguage | 'ask' | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const match = normalized.match(
    /^(?:idioma|language|cambiar idioma|change language)(?:\s+(?:a|to))?\s*(.*)$/,
  )
  if (match) {
    const rest = match[1]?.trim() ?? ''
    if (rest.length === 0) return 'ask'
    return parseLanguageChoice(rest)
  }
  const inline = normalized.match(/^(?:en|in)\s+(espa[nñ]ol|castellano|spanish|english|ingl[eé]s)$/)
  if (!inline?.[1]) return null
  return parseLanguageChoice(inline[1])
}

export function isLanguageClarification(originalText: string): boolean {
  try {
    const value = JSON.parse(originalText) as { kind?: string }
    return value.kind === 'pick_language'
  } catch {
    return false
  }
}

export function languageClarificationText(originalText: string): string {
  try {
    const value = JSON.parse(originalText) as { userText?: string }
    return value.userText?.trim() ?? ''
  } catch {
    return ''
  }
}
