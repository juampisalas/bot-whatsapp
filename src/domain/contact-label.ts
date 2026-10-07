import type { ConversationKind } from './types.ts'

/** Formats a WhatsApp phone JID as an international number label. */
export function formatPhoneFromJid(externalId: string): string | null {
  if (!externalId.endsWith('@s.whatsapp.net')) return null
  const local = externalId.slice(0, externalId.indexOf('@'))
  const digits = local.replace(/\D/g, '')
  if (digits.length === 0) return null
  return `+${digits}`
}

/**
 * Canonical label for a DM contact: address book, then phone number, then WhatsApp push name.
 * Groups keep their subject in `name`.
 */
export function canonicalContactLabel(input: {
  kind: ConversationKind
  externalId: string
  addressBookName?: string | null
  pushName?: string | null
  groupName?: string | null
}): string | null {
  if (input.kind === 'group' || input.kind === 'channel') {
    return input.groupName?.trim() || null
  }

  const addressBook = input.addressBookName?.trim()
  if (addressBook) return addressBook

  const phone = formatPhoneFromJid(input.externalId)
  if (phone) return phone

  const push = input.pushName?.trim()
  if (push) return push

  return null
}
