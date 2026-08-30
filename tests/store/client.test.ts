// tests/store/client.test.ts
import { test, expect, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

afterAll(async () => {
  await handle.close()
})

test('conecta y responde una consulta trivial', async () => {
  const rows = await handle.sql`SELECT 1 AS uno`
  expect(rows[0]?.uno).toBe(1)
})

test('la extensión vector está habilitada', async () => {
  const rows = await handle.sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`
  expect(rows).toHaveLength(1)
})
