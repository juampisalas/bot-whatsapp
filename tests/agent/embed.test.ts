import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { embedMissing } from '../../src/agent/embed.ts'
import { FakeEmbedder } from '../../src/agent/llm/fake-embedder.ts'
import { upsertConversation } from '../../src/store/repositories/conversations.ts'
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

async function seedConversation(): Promise<string> {
  return upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'embed-conv',
    kind: 'group',
    name: 'Embed Test',
  })
}

async function seedMessage(
  conversationId: string,
  externalId: string,
  text: string,
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
  return id
}

test('embedMissing embeds three messages in one batch', async () => {
  const conversationId = await seedConversation()
  await seedMessage(conversationId, 'm1', 'alpha', new Date('2026-08-30T10:00:00Z'))
  await seedMessage(conversationId, 'm2', 'beta', new Date('2026-08-30T11:00:00Z'))
  await seedMessage(conversationId, 'm3', 'gamma', new Date('2026-08-30T12:00:00Z'))

  const fake = new FakeEmbedder()
  const count = await embedMissing(handle.db, fake, conversationId, FROM, TO)

  expect(count).toBe(3)
  expect(fake.calls).toHaveLength(1)
  expect(fake.calls[0]).toHaveLength(3)

  const rows = await handle.db
    .select({ embeddedAt: messages.embeddedAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
  expect(rows.every((row) => row.embeddedAt != null)).toBe(true)
})

test('embedMissing is a no-op when everything is already embedded', async () => {
  const conversationId = await seedConversation()
  await seedMessage(conversationId, 'm1', 'alpha', new Date('2026-08-30T10:00:00Z'))
  await seedMessage(conversationId, 'm2', 'beta', new Date('2026-08-30T11:00:00Z'))
  await seedMessage(conversationId, 'm3', 'gamma', new Date('2026-08-30T12:00:00Z'))

  const first = new FakeEmbedder()
  await embedMissing(handle.db, first, conversationId, FROM, TO)

  const second = new FakeEmbedder()
  const count = await embedMissing(handle.db, second, conversationId, FROM, TO)

  expect(count).toBe(0)
  expect(second.calls).toHaveLength(0)
})

test('embedMissing only embeds a new message in range', async () => {
  const conversationId = await seedConversation()
  await seedMessage(conversationId, 'm1', 'alpha', new Date('2026-08-30T10:00:00Z'))
  await seedMessage(conversationId, 'm2', 'beta', new Date('2026-08-30T11:00:00Z'))

  const first = new FakeEmbedder()
  await embedMissing(handle.db, first, conversationId, FROM, TO)

  await seedMessage(conversationId, 'm3', 'gamma', new Date('2026-08-30T12:00:00Z'))

  const second = new FakeEmbedder()
  const count = await embedMissing(handle.db, second, conversationId, FROM, TO)

  expect(count).toBe(1)
  expect(second.calls).toHaveLength(1)
  expect(second.calls[0]).toEqual(['gamma'])
})

test('embedMissing ignores messages outside the range', async () => {
  const conversationId = await seedConversation()
  await seedMessage(conversationId, 'outside', 'later', new Date('2026-08-31T10:00:00Z'))

  const fake = new FakeEmbedder()
  const count = await embedMissing(handle.db, fake, conversationId, FROM, TO)

  expect(count).toBe(0)
  expect(fake.calls).toHaveLength(0)
})

test('wrong embedding dimensions throw and leave embeddedAt null', async () => {
  const conversationId = await seedConversation()
  const messageId = await seedMessage(
    conversationId,
    'bad-dims',
    'oops',
    new Date('2026-08-30T10:00:00Z'),
  )

  const fake = new FakeEmbedder()
  fake.forceNextDimensions(8)

  await expect(embedMissing(handle.db, fake, conversationId, FROM, TO)).rejects.toThrow(
    /dimension mismatch/i,
  )

  const [row] = await handle.db
    .select({ embeddedAt: messages.embeddedAt, embedding: messages.embedding })
    .from(messages)
    .where(eq(messages.id, messageId))

  expect(row?.embeddedAt).toBeNull()
  expect(row?.embedding).toBeNull()
})
