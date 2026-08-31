// tests/store/client.test.ts
import { test, expect, afterAll, spyOn } from 'bun:test'
import { createDb, handlePostgresNotice } from '../../src/store/client.ts'

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

test('suprime notices benignos de DDL idempotente', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    handlePostgresNotice({ code: '42710', severity: 'NOTICE', message: 'already exists' })
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

test('reenvía notices no benignos con contexto diagnóstico', () => {
  const notice = {
    code: '01000',
    severity: 'WARNING',
    message: 'something happened',
    detail: 'extra detail',
    hint: 'try this',
  }
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    handlePostgresNotice(notice)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(notice)
  } finally {
    warn.mockRestore()
  }
})
