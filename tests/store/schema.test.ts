import { test, expect, beforeAll, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import {
  botMessages,
  capturePolicy,
  conversations,
  messages,
  outboundMessages,
  pendingClarifications,
} from '../../src/store/schema.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

beforeAll(async () => {
  await runMigrations(url)
})

afterAll(async () => {
  await handle.close()
})

test('lists all public tables', async () => {
  const rows = await handle.sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `
  const names = rows.map((r) => r.table_name).sort()
  expect(names).toEqual([
    'attachments',
    'bot_messages',
    'capture_policy',
    'capture_rules',
    'conversations',
    'messages',
    'outbound_messages',
    'participants',
    'pending_clarifications',
  ])
})

test('embedding column has 768 dimensions', async () => {
  const rows = await handle.sql<{ atttypmod: number }[]>`
    SELECT atttypmod FROM pg_attribute
    WHERE attrelid = 'messages'::regclass AND attname = 'embedding'
  `
  expect(rows[0]?.atttypmod).toBe(768)
})

test('a message is unique by provider and external id', async () => {
  await handle.sql`TRUNCATE TABLE attachments, messages, conversations`
  try {
    const [conversation] = await handle.db
      .insert(conversations)
      .values({
        provider: 'whatsapp',
        externalId: 'schema-test-conversation',
        kind: 'group',
      })
      .returning({ id: conversations.id })

    if (!conversation) throw new Error('Failed to create test conversation')

    const duplicateMessage = {
      provider: 'whatsapp' as const,
      externalId: 'schema-test-message',
      conversationId: conversation.id,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      fromSelf: false,
    }

    await handle.db.insert(messages).values(duplicateMessage)
    const duplicateInsert = Promise.resolve(handle.db.insert(messages).values(duplicateMessage))
    await expect(duplicateInsert).rejects.toThrow()
  } finally {
    await handle.sql`TRUNCATE TABLE attachments, messages, conversations`
  }
})

test('capture policy only allows the row with id 1', async () => {
  await handle.sql`TRUNCATE TABLE capture_policy`
  try {
    await handle.db.insert(capturePolicy).values({ id: 1 })
    const secondPolicyInsert = Promise.resolve(handle.db.insert(capturePolicy).values({ id: 2 }))
    await expect(secondPolicyInsert).rejects.toThrow()
  } finally {
    await handle.sql`TRUNCATE TABLE capture_policy`
  }
})

test('outbound_messages, bot_messages, and pending_clarifications accept a row', async () => {
  await handle.sql`
    TRUNCATE TABLE bot_messages, pending_clarifications, outbound_messages,
      attachments, messages, conversations
  `
  try {
    const [conversation] = await handle.db
      .insert(conversations)
      .values({ provider: 'fake', externalId: 'ctrl', kind: 'group', name: 'Control' })
      .returning({ id: conversations.id })

    const [out] = await handle.db
      .insert(outboundMessages)
      .values({
        provider: 'fake',
        conversationExternalId: 'ctrl',
        text: '✦ hello',
        idempotencyKey: 'idemp-1',
        status: 'pending',
      })
      .returning({ id: outboundMessages.id, status: outboundMessages.status })

    await handle.db.insert(botMessages).values({
      provider: 'fake',
      externalId: 'bot-1',
      outboundId: out!.id,
    })

    await handle.db.insert(pendingClarifications).values({
      provider: 'fake',
      conversationExternalId: 'ctrl',
      originalText: 'summarize that',
      question: 'Which group?',
      expiresAt: new Date('2026-08-31T00:00:00Z'),
    })

    expect(out?.status).toBe('pending')
    expect(conversation?.id).toBeDefined()
  } finally {
    await handle.sql`
      TRUNCATE TABLE bot_messages, pending_clarifications, outbound_messages,
        attachments, messages, conversations
    `
  }
})
