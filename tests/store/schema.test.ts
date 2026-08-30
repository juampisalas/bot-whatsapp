import { test, expect, beforeAll, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { capturePolicy, conversations, messages } from '../../src/store/schema.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

beforeAll(async () => {
  await runMigrations(url)
})

afterAll(async () => {
  await handle.close()
})

test('existen todas las tablas del plan', async () => {
  const rows = await handle.sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `
  const names = rows.map((r) => r.table_name).sort()
  expect(names).toEqual([
    'attachments',
    'capture_policy',
    'capture_rules',
    'conversations',
    'messages',
    'participants',
  ])
})

test('la columna embedding tiene 768 dimensiones', async () => {
  const rows = await handle.sql<{ atttypmod: number }[]>`
    SELECT atttypmod FROM pg_attribute
    WHERE attrelid = 'messages'::regclass AND attname = 'embedding'
  `
  expect(rows[0]?.atttypmod).toBe(768)
})

test('un mensaje es único por proveedor e id externo', async () => {
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

    if (!conversation) throw new Error('No se creó la conversación de prueba')

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

test('la política de captura solo admite la fila con id 1', async () => {
  await handle.sql`TRUNCATE TABLE capture_policy`
  try {
    await handle.db.insert(capturePolicy).values({ id: 1 })
    const secondPolicyInsert = Promise.resolve(handle.db.insert(capturePolicy).values({ id: 2 }))
    await expect(secondPolicyInsert).rejects.toThrow()
  } finally {
    await handle.sql`TRUNCATE TABLE capture_policy`
  }
})
