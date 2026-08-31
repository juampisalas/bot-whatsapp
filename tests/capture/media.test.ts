import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import {
  createMediaDownloader,
  MAX_DOWNLOAD_ATTEMPTS,
} from '../../src/capture/media.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { insertAttachments } from '../../src/store/repositories/attachments.ts'
import { attachments, messages } from '../../src/store/schema.ts'
import { mensaje } from '../helpers/fixtures.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

async function removeSuccessUpdateFailure(): Promise<void> {
  const triggerRows = await handle.sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgname = 'fail_attachment_success_update'
        AND tgrelid = 'attachments'::regclass
    ) AS exists
  `
  if (triggerRows[0]?.exists) {
    await handle.sql`DROP TRIGGER fail_attachment_success_update ON attachments`
  }

  const functionRows = await handle.sql<{ exists: boolean }[]>`
    SELECT to_regprocedure('fail_attachment_success_update()') IS NOT NULL AS exists
  `
  if (functionRows[0]?.exists) {
    await handle.sql`DROP FUNCTION fail_attachment_success_update()`
  }
}

async function installSuccessUpdateFailure(): Promise<void> {
  await handle.sql`
    CREATE FUNCTION fail_attachment_success_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.download_status = 'ok' THEN
        RAISE EXCEPTION 'forced attachment success update failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `
  await handle.sql`
    CREATE TRIGGER fail_attachment_success_update
    BEFORE UPDATE ON attachments
    FOR EACH ROW
    EXECUTE FUNCTION fail_attachment_success_update()
  `
}

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

async function setupDirectDownloader() {
  const { provider } = setup()
  const message = messageWithAttachment()
  await provider.connect()
  await provider.inject({ ...message, attachments: [] })
  const [storedMessage] = await handle.db.select({ id: messages.id }).from(messages)
  if (!storedMessage) throw new Error('el mensaje de prueba no se persistió')
  await insertAttachments(handle.db, storedMessage.id, message.attachments)
  return {
    provider,
    message,
    download: createMediaDownloader({ db: handle.db, provider }),
    messageId: storedMessage.id,
  }
}

beforeAll(async () => {
  await runMigrations(url)
})

beforeEach(async () => {
  await removeSuccessUpdateFailure()
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await removeSuccessUpdateFailure()
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

test('el error de descarga que se persiste conserva la causa envuelta', async () => {
  const { provider } = setup()
  provider.failNextDownload(
    new Error('no se pudo bajar el medio', { cause: new Error('ECONNRESET') }),
  )
  await provider.connect()

  await provider.inject(messageWithAttachment())

  // Este texto queda guardado en la fila: si se pierde la causa, quien mire después no
  // tiene con qué distinguir un medio vencido de la red caída.
  const rows = await handle.db.select({ error: attachments.downloadError }).from(attachments)
  expect(rows[0]?.error).toBe('no se pudo bajar el medio: ECONNRESET')
})

test('un fallo al registrar el éxito no agota el intento y permite recuperarlo', async () => {
  const { provider } = setup()
  const message = messageWithAttachment()
  await provider.connect()

  for (let attempt = 1; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    provider.failNextDownload(new Error(`fallo previo ${attempt}`))
    await provider.inject(message)
  }

  await installSuccessUpdateFailure()
  try {
    await provider.inject(message)
  } finally {
    await removeSuccessUpdateFailure()
  }
  await provider.inject(message)

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
      attempts: MAX_DOWNLOAD_ATTEMPTS - 1,
      localPath: '/tmp/fake/media-1',
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

test('dos entregas concurrentes comparten una sola descarga', async () => {
  const { provider, message, download, messageId } = await setupDirectDownloader()
  const barrier = provider.blockDownloads()
  provider.failNextDownload(new Error('fallo compartido'))
  provider.failNextDownload(new Error('fallo que no debe consumirse'))

  const deliveries = Promise.all([download(message, messageId), download(message, messageId)])
  await barrier.entered
  barrier.release()
  await deliveries

  expect(provider.downloads).toHaveLength(1)
  const rows = await handle.db
    .select({ attempts: attachments.downloadAttempts })
    .from(attachments)
  expect(rows).toEqual([{ attempts: 1 }])
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

test('entregas concurrentes no exceden el tope de intentos', async () => {
  const { provider, message, download, messageId } = await setupDirectDownloader()

  for (let attempt = 1; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    provider.failNextDownload(new Error(`fallo previo ${attempt}`))
    await download(message, messageId)
  }

  const barrier = provider.blockDownloads()
  provider.failNextDownload(new Error('fallo concurrente 1'))
  provider.failNextDownload(new Error('fallo concurrente 2'))
  const deliveries = Promise.all([download(message, messageId), download(message, messageId)])
  await barrier.entered
  barrier.release()
  await deliveries

  expect(provider.downloads).toHaveLength(MAX_DOWNLOAD_ATTEMPTS)
  const rows = await handle.db
    .select({
      status: attachments.downloadStatus,
      attempts: attachments.downloadAttempts,
    })
    .from(attachments)
  expect(rows).toEqual([{ status: 'failed', attempts: MAX_DOWNLOAD_ATTEMPTS }])
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
