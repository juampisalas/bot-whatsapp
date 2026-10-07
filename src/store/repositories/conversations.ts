import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { canonicalContactLabel } from '../../domain/contact-label.ts'
import type { ConversationKind, ProviderId } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { chatPreferences, conversations, messages, participants } from '../schema.ts'

export type ConversationHit = {
  id: string
  externalId: string
  kind: ConversationKind
  name: string | null
  addressBookName?: string | null
  pushName?: string | null
  phoneNumber?: string | null
  lastMessageAt: Date | null
  messageCount: number
  matchType: 'exact' | 'fuzzy'
}

const FUZZY_SIMILARITY_THRESHOLD = 0.25
const MAX_CANDIDATES = 3

function isLowQualityFuzzyHit(hit: ConversationHit): boolean {
  return hit.matchType === 'fuzzy' && hit.kind === 'group' && hit.messageCount === 0
}

/** Drops fuzzy group hits that only exist in the directory sync and never had messages. */
export function filterConversationHits(hits: ConversationHit[]): ConversationHit[] {
  return hits.filter((hit) => !isLowQualityFuzzyHit(hit))
}

function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
}

function isDirectMessageJid(externalId: string): boolean {
  return externalId.endsWith('@s.whatsapp.net') || externalId.endsWith('@lid')
}

function extractPhoneDigits(query: string): string | null {
  const digits = query.replace(/\D/g, '')
  if (digits.length < 6) return null
  return digits
}

/** Phone digits from a WhatsApp @s.whatsapp.net JID. */
export function phoneDigitsFromExternalId(externalId: string): string | null {
  if (!externalId.endsWith('@s.whatsapp.net')) return null
  return extractPhoneDigits(externalId)
}

function phoneMatchCondition(digits: string) {
  const pattern = `%${digits}%`
  return and(
    eq(conversations.kind, 'dm'),
    or(
      ilike(conversations.externalId, pattern),
      ilike(conversations.phoneNumber, pattern),
      sql`regexp_replace(split_part(${conversations.externalId}, '@', 1), '[^0-9]', '', 'g') like ${pattern}`,
      sql`regexp_replace(COALESCE(${conversations.phoneNumber}, ''), '[^0-9]', '', 'g') like ${pattern}`,
    ),
  )
}

async function searchConversationsByPhone(
  db: Db,
  provider: ProviderId,
  digits: string,
): Promise<ConversationHit[]> {
  const rows = await db
    .select({
      id: conversations.id,
      externalId: conversations.externalId,
      kind: conversations.kind,
      name: conversations.name,
      addressBookName: conversations.addressBookName,
      pushName: conversations.pushName,
      phoneNumber: conversations.phoneNumber,
      lastMessageAt: conversations.lastMessageAt,
      messageCount: count(messages.id),
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.provider, provider), phoneMatchCondition(digits)))
    .groupBy(conversations.id)
    .orderBy(desc(conversations.lastMessageAt))
    .limit(MAX_CANDIDATES)

  return rows.map((row) => mapHitRow(row, 'exact'))
}

function tokenMatchCondition(token: string) {
  const pattern = `%${token}%`
  return or(
    ilike(conversations.name, pattern),
    ilike(conversations.addressBookName, pattern),
    ilike(conversations.pushName, pattern),
    ilike(chatPreferences.alias, pattern),
    sql`(${conversations.kind} = 'dm' and exists (
      select 1 from ${participants} p
      where p.provider = ${conversations.provider}
        and (
          p.external_id = ${conversations.externalId}
          or exists (
            select 1 from ${messages} m
            where m.conversation_id = ${conversations.id}
              and m.participant_id = p.id
              and m.from_self = false
          )
        )
        and (
          p.display_name ilike ${pattern}
          or p.address_book_name ilike ${pattern}
          or p.push_name ilike ${pattern}
        )
    ))`,
  )
}

function mapHitRow(
  row: {
    id: string
    externalId: string
    kind: ConversationKind
    name: string | null
    addressBookName?: string | null
    pushName?: string | null
    phoneNumber?: string | null
    lastMessageAt: Date | null
    messageCount: number | bigint
  },
  matchType: 'exact' | 'fuzzy',
): ConversationHit {
  return {
    id: row.id,
    externalId: row.externalId,
    kind: row.kind,
    name: row.name,
    addressBookName: row.addressBookName ?? null,
    pushName: row.pushName ?? null,
    phoneNumber: row.phoneNumber ?? null,
    lastMessageAt: row.lastMessageAt,
    messageCount: Number(row.messageCount),
    matchType,
  }
}

async function searchWithTokens(
  db: Db,
  provider: ProviderId,
  tokens: string[],
  mode: 'all' | 'any',
): Promise<ConversationHit[]> {
  const tokenConditions = tokens.map((token) => tokenMatchCondition(token))
  const match =
    tokenConditions.length === 0
      ? undefined
      : mode === 'all'
        ? and(...tokenConditions)
        : or(...tokenConditions)
  if (!match) return []

  const rows = await db
    .select({
      id: conversations.id,
      externalId: conversations.externalId,
      kind: conversations.kind,
      name: conversations.name,
      addressBookName: conversations.addressBookName,
      pushName: conversations.pushName,
      phoneNumber: conversations.phoneNumber,
      lastMessageAt: conversations.lastMessageAt,
      messageCount: count(messages.id),
    })
    .from(conversations)
    .leftJoin(chatPreferences, eq(chatPreferences.conversationId, conversations.id))
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.provider, provider), match))
    .groupBy(conversations.id)
    .orderBy(desc(conversations.lastMessageAt))
    .limit(MAX_CANDIDATES)

  return rows.map((row) => mapHitRow(row, 'exact'))
}

function namedContactCondition() {
  return or(
    sql`nullif(trim(COALESCE(${conversations.addressBookName}, '')), '') is not null`,
    sql`nullif(trim(COALESCE(${conversations.pushName}, '')), '') is not null`,
    sql`nullif(trim(COALESCE(${conversations.name}, '')), '') is not null`,
    sql`exists (
      select 1 from ${chatPreferences}
      where ${chatPreferences.conversationId} = ${conversations.id}
        and nullif(trim(COALESCE(${chatPreferences.alias}, '')), '') is not null
    )`,
  )
}

/** Searches synced address-book contacts (DMs with a saved or push name). */
export async function searchNamedContacts(
  db: Db,
  provider: ProviderId,
  query: string,
): Promise<ConversationHit[]> {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return []

  const exact = filterConversationHits(await searchConversationsByName(db, provider, query)).filter(
    (hit) => hit.kind === 'dm',
  )
  if (exact.length > 0) return exact

  const nameSimilarity = sql<number>`similarity(lower(COALESCE(${conversations.addressBookName}, '')), ${normalized})`
  const pushSimilarity = sql<number>`similarity(lower(COALESCE(${conversations.pushName}, '')), ${normalized})`
  const labelSimilarity = sql<number>`similarity(lower(COALESCE(${conversations.name}, '')), ${normalized})`
  const score = sql<number>`GREATEST(${nameSimilarity}, ${pushSimilarity}, ${labelSimilarity})`

  const rows = await db
    .select({
      id: conversations.id,
      externalId: conversations.externalId,
      kind: conversations.kind,
      name: conversations.name,
      addressBookName: conversations.addressBookName,
      pushName: conversations.pushName,
      phoneNumber: conversations.phoneNumber,
      lastMessageAt: conversations.lastMessageAt,
      messageCount: count(messages.id),
      score,
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.provider, provider),
        eq(conversations.kind, 'dm'),
        namedContactCondition(),
        or(
          sql`${nameSimilarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
          sql`${pushSimilarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
          sql`${labelSimilarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
          sql`lower(COALESCE(${conversations.addressBookName}, '')) % ${normalized}`,
          sql`lower(COALESCE(${conversations.pushName}, '')) % ${normalized}`,
          sql`lower(COALESCE(${conversations.name}, '')) % ${normalized}`,
        ),
      ),
    )
    .groupBy(conversations.id)
    .orderBy(desc(score), desc(conversations.lastMessageAt))
    .limit(MAX_CANDIDATES)

  return rows.map((row) => mapHitRow(row, 'fuzzy'))
}

async function searchSimilarConversations(
  db: Db,
  provider: ProviderId,
  query: string,
  kind?: ConversationKind,
): Promise<ConversationHit[]> {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return []

  const nameSimilarity = sql<number>`similarity(lower(COALESCE(${conversations.name}, '')), ${normalized})`
  const pushSimilarity = sql<number>`similarity(lower(COALESCE(${conversations.pushName}, '')), ${normalized})`
  const addressSimilarity = sql<number>`similarity(lower(COALESCE(${conversations.addressBookName}, '')), ${normalized})`
  const wordSimilarity = sql<number>`word_similarity(${normalized}, lower(COALESCE(${conversations.name}, '')))`
  const score = sql<number>`GREATEST(${nameSimilarity}, ${pushSimilarity}, ${addressSimilarity}, ${wordSimilarity})`

  const rows = await db
    .select({
      id: conversations.id,
      externalId: conversations.externalId,
      kind: conversations.kind,
      name: conversations.name,
      addressBookName: conversations.addressBookName,
      pushName: conversations.pushName,
      phoneNumber: conversations.phoneNumber,
      lastMessageAt: conversations.lastMessageAt,
      messageCount: count(messages.id),
      score,
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.provider, provider),
        kind ? eq(conversations.kind, kind) : undefined,
        or(
          sql`${nameSimilarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
          sql`${pushSimilarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
          sql`${addressSimilarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
          sql`${wordSimilarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`,
          sql`lower(COALESCE(${conversations.name}, '')) % ${normalized}`,
          sql`lower(COALESCE(${conversations.pushName}, '')) % ${normalized}`,
          sql`lower(COALESCE(${conversations.addressBookName}, '')) % ${normalized}`,
        ),
      ),
    )
    .groupBy(conversations.id)
    .orderBy(desc(score), desc(conversations.lastMessageAt))
    .limit(MAX_CANDIDATES)

  return rows.map((row) => mapHitRow(row, 'fuzzy'))
}

/**
 * Builds the upsert `set` from present values only, instead of resolving
 * absence with SQL `COALESCE`. A null name means "the channel did not
 * report it this time", so the existing name is left alone. `updatedAt`
 * ensures the `set` is never empty.
 */
export async function upsertConversation(
  db: Db,
  input: { provider: ProviderId; externalId: string; kind: ConversationKind; name: string | null },
): Promise<string> {
  const phoneNumber =
    input.kind === 'dm' ? phoneDigitsFromExternalId(input.externalId) : null
  const rows = await db
    .insert(conversations)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      kind: input.kind,
      name: input.name,
      phoneNumber,
    })
    .onConflictDoUpdate({
      target: [conversations.provider, conversations.externalId],
      set: {
        kind: input.kind,
        ...(input.name === null ? {} : { name: input.name }),
        ...(phoneNumber ? { phoneNumber } : {}),
        updatedAt: new Date(),
      },
    })
    .returning({ id: conversations.id })

  const id = rows[0]?.id
  if (!id) throw new Error('upsertConversation did not return an id')
  return id
}

export async function upsertParticipant(
  db: Db,
  input: { provider: ProviderId; externalId: string; displayName: string | null },
): Promise<string> {
  const rows = await db
    .insert(participants)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      displayName: input.displayName,
      pushName: input.displayName,
    })
    .onConflictDoUpdate({
      target: [participants.provider, participants.externalId],
      set: {
        ...(input.displayName === null ? {} : { displayName: input.displayName }),
        updatedAt: new Date(),
      },
    })
    .returning({ id: participants.id })

  const id = rows[0]?.id
  if (!id) throw new Error('upsertParticipant did not return an id')
  return id
}

async function refreshConversationName(
  db: Db,
  provider: ProviderId,
  externalId: string,
): Promise<void> {
  const rows = await db
    .select({
      id: conversations.id,
      kind: conversations.kind,
      addressBookName: conversations.addressBookName,
      pushName: conversations.pushName,
      name: conversations.name,
    })
    .from(conversations)
    .where(and(eq(conversations.provider, provider), eq(conversations.externalId, externalId)))
    .limit(1)

  const row = rows[0]
  if (!row) return

  const name =
    row.kind === 'group' || row.kind === 'channel'
      ? row.name
      : canonicalContactLabel({
          kind: row.kind,
          externalId,
          addressBookName: row.addressBookName,
          pushName: row.pushName,
        })

  await db
    .update(conversations)
    .set({ name, updatedAt: new Date() })
    .where(eq(conversations.id, row.id))
}

async function refreshParticipantName(
  db: Db,
  provider: ProviderId,
  externalId: string,
): Promise<void> {
  const rows = await db
    .select({
      id: participants.id,
      addressBookName: participants.addressBookName,
      pushName: participants.pushName,
    })
    .from(participants)
    .where(and(eq(participants.provider, provider), eq(participants.externalId, externalId)))
    .limit(1)

  const row = rows[0]
  if (!row) return

  const displayName = canonicalContactLabel({
    kind: 'dm',
    externalId,
    addressBookName: row.addressBookName,
    pushName: row.pushName,
  })

  await db
    .update(participants)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(participants.id, row.id))
}

async function applyConversationNameFields(
  db: Db,
  provider: ProviderId,
  externalId: string,
  patch: { addressBookName?: string | null; pushName?: string | null },
): Promise<void> {
  const existing = await db
    .select({ id: conversations.id, kind: conversations.kind })
    .from(conversations)
    .where(and(eq(conversations.provider, provider), eq(conversations.externalId, externalId)))
    .limit(1)

  const row = existing[0]
  if (row) {
    if (row.kind !== 'dm') return
    await db
      .update(conversations)
      .set({
        ...(patch.addressBookName !== undefined ? { addressBookName: patch.addressBookName } : {}),
        ...(patch.pushName !== undefined ? { pushName: patch.pushName } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, row.id))
  } else if (isDirectMessageJid(externalId)) {
    await db.insert(conversations).values({
      provider,
      externalId,
      kind: 'dm',
      name: null,
      addressBookName: patch.addressBookName ?? null,
      pushName: patch.pushName ?? null,
      phoneNumber: phoneDigitsFromExternalId(externalId),
    })
  } else {
    return
  }

  await refreshConversationName(db, provider, externalId)
}

async function applyParticipantNameFields(
  db: Db,
  provider: ProviderId,
  externalId: string,
  patch: { addressBookName?: string | null; pushName?: string | null },
): Promise<void> {
  await db
    .insert(participants)
    .values({
      provider,
      externalId,
      displayName: null,
      addressBookName: patch.addressBookName ?? null,
      pushName: patch.pushName ?? null,
    })
    .onConflictDoUpdate({
      target: [participants.provider, participants.externalId],
      set: {
        ...(patch.addressBookName !== undefined ? { addressBookName: patch.addressBookName } : {}),
        ...(patch.pushName !== undefined ? { pushName: patch.pushName } : {}),
        updatedAt: new Date(),
      },
    })

  await refreshParticipantName(db, provider, externalId)
}

/** Stores an address-book name without letting WhatsApp push names override it. */
export async function syncAddressBookName(
  db: Db,
  provider: ProviderId,
  input: { externalIds: string[]; name: string | null },
): Promise<void> {
  const name = input.name?.trim() ?? null
  if (!name) return

  const externalIds = [...new Set(input.externalIds.filter((id) => id.length > 0))]
  for (const externalId of externalIds) {
    await applyParticipantNameFields(db, provider, externalId, { addressBookName: name })
    await applyConversationNameFields(db, provider, externalId, { addressBookName: name })
  }
}

/** Stores a WhatsApp push name without overriding an address-book name. */
export async function syncPushName(
  db: Db,
  provider: ProviderId,
  input: { externalIds: string[]; name: string | null },
): Promise<void> {
  const name = input.name?.trim() ?? null
  if (!name) return

  const externalIds = [...new Set(input.externalIds.filter((id) => id.length > 0))]
  for (const externalId of externalIds) {
    await applyParticipantNameFields(db, provider, externalId, { pushName: name })
    await applyConversationNameFields(db, provider, externalId, { pushName: name })
  }
}

/** @deprecated Use syncAddressBookName or syncPushName. */
export async function syncContactDisplayName(
  db: Db,
  provider: ProviderId,
  input: { externalIds: string[]; displayName: string | null },
): Promise<void> {
  await syncAddressBookName(db, provider, { externalIds: input.externalIds, name: input.displayName })
}

/** Stores WhatsApp phone digits on DM rows, including @lid chats after a mapping. */
export async function syncPhoneNumber(
  db: Db,
  provider: ProviderId,
  input: { externalIds: string[]; phoneNumber: string | null },
): Promise<void> {
  const phoneNumber = extractPhoneDigits(input.phoneNumber ?? '')
  if (!phoneNumber) return

  const externalIds = [...new Set(input.externalIds.filter((id) => id.length > 0))]
  for (const externalId of externalIds) {
    const existing = await db
      .select({ id: conversations.id, kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.provider, provider), eq(conversations.externalId, externalId)))
      .limit(1)

    const row = existing[0]
    if (row) {
      if (row.kind !== 'dm') continue
      await db
        .update(conversations)
        .set({ phoneNumber, updatedAt: new Date() })
        .where(eq(conversations.id, row.id))
    } else if (isDirectMessageJid(externalId)) {
      await db.insert(conversations).values({
        provider,
        externalId,
        kind: 'dm',
        name: null,
        phoneNumber,
      })
    }
  }
}

/** Copies a known phone-JID name onto the matching @lid chat when WhatsApp links them. */
export async function linkLidMapping(
  db: Db,
  provider: ProviderId,
  input: { phoneExternalId: string; lidExternalId: string },
): Promise<void> {
  const digits = phoneDigitsFromExternalId(input.phoneExternalId)
  if (digits) {
    await syncPhoneNumber(db, provider, {
      externalIds: [input.lidExternalId, input.phoneExternalId],
      phoneNumber: digits,
    })
  }

  const phoneParticipant = await db
    .select({
      addressBookName: participants.addressBookName,
      pushName: participants.pushName,
      displayName: participants.displayName,
    })
    .from(participants)
    .where(
      and(
        eq(participants.provider, provider),
        eq(participants.externalId, input.phoneExternalId),
      ),
    )
    .limit(1)

  const phoneConversation = await db
    .select({
      addressBookName: conversations.addressBookName,
      pushName: conversations.pushName,
      name: conversations.name,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.provider, provider),
        eq(conversations.externalId, input.phoneExternalId),
      ),
    )
    .limit(1)

  const lidConversation = await db
    .select({
      addressBookName: conversations.addressBookName,
      pushName: conversations.pushName,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.provider, provider),
        eq(conversations.externalId, input.lidExternalId),
      ),
    )
    .limit(1)

  const addressBookName =
    phoneParticipant[0]?.addressBookName ??
    phoneConversation[0]?.addressBookName ??
    lidConversation[0]?.addressBookName ??
    null
  const pushName =
    lidConversation[0]?.pushName ??
    phoneParticipant[0]?.pushName ??
    phoneConversation[0]?.pushName ??
    null

  if (addressBookName) {
    await syncAddressBookName(db, provider, {
      externalIds: [input.lidExternalId, input.phoneExternalId],
      name: addressBookName,
    })
  }
  if (pushName) {
    await syncPushName(db, provider, {
      externalIds: [input.lidExternalId, input.phoneExternalId],
      name: pushName,
    })
  }
}

/**
 * Case-insensitive match on conversation name, spoken alias, and participant
 * display names for a provider. Multi-word queries require every token to match;
 * if that finds nothing, any single token may match instead.
 */
export async function searchConversationsByName(
  db: Db,
  provider: ProviderId,
  query: string,
): Promise<ConversationHit[]> {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return []

  const strict = await searchWithTokens(db, provider, tokens, 'all')
  if (strict.length > 0) return strict

  if (tokens.length > 1) return []

  return searchWithTokens(db, provider, tokens, 'any')
}

export async function searchConversationsSimilar(
  db: Db,
  provider: ProviderId,
  query: string,
): Promise<ConversationHit[]> {
  const dmHits = await searchSimilarConversations(db, provider, query, 'dm')
  if (dmHits.length > 0) return dmHits
  return searchSimilarConversations(db, provider, query, 'group')
}

export async function resolveConversationCandidates(
  db: Db,
  provider: ProviderId,
  query: string,
): Promise<ConversationHit[]> {
  const phoneDigits = extractPhoneDigits(query)
  const looksLikePhone = phoneDigits !== null && !/[a-zA-ZáéíóúñüÁÉÍÓÚÑÜ]/.test(query)
  if (looksLikePhone) {
    const phoneHits = filterConversationHits(await searchConversationsByPhone(db, provider, phoneDigits))
    if (phoneHits.length > 0) return phoneHits
  }

  const exact = filterConversationHits(await searchConversationsByName(db, provider, query))
  if (exact.length > 0) return exact

  if (phoneDigits) {
    const phoneHits = await searchConversationsByPhone(db, provider, phoneDigits)
    if (phoneHits.length > 0) return phoneHits
  }

  return filterConversationHits(await searchConversationsSimilar(db, provider, query))
}
