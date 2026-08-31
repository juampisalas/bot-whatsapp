import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FakeEmbedder } from '../../src/agent/llm/fake-embedder.ts'
import { upsertConversation } from '../../src/store/repositories/conversations.ts'
import { searchSimilar } from '../../src/store/repositories/embeddings.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { messages } from '../../src/store/schema.ts'
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

async function seedConversation(externalId: string): Promise<string> {
  return upsertConversation(handle.db, {
    provider: 'fake',
    externalId,
    kind: 'group',
    name: externalId,
  })
}

async function seedEmbeddedMessage(
  conversationId: string,
  externalId: string,
  text: string,
  embedding: number[],
  sentAt: Date,
): Promise<string> {
  const { id } = await insertMessage(handle.db, {
    provider: 'fake',
    externalId,
    conversationId,
    participantId: null,
    sentAt,
    fromSelf: false,
    text,
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: { ok: true },
  })
  await handle.db
    .update(messages)
    .set({ embedding, embeddedAt: new Date('2026-08-30T12:00:00Z') })
    .where(eq(messages.id, id))
  return id
}

test('searchSimilar ranks closest vector first and scopes by conversation', async () => {
  const fake = new FakeEmbedder()
  const [query] = await fake.embed(['topic about cats'])
  const [near] = await fake.embed(['topic about cats'])
  const [mid] = await fake.embed(['topic about dogs'])
  const [far] = await fake.embed(['totally unrelated weather'])

  const conversationId = await seedConversation('sim-main')
  const otherId = await seedConversation('sim-other')

  const nearId = await seedEmbeddedMessage(
    conversationId,
    'near',
    'cats',
    near!,
    new Date('2026-08-30T10:00:00Z'),
  )
  const midId = await seedEmbeddedMessage(
    conversationId,
    'mid',
    'dogs',
    mid!,
    new Date('2026-08-30T11:00:00Z'),
  )
  await seedEmbeddedMessage(
    conversationId,
    'far',
    'weather',
    far!,
    new Date('2026-08-30T12:00:00Z'),
  )
  const otherNearId = await seedEmbeddedMessage(
    otherId,
    'other-near',
    'cats elsewhere',
    near!,
    new Date('2026-08-30T10:30:00Z'),
  )

  const results = await searchSimilar(handle.db, conversationId, FROM, TO, query!, 20)

  expect(results.length).toBeGreaterThanOrEqual(1)
  expect(results[0]?.id).toBe(nearId)
  expect(results.map((row) => row.id)).not.toContain(otherNearId)
  if (results.some((row) => row.id === midId)) {
    expect(results.findIndex((row) => row.id === nearId)).toBeLessThan(
      results.findIndex((row) => row.id === midId),
    )
  }
})
