import type { ContactMeta, ConversationMeta, MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import {
  linkLidMapping,
  syncAddressBookName,
  syncPushName,
  upsertConversation,
} from '../store/repositories/conversations.ts'

/** Persists one contact entry from the channel address book into conversations/participants. */
export async function persistContactMeta(
  db: Db,
  providerId: ProviderId,
  contact: ContactMeta,
): Promise<void> {
  if (contact.addressBookName) {
    await syncAddressBookName(db, providerId, {
      externalIds: contact.externalIds,
      name: contact.addressBookName,
    })
  }
  if (contact.pushName) {
    await syncPushName(db, providerId, {
      externalIds: contact.externalIds,
      name: contact.pushName,
    })
  }

  const phoneExternalId = contact.externalIds.find((id) => id.endsWith('@s.whatsapp.net'))
  const lidExternalId = contact.externalIds.find((id) => id.endsWith('@lid'))
  if (phoneExternalId && lidExternalId) {
    await linkLidMapping(db, providerId, { phoneExternalId, lidExternalId })
  }
}

/** Ensures a group or DM row exists even before any message is captured. */
export async function persistConversationMeta(
  db: Db,
  providerId: ProviderId,
  conversation: ConversationMeta,
): Promise<void> {
  await upsertConversation(db, {
    provider: providerId,
    externalId: conversation.externalId,
    kind: conversation.kind,
    name: conversation.name,
  })
}

/** Pulls the full contact/group directory from the channel and writes it to the database. */
export async function syncDirectoryToDb(
  db: Db,
  provider: MessagingProvider,
): Promise<void> {
  if (!provider.syncDirectory) return
  await provider.syncDirectory({
    onContact: (contact) => persistContactMeta(db, provider.id, contact),
    onConversation: (conversation) =>
      persistConversationMeta(db, provider.id, conversation),
  })
}
