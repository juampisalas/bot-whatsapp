import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  getDerivation,
  upsertDerivation,
} from '../../src/store/repositories/derivations.ts'
import { insertAttachments } from '../../src/store/repositories/attachments.ts'
import { upsertConversation } from '../../src/store/repositories/conversations.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { attachmentDerivations, attachments } from '../../src/store/schema.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

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

async function seedAttachment(): Promise<string> {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'deriv-conv',
    kind: 'group',
    name: 'Test',
  })
  const { id: messageId } = await insertMessage(handle.db, {
    provider: 'fake',
    externalId: 'deriv-msg',
    conversationId,
    participantId: null,
    sentAt: new Date('2026-08-30T12:00:00Z'),
    fromSelf: false,
    text: null,
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: { ok: true },
  })
  await insertAttachments(handle.db, messageId, [
    {
      externalId: 'att-1',
      kind: 'audio',
      mimeType: 'audio/ogg',
      sizeBytes: 100,
      durationMs: 45000,
    },
  ])
  const rows = await handle.db.select({ id: attachments.id }).from(attachments)
  const id = rows[0]?.id
  if (!id) throw new Error('attachment not inserted')
  return id
}

test('getDerivation returns null when missing and text after upsert', async () => {
  const attachmentId = await seedAttachment()

  expect(await getDerivation(handle.db, attachmentId, 'transcript', 'fake-media')).toBeNull()

  await upsertDerivation(handle.db, {
    attachmentId,
    kind: 'transcript',
    model: 'fake-media',
    text: 'hello juan',
  })

  expect(await getDerivation(handle.db, attachmentId, 'transcript', 'fake-media')).toBe('hello juan')
  expect(await getDerivation(handle.db, attachmentId, 'transcript', 'other-model')).toBeNull()
})

test('upsertDerivation updates text on conflict', async () => {
  const attachmentId = await seedAttachment()

  await upsertDerivation(handle.db, {
    attachmentId,
    kind: 'transcript',
    model: 'fake-media',
    text: 'first',
  })
  await upsertDerivation(handle.db, {
    attachmentId,
    kind: 'transcript',
    model: 'fake-media',
    text: 'second',
  })

  const rows = await handle.db
    .select({ text: attachmentDerivations.text })
    .from(attachmentDerivations)
    .where(eq(attachmentDerivations.attachmentId, attachmentId))

  expect(rows).toHaveLength(1)
  expect(rows[0]?.text).toBe('second')
})
