import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { enrichRange } from '../../src/agent/media/enrich.ts'
import { FakeMediaModel } from '../../src/agent/media/fake.ts'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { getDerivation } from '../../src/store/repositories/derivations.ts'
import {
  attachmentDerivations,
  attachments,
  conversations,
  messages,
} from '../../src/store/schema.ts'
import type { AttachmentKind } from '../../src/domain/types.ts'
import { mensaje } from '../helpers/fixtures.ts'
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

function attachmentOf(kind: AttachmentKind, externalId = 'media-1') {
  return {
    externalId,
    kind,
    mimeType: kind === 'audio' ? 'audio/ogg' : kind === 'image' ? 'image/jpeg' : 'application/octet-stream',
    sizeBytes: 1024,
    durationMs: kind === 'audio' || kind === 'video' ? 45000 : null,
  }
}

async function ingestWith(
  provider: FakeProvider,
  kind: AttachmentKind = 'audio',
  externalId = 'media-1',
): Promise<{ conversationId: string; attachmentId: string; localPath: string }> {
  const pipeline = createIngestPipeline({
    db: handle.db,
    provider,
    policy: { mode: 'all', rules: new Set() },
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()
  await provider.inject(
    mensaje({
      externalId: `msg-${externalId}`,
      attachments: [attachmentOf(kind, externalId)],
      sentAt: new Date('2026-08-30T12:00:00Z'),
    }),
  )

  const [conversation] = await handle.db.select({ id: conversations.id }).from(conversations)
  const [attachment] = await handle.db
    .select({
      id: attachments.id,
      localPath: attachments.localPath,
      status: attachments.downloadStatus,
    })
    .from(attachments)

  if (!conversation || !attachment) throw new Error('ingest did not persist attachment')
  return {
    conversationId: conversation.id,
    attachmentId: attachment.id,
    localPath: attachment.localPath ?? `/tmp/fake/${externalId}`,
  }
}

test('1: audio without derivation calls transcribe and creates a row', async () => {
  const provider = new FakeProvider()
  const media = new FakeMediaModel()
  const { conversationId, attachmentId, localPath } = await ingestWith(provider, 'audio')
  media.enqueueTranscript(localPath, 'hello from audio')

  await enrichRange(handle.db, provider, media, conversationId, FROM, TO)

  expect(media.calls).toEqual([{ method: 'transcribe', path: localPath, mime: 'audio/ogg' }])
  expect(await getDerivation(handle.db, attachmentId, 'transcript', media.model)).toBe(
    'hello from audio',
  )
})

test('2: second enrichRange makes zero media calls', async () => {
  const provider = new FakeProvider()
  const media = new FakeMediaModel()
  const { conversationId, localPath } = await ingestWith(provider, 'audio')
  media.enqueueTranscript(localPath, 'cached')

  await enrichRange(handle.db, provider, media, conversationId, FROM, TO)
  media.calls.length = 0

  await enrichRange(handle.db, provider, media, conversationId, FROM, TO)

  expect(media.calls).toHaveLength(0)
})

test('3: image calls describe', async () => {
  const provider = new FakeProvider()
  const media = new FakeMediaModel()
  const { conversationId, attachmentId, localPath } = await ingestWith(provider, 'image')
  media.enqueueDescribe(localPath, 'whiteboard with dates')

  await enrichRange(handle.db, provider, media, conversationId, FROM, TO)

  expect(media.calls).toEqual([{ method: 'describe', path: localPath, mime: 'image/jpeg' }])
  expect(await getDerivation(handle.db, attachmentId, 'description', media.model)).toBe(
    'whiteboard with dates',
  )
})

test('4: video document sticker make zero media calls', async () => {
  for (const kind of ['video', 'document', 'sticker'] as const) {
    await resetTestDb(handle.sql)
    const provider = new FakeProvider()
    const media = new FakeMediaModel()
    const { conversationId } = await ingestWith(provider, kind, `skip-${kind}`)

    await enrichRange(handle.db, provider, media, conversationId, FROM, TO)

    expect(media.calls).toHaveLength(0)
    expect(await handle.db.select().from(attachmentDerivations)).toHaveLength(0)
  }
})

test('5: transcribe throw yields zero rows and does not propagate', async () => {
  const provider = new FakeProvider()
  const media = new FakeMediaModel()
  const { conversationId, localPath } = await ingestWith(provider, 'audio')
  media.enqueueTranscriptError(localPath, new Error('model down'))

  await enrichRange(handle.db, provider, media, conversationId, FROM, TO)

  expect(media.calls).toHaveLength(1)
  expect(await handle.db.select().from(attachmentDerivations)).toHaveLength(0)
})

test('6: failed attachment with attempts=1 retries download then transcribes', async () => {
  const provider = new FakeProvider()
  provider.failNextDownload(new Error('expired media'))
  const media = new FakeMediaModel()
  const { conversationId, attachmentId } = await ingestWith(provider, 'audio', 'retry-1')

  const before = await handle.db
    .select({
      status: attachments.downloadStatus,
      attempts: attachments.downloadAttempts,
      localPath: attachments.localPath,
    })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
  expect(before[0]).toEqual({ status: 'failed', attempts: 1, localPath: null })

  const localPath = '/tmp/fake/retry-1'
  media.enqueueTranscript(localPath, 'recovered transcript')
  const downloadsBefore = provider.downloads.length

  await enrichRange(handle.db, provider, media, conversationId, FROM, TO)

  expect(provider.downloads.length).toBe(downloadsBefore + 1)
  const after = await handle.db
    .select({
      status: attachments.downloadStatus,
      localPath: attachments.localPath,
    })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
  expect(after[0]?.status).toBe('ok')
  expect(after[0]?.localPath).toBe(localPath)
  expect(media.calls).toEqual([{ method: 'transcribe', path: localPath, mime: 'audio/ogg' }])
  expect(await getDerivation(handle.db, attachmentId, 'transcript', media.model)).toBe(
    'recovered transcript',
  )
})

test('7: failed attachment with attempts=3 skips download and transcribe', async () => {
  const provider = new FakeProvider()
  provider.failNextDownload(new Error('fail 1'))
  provider.failNextDownload(new Error('fail 2'))
  provider.failNextDownload(new Error('fail 3'))
  const media = new FakeMediaModel()

  const pipeline = createIngestPipeline({
    db: handle.db,
    provider,
    policy: { mode: 'all', rules: new Set() },
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  const message = mensaje({
    externalId: 'msg-max-attempts',
    attachments: [attachmentOf('audio', 'max-3')],
    sentAt: new Date('2026-08-30T12:00:00Z'),
  })
  await provider.inject(message)

  // Two more download attempts via redelivery / direct path: bump attempts to 3.
  const [stored] = await handle.db.select({ id: messages.id }).from(messages)
  if (!stored) throw new Error('message missing')
  const { createMediaDownloader } = await import('../../src/capture/media.ts')
  const download = createMediaDownloader({ db: handle.db, provider })
  await download(message, stored.id)
  await download(message, stored.id)

  const [attachment] = await handle.db
    .select({
      id: attachments.id,
      status: attachments.downloadStatus,
      attempts: attachments.downloadAttempts,
    })
    .from(attachments)
  expect(attachment?.status).toBe('failed')
  expect(attachment?.attempts).toBe(3)

  const [conversation] = await handle.db.select({ id: conversations.id }).from(conversations)
  if (!conversation || !attachment) throw new Error('setup incomplete')

  const downloadsBefore = provider.downloads.length
  await enrichRange(handle.db, provider, media, conversation.id, FROM, TO)

  expect(provider.downloads.length).toBe(downloadsBefore)
  expect(media.calls).toHaveLength(0)
  expect(await handle.db.select().from(attachmentDerivations)).toHaveLength(0)
})
