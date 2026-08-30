import { test, expect, beforeAll, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'

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
  const names = rows.map((r) => r.table_name)
  for (const expected of [
    'conversations',
    'participants',
    'messages',
    'attachments',
    'capture_policy',
    'capture_rules',
  ]) {
    expect(names).toContain(expected)
  }
})

test('la columna embedding tiene 768 dimensiones', async () => {
  const rows = await handle.sql<{ atttypmod: number }[]>`
    SELECT atttypmod FROM pg_attribute
    WHERE attrelid = 'messages'::regclass AND attname = 'embedding'
  `
  expect(rows[0]?.atttypmod).toBe(768)
})

test('un mensaje es único por proveedor e id externo', async () => {
  const rows = await handle.sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'messages' AND indexname = 'messages_provider_external_id_idx'
  `
  expect(rows[0]?.indexdef).toContain('UNIQUE')
})
