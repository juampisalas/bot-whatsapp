import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import type { Logger } from '../../src/domain/logger.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { attachments, messages } from '../../src/store/schema.ts'
import { mensaje } from '../helpers/fixtures.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

async function removeInsertFailure(): Promise<void> {
  const triggerRows = await handle.sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgname = 'fail_ingest_message_insert'
        AND tgrelid = 'messages'::regclass
    ) AS exists
  `
  if (triggerRows[0]?.exists) {
    await handle.sql`DROP TRIGGER fail_ingest_message_insert ON messages`
  }

  const functionRows = await handle.sql<{ exists: boolean }[]>`
    SELECT to_regprocedure('fail_ingest_message_insert()') IS NOT NULL AS exists
  `
  if (functionRows[0]?.exists) {
    await handle.sql`DROP FUNCTION fail_ingest_message_insert()`
  }
}

async function installInsertFailure(): Promise<void> {
  await handle.sql`
    CREATE OR REPLACE FUNCTION fail_ingest_message_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'forced ingest message failure';
    END;
    $$
  `
  // `OR REPLACE` evita que un run interrumpido deje un objeto que bloquee los siguientes.
  await handle.sql`
    CREATE OR REPLACE TRIGGER fail_ingest_message_insert
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION fail_ingest_message_insert()
  `
}

function createPipeline(log?: Logger) {
  return createIngestPipeline({
    db: handle.db,
    policy: { mode: 'all', rules: new Set() },
    bufferMax: 10,
    log,
  })
}

beforeAll(async () => {
  await runMigrations(url)
})

beforeEach(async () => {
  await removeInsertFailure()
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await removeInsertFailure()
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
  await handle.close()
})

test('persiste un mensaje entrante de punta a punta', async () => {
  const provider = new FakeProvider()
  const pipeline = createPipeline()
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(mensaje({ text: 'hola gente' }))

  const rows = await handle.db
    .select({ text: messages.text, fromSelf: messages.fromSelf })
    .from(messages)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.text).toBe('hola gente')
  expect(rows[0]?.fromSelf).toBe(false)
})

test('no persiste conversaciones excluidas por la política', async () => {
  const provider = new FakeProvider()
  const pipeline = createIngestPipeline({
    db: handle.db,
    policy: { mode: 'blacklist', rules: new Set(['c1']) },
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(mensaje())

  expect(await handle.db.select({ id: messages.id }).from(messages)).toHaveLength(0)
})

test('reentregar el mismo mensaje no lo duplica', async () => {
  const provider = new FakeProvider()
  const pipeline = createPipeline()
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(mensaje())
  await provider.inject(mensaje())

  expect(await handle.db.select({ id: messages.id }).from(messages)).toHaveLength(1)
})

test('registra los adjuntos con estado pendiente', async () => {
  const provider = new FakeProvider()
  const pipeline = createPipeline()
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(
    mensaje({
      attachments: [
        { externalId: 'a1', kind: 'audio', mimeType: 'audio/ogg', sizeBytes: 1024, durationMs: 45000 },
      ],
    }),
  )

  const rows = await handle.db
    .select({
      kind: attachments.kind,
      durationMs: attachments.durationMs,
      downloadStatus: attachments.downloadStatus,
    })
    .from(attachments)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.kind).toBe('audio')
  expect(rows[0]?.durationMs).toBe(45000)
  expect(rows[0]?.downloadStatus).toBe('pending')
})

test('un fallo al persistir encola el mensaje y no rechaza', async () => {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
  const log: Logger = {
    info: () => {},
    warn: (message, meta) => warnings.push({ message, meta }),
    error: () => {},
  }
  const pipeline = createPipeline(log)
  await installInsertFailure()

  try {
    await expect(pipeline.handle(mensaje({ externalId: 'm-buffered' }))).resolves.toBeUndefined()
  } finally {
    await removeInsertFailure()
  }

  expect(await handle.db.select({ id: messages.id }).from(messages)).toHaveLength(0)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.message).toBe('no se pudo persistir, mensaje en buffer')
  expect(warnings[0]?.meta?.enBuffer).toBe(1)
})

test('flushBuffer persiste lo encolado cuando la base se recupera', async () => {
  const pipeline = createPipeline()
  await installInsertFailure()
  try {
    await pipeline.handle(mensaje({ externalId: 'm-recovered' }))
  } finally {
    await removeInsertFailure()
  }

  expect(await pipeline.flushBuffer()).toBe(1)
  const rows = await handle.db.select({ externalId: messages.externalId }).from(messages)
  expect(rows).toEqual([{ externalId: 'm-recovered' }])
})

test('flushBuffer conserva el mensaje si el reintento también falla', async () => {
  const pipeline = createPipeline()
  await installInsertFailure()
  try {
    await pipeline.handle(mensaje({ externalId: 'm-requeued' }))
    expect(await pipeline.flushBuffer()).toBe(0)
    expect(await handle.db.select({ id: messages.id }).from(messages)).toHaveLength(0)
  } finally {
    await removeInsertFailure()
  }

  expect(await pipeline.flushBuffer()).toBe(1)
  const rows = await handle.db.select({ externalId: messages.externalId }).from(messages)
  expect(rows).toEqual([{ externalId: 'm-requeued' }])
})
