import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { loadCapturePolicy } from '../../src/store/repositories/capture-policy.ts'
import { capturePolicy, captureRules } from '../../src/store/schema.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

async function cleanCapturePolicy(): Promise<void> {
  await handle.sql`TRUNCATE capture_rules, capture_policy RESTART IDENTITY CASCADE`
}

beforeAll(async () => {
  await runMigrations(url)
})

beforeEach(cleanCapturePolicy)
afterEach(cleanCapturePolicy)

afterAll(async () => {
  await cleanCapturePolicy()
  await handle.close()
})

test('sin fila de política usa el modo all', async () => {
  const policy = await loadCapturePolicy(handle.db, 'fake')

  expect(policy.mode).toBe('all')
})

test('lee el modo de la fila de política', async () => {
  await handle.db.insert(capturePolicy).values({ mode: 'whitelist' })

  const policy = await loadCapturePolicy(handle.db, 'fake')

  expect(policy.mode).toBe('whitelist')
})

test('devuelve solo las reglas del proveedor solicitado', async () => {
  await handle.db.insert(captureRules).values([
    { provider: 'fake', conversationExternalId: 'fake-incluida' },
    { provider: 'whatsapp', conversationExternalId: 'whatsapp-excluida' },
  ])

  const policy = await loadCapturePolicy(handle.db, 'fake')

  expect(policy.rules).toEqual(new Set(['fake-incluida']))
})
