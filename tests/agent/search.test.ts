import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { searchByTopic } from '../../src/agent/search.ts'
import { FakeEmbedder } from '../../src/agent/llm/fake-embedder.ts'
import { upsertConversation } from '../../src/store/repositories/conversations.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

const FROM = new Date('2026-08-30T00:00:00Z')
const TO = new Date('2026-08-31T00:00:00Z')

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

beforeEach(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

async function seedConversation(): Promise<string> {
  return upsertConversation(handle.db, {
    provider: 'fake',
    externalId: `search-${crypto.randomUUID()}`,
    kind: 'group',
    name: 'Search Test',
  })
}

async function seedMessage(
  conversationId: string,
  text: string,
  sentAt: Date,
): Promise<string> {
  const { id } = await insertMessage(handle.db, {
    provider: 'fake',
    externalId: `m-${crypto.randomUUID()}`,
    conversationId,
    participantId: null,
    sentAt,
    fromSelf: false,
    text,
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })
  return id
}

test('searchByTopic embeds missing then returns chronological matches', async () => {
  const conversationId = await seedConversation()
  const earlyId = await seedMessage(
    conversationId,
    'topic about cats',
    new Date('2026-08-30T10:00:00Z'),
  )
  const lateId = await seedMessage(
    conversationId,
    'topic about cats',
    new Date('2026-08-30T14:00:00Z'),
  )
  await seedMessage(conversationId, 'unrelated weather chat', new Date('2026-08-30T12:00:00Z'))

  const embedder = new FakeEmbedder()
  const results = await searchByTopic(
    handle.db,
    embedder,
    conversationId,
    FROM,
    TO,
    'topic about cats',
  )

  expect(embedder.calls.length).toBeGreaterThanOrEqual(2)
  expect(embedder.calls.at(-1)).toEqual(['topic about cats'])
  expect(results.map((row) => row.id)).toEqual([earlyId, lateId])
  expect(results.every((row) => row.senderName != null)).toBe(true)
})

test('searchByTopic second call embeds only the query (nothing missing)', async () => {
  const conversationId = await seedConversation()
  await seedMessage(conversationId, 'topic about cats', new Date('2026-08-30T10:00:00Z'))
  await seedMessage(conversationId, 'topic about dogs', new Date('2026-08-30T11:00:00Z'))

  const first = new FakeEmbedder()
  await searchByTopic(handle.db, first, conversationId, FROM, TO, 'topic about cats')
  const embeddedFirst = first.calls[0]?.length ?? 0
  expect(embeddedFirst).toBe(2)

  const second = new FakeEmbedder()
  await searchByTopic(handle.db, second, conversationId, FROM, TO, 'topic about cats')

  expect(second.calls).toHaveLength(1)
  expect(second.calls[0]).toEqual(['topic about cats'])
})

test('searchByTopic returns empty when nothing is similar', async () => {
  const conversationId = await seedConversation()
  await seedMessage(conversationId, 'zzzzz unique noise xyz', new Date('2026-08-30T10:00:00Z'))

  const embedder = new FakeEmbedder()
  const results = await searchByTopic(
    handle.db,
    embedder,
    conversationId,
    FROM,
    TO,
    'completely different topic abc',
  )

  expect(results).toEqual([])
})
