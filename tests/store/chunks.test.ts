import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  findValidChunk,
  invalidateChunksForTimezoneChange,
  upsertChunk,
  type ChunkKey,
} from '../../src/store/repositories/chunks.ts'
import { upsertConversation, upsertParticipant } from '../../src/store/repositories/conversations.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { upsertGlobalPreferences } from '../../src/store/repositories/preferences.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

async function seedConversation(): Promise<string> {
  return upsertConversation(handle.db, {
    provider: 'fake',
    externalId: `chunks-${crypto.randomUUID()}`,
    kind: 'group',
    name: 'Chunk Test',
  })
}

test('findValidChunk returns text when count and lastMessageAt match', async () => {
  const conversationId = await seedConversation()
  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: `p-${crypto.randomUUID()}`,
    displayName: 'Ana',
  })

  const t1 = new Date('2026-08-30T12:00:00.000Z')
  const t2 = new Date('2026-08-30T13:00:00.000Z')
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: `m-${crypto.randomUUID()}`,
    conversationId,
    participantId,
    sentAt: t1,
    fromSelf: false,
    text: 'hello',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: `m-${crypto.randomUUID()}`,
    conversationId,
    participantId,
    sentAt: t2,
    fromSelf: false,
    text: 'world',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })

  const key: ChunkKey = {
    conversationId,
    day: '2026-08-30',
    from: new Date('2026-08-30T00:00:00.000Z'),
    to: new Date('2026-08-31T00:00:00.000Z'),
    model: 'fake-model',
    promptVersion: 1,
  }

  await upsertChunk(handle.db, key, 'partial summary', 2, t2)

  expect(await findValidChunk(handle.db, key)).toBe('partial summary')
})

test('findValidChunk returns null when a new message arrives', async () => {
  const conversationId = await seedConversation()
  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: `p-${crypto.randomUUID()}`,
    displayName: 'Ana',
  })

  const t1 = new Date('2026-08-29T12:00:00.000Z')
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: `m-${crypto.randomUUID()}`,
    conversationId,
    participantId,
    sentAt: t1,
    fromSelf: false,
    text: 'only',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })

  const key: ChunkKey = {
    conversationId,
    day: '2026-08-29',
    from: new Date('2026-08-29T00:00:00.000Z'),
    to: new Date('2026-08-30T00:00:00.000Z'),
    model: 'fake-model',
    promptVersion: 1,
  }

  await upsertChunk(handle.db, key, 'stale', 1, t1)

  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: `m-${crypto.randomUUID()}`,
    conversationId,
    participantId,
    sentAt: new Date('2026-08-29T18:00:00.000Z'),
    fromSelf: false,
    text: 'late',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })

  expect(await findValidChunk(handle.db, key)).toBeNull()
})

test('changing global timezone invalidates chunk_summaries', async () => {
  const conversationId = await seedConversation()
  const key: ChunkKey = {
    conversationId,
    day: '2026-08-28',
    from: new Date('2026-08-28T00:00:00.000Z'),
    to: new Date('2026-08-29T00:00:00.000Z'),
    model: 'fake-model',
    promptVersion: 1,
  }

  await upsertGlobalPreferences(handle.db, { timezone: 'UTC' })
  await upsertChunk(handle.db, key, 'cached', 1, new Date('2026-08-28T10:00:00.000Z'))
  await upsertGlobalPreferences(handle.db, { timezone: 'America/Argentina/Buenos_Aires' })

  const rows = await handle.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM chunk_summaries WHERE conversation_id = ${conversationId}
  `
  expect(rows[0]?.n).toBe('0')
})

test('invalidateChunksForTimezoneChange deletes all rows', async () => {
  const conversationId = await seedConversation()
  await upsertChunk(
    handle.db,
    {
      conversationId,
      day: '2026-08-27',
      from: new Date('2026-08-27T00:00:00.000Z'),
      to: new Date('2026-08-28T00:00:00.000Z'),
      model: 'fake-model',
      promptVersion: 1,
    },
    'gone',
    1,
    new Date('2026-08-27T10:00:00.000Z'),
  )

  await invalidateChunksForTimezoneChange(handle.db)

  const rows = await handle.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM chunk_summaries`
  expect(rows[0]?.n).toBe('0')
})
