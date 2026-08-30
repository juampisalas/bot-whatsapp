import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { conversations, participants } from '../../src/store/schema.ts'
import { upsertConversation, upsertParticipant } from '../../src/store/repositories/conversations.ts'
import { countMessagesInConversation, insertMessage } from '../../src/store/repositories/messages.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

beforeAll(async () => {
  await runMigrations(url)
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await handle.sql`DROP TRIGGER IF EXISTS fail_atomic_message_update ON conversations`
  await handle.sql`DROP FUNCTION IF EXISTS fail_atomic_message_update()`
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
  await handle.close()
})

test('upsertConversation devuelve el mismo id al repetir', async () => {
  const primero = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-repeated-id',
    kind: 'group',
    name: 'Grupo Facu',
  })
  const segundo = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-repeated-id',
    kind: 'group',
    name: 'Grupo Facu Renombrado',
  })
  expect(segundo).toBe(primero)
})

test('upsertConversation actualiza valores y preserva el nombre ante null', async () => {
  const primero = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-conditional-update',
    kind: 'group',
    name: 'Nombre Inicial',
  })
  const segundo = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-conditional-update',
    kind: 'dm',
    name: 'Nombre Final',
  })
  const tercero = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-conditional-update',
    kind: 'group',
    name: null,
  })

  const rows = await handle.db
    .select({ kind: conversations.kind, name: conversations.name })
    .from(conversations)
    .where(eq(conversations.id, primero))

  expect(segundo).toBe(primero)
  expect(tercero).toBe(primero)
  expect(rows[0]?.kind).toBe('group')
  expect(rows[0]?.name).toBe('Nombre Final')
})

test('upsertParticipant preserva id y nombre ante displayName null', async () => {
  const primero = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: 'participant-conditional-update',
    displayName: 'Ana',
  })
  const segundo = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: 'participant-conditional-update',
    displayName: 'Ana Actualizada',
  })
  const tercero = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: 'participant-conditional-update',
    displayName: null,
  })

  const rows = await handle.db
    .select({ displayName: participants.displayName })
    .from(participants)
    .where(eq(participants.id, primero))

  expect(segundo).toBe(primero)
  expect(tercero).toBe(primero)
  expect(rows[0]?.displayName).toBe('Ana Actualizada')
})

test('insertMessage no duplica el mismo id externo', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-sequential-idempotency',
    kind: 'dm',
    name: null,
  })
  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: 'participant-message-author',
    displayName: 'Ana',
  })

  const entrada = {
    provider: 'fake' as const,
    externalId: 'message-sequential-idempotency',
    conversationId,
    participantId,
    sentAt: new Date('2026-08-30T12:00:00Z'),
    fromSelf: false,
    text: 'hola',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: { fake: true },
  }

  const primero = await insertMessage(handle.db, entrada)
  const segundo = await insertMessage(handle.db, entrada)

  expect(primero.inserted).toBe(true)
  expect(segundo.inserted).toBe(false)
  expect(segundo.id).toBe(primero.id)
  expect(await countMessagesInConversation(handle.db, conversationId)).toBe(1)
})

test('insertMessage resuelve entregas concurrentes sin duplicar', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-concurrent-idempotency',
    kind: 'group',
    name: 'Concurrente',
  })
  const entrada = {
    provider: 'fake' as const,
    externalId: 'message-concurrent-idempotency',
    conversationId,
    participantId: null,
    sentAt: new Date('2026-08-30T13:00:00Z'),
    fromSelf: false,
    text: 'simultáneo',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  }

  const resultados = await Promise.all([
    insertMessage(handle.db, entrada),
    insertMessage(handle.db, entrada),
  ])

  expect(resultados.filter((resultado) => resultado.inserted)).toHaveLength(1)
  expect(resultados[0]?.id).toBe(resultados[1]?.id)
  expect(await countMessagesInConversation(handle.db, conversationId)).toBe(1)
})

test('insertMessage inicializa lastMessageAt y no lo mueve hacia atrás', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'conversation-monotonic-activity',
    kind: 'group',
    name: 'Otro',
  })
  const nuevo = await insertMessage(handle.db, {
    provider: 'fake',
    externalId: 'message-newer',
    conversationId,
    participantId: null,
    sentAt: new Date('2026-08-30T15:00:00Z'),
    fromSelf: true,
    text: 'mío',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })
  const inicial = await handle.db
    .select({ lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))

  const viejo = await insertMessage(handle.db, {
    provider: 'fake',
    externalId: 'message-older',
    conversationId,
    participantId: null,
    sentAt: new Date('2026-08-30T10:00:00Z'),
    fromSelf: false,
    text: 'histórico',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })
  const rows = await handle.db
    .select({ lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))

  expect(nuevo.inserted).toBe(true)
  expect(inicial[0]?.lastMessageAt?.toISOString()).toBe('2026-08-30T15:00:00.000Z')
  expect(viejo.inserted).toBe(true)
  expect(rows[0]?.lastMessageAt?.toISOString()).toBe('2026-08-30T15:00:00.000Z')
})

test('insertMessage revierte el insert si falla la actualización de actividad', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'atomic-failure-conversation',
    kind: 'group',
    name: 'Falla atómica',
  })
  await handle.sql`
    CREATE OR REPLACE FUNCTION fail_atomic_message_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'forced activity update failure';
    END;
    $$
  `
  // `OR REPLACE` porque un run abortado antes de la limpieza dejaría el trigger vivo y haría fallar todos los runs siguientes.
  await handle.sql`
    CREATE OR REPLACE TRIGGER fail_atomic_message_update
    BEFORE UPDATE ON conversations
    FOR EACH ROW
    WHEN (NEW.external_id = 'atomic-failure-conversation')
    EXECUTE FUNCTION fail_atomic_message_update()
  `

  await expect(
    insertMessage(handle.db, {
      provider: 'fake',
      externalId: 'message-atomic-failure',
      conversationId,
      participantId: null,
      sentAt: new Date('2026-08-30T16:00:00Z'),
      fromSelf: false,
      text: 'debe revertirse',
      subject: null,
      threadExternalId: null,
      replyToExternalId: null,
      raw: null,
    }),
  ).rejects.toThrow()

  expect(await countMessagesInConversation(handle.db, conversationId)).toBe(0)
})
