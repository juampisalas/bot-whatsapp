import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import { MAX_DOWNLOAD_ATTEMPTS } from '../../src/capture/media.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { attachments, messages } from '../../src/store/schema.ts'
import { mensaje } from '../helpers/fixtures.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

function setup() {
  const provider = new FakeProvider()
  const pipeline = createIngestPipeline({
    db: handle.db,
    provider,
    policy: { mode: 'all', rules: new Set() },
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  return { provider }
}

function messageWithAttachment(externalId = 'media-1') {
  return mensaje({
    attachments: [
      {
        externalId,
        kind: 'audio',
        mimeType: 'audio/ogg',
        sizeBytes: 1024,
        durationMs: 45000,
      },
    ],
  })
}

beforeAll(async () => {
  await runMigrations(url)
})

beforeEach(async () => {
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
  await handle.close()
})

test('marca el adjunto descargado con la ruta y el tamaño realmente descargado', async () => {
  const { provider } = setup()
  await provider.connect()

  await provider.inject(messageWithAttachment())

  const rows = await handle.db
    .select({
      status: attachments.downloadStatus,
      localPath: attachments.localPath,
      sizeBytes: attachments.sizeBytes,
      attempts: attachments.downloadAttempts,
      error: attachments.downloadError,
    })
    .from(attachments)
  expect(rows).toEqual([
    {
      status: 'ok',
      localPath: '/tmp/fake/media-1',
      sizeBytes: 4096,
      attempts: 0,
      error: null,
    },
  ])
})

test('un fallo de descarga conserva el mensaje y registra el intento fallido', async () => {
  const { provider } = setup()
  provider.failNextDownload(new Error('medio vencido'))
  await provider.connect()

  await provider.inject(messageWithAttachment())

  expect(await handle.db.select({ id: messages.id }).from(messages)).toHaveLength(1)
  const rows = await handle.db
    .select({
      status: attachments.downloadStatus,
      attempts: attachments.downloadAttempts,
      error: attachments.downloadError,
      localPath: attachments.localPath,
    })
    .from(attachments)
  expect(rows).toEqual([
    {
      status: 'failed',
      attempts: 1,
      error: 'medio vencido',
      localPath: null,
    },
  ])
})

test('una reentrega no vuelve a descargar un adjunto que ya está en ok', async () => {
  const { provider } = setup()
  const message = messageWithAttachment()
  await provider.connect()

  await provider.inject(message)
  await provider.inject(message)

  expect(provider.downloads).toHaveLength(1)
  expect(provider.downloads[0]?.attachmentExternalId).toBe('media-1')
})

test('una reentrega reintenta un adjunto fallido antes de agotar el tope', async () => {
  const { provider } = setup()
  const message = messageWithAttachment()
  provider.failNextDownload(new Error('fallo transitorio'))
  await provider.connect()

  await provider.inject(message)
  await provider.inject(message)

  expect(provider.downloads).toHaveLength(2)
  const rows = await handle.db
    .select({
      status: attachments.downloadStatus,
      attempts: attachments.downloadAttempts,
      localPath: attachments.localPath,
    })
    .from(attachments)
  expect(rows).toEqual([
    {
      status: 'ok',
      attempts: 1,
      localPath: '/tmp/fake/media-1',
    },
  ])
})

test('deja de reintentar una descarga al agotar el tope', async () => {
  const { provider } = setup()
  const message = messageWithAttachment()
  await provider.connect()

  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    provider.failNextDownload(new Error(`fallo ${attempt + 1}`))
    await provider.inject(message)
  }
  await provider.inject(message)

  expect(provider.downloads).toHaveLength(MAX_DOWNLOAD_ATTEMPTS)
  const rows = await handle.db
    .select({
      status: attachments.downloadStatus,
      attempts: attachments.downloadAttempts,
      error: attachments.downloadError,
    })
    .from(attachments)
  expect(rows).toEqual([
    {
      status: 'failed',
      attempts: MAX_DOWNLOAD_ATTEMPTS,
      error: `fallo ${MAX_DOWNLOAD_ATTEMPTS}`,
    },
  ])
})
