import type { Chat, Contact, LIDMapping } from 'baileys'
import type { ContactMeta } from '../../domain/provider.ts'

/** Saved chat label from WhatsApp history or chat-list sync (display name, subject, or username). */
export function chatLabelFromBaileys(chat: Partial<Chat> & { id?: string | null }): string | null {
  const label =
    chat.displayName?.trim() || chat.name?.trim() || chat.username?.trim() || null
  return label && label.length > 0 ? label : null
}

export function contactMetaFromChat(chat: Partial<Chat> & { id: string }): ContactMeta | null {
  const addressBookName = chatLabelFromBaileys(chat)
  if (!addressBookName) return null

  const externalIds = [chat.id, chat.lidJid, chat.pnJid].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  return {
    externalIds: [...new Set(externalIds)],
    addressBookName,
    pushName: null,
  }
}

export function contactMetaFromBaileys(contact: Partial<Contact> & { id: string }): ContactMeta {
  const externalIds = [contact.id, contact.lid, contact.phoneNumber].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  const addressBookName =
    contact.name?.trim() || contact.verifiedName?.trim() || null
  const pushName = contact.notify?.trim() || null

  return {
    externalIds: [...new Set(externalIds)],
    addressBookName,
    pushName,
  }
}

export function contactMetaFromLidMapping(mapping: LIDMapping): ContactMeta {
  return {
    externalIds: [mapping.pn, mapping.lid],
    addressBookName: null,
    pushName: null,
  }
}
