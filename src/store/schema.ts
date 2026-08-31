import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import type {
  AttachmentKind,
  CaptureMode,
  ConversationKind,
  DownloadStatus,
  OutboundStatus,
  ProviderId,
} from '../domain/types.ts'

/**
 * Conversaciones de cualquier canal: chats uno a uno, grupos e hilos.
 * La identidad es el par proveedor e identificador externo, así que
 * sumar un canal nuevo no colisiona con los existentes.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    /** Identificador nativo del canal. En WhatsApp es el JID, por ejemplo `1203...@g.us`. */
    externalId: text('external_id').notNull(),
    kind: text('kind').$type<ConversationKind>().notNull(),
    name: text('name'),
    /** Momento del último mensaje capturado, para ordenar por actividad reciente. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_provider_external_id_idx').on(t.provider, t.externalId)],
)

/** Remitentes observados en cualquier canal. */
export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    /** Identificador nativo del remitente. En WhatsApp es su JID. */
    externalId: text('external_id').notNull(),
    /** Nombre que el canal reporta. Puede faltar y puede cambiar con el tiempo. */
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('participants_provider_external_id_idx').on(t.provider, t.externalId)],
)

/**
 * Mensajes capturados. La unicidad por proveedor e identificador externo es
 * la que vuelve idempotente la ingesta, necesaria porque el history sync de
 * WhatsApp reentrega mensajes que ya llegaron en vivo.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    externalId: text('external_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Null cuando el canal no identifica remitente, como en mensajes de sistema. */
    participantId: uuid('participant_id').references(() => participants.id),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    /** Verdadero si lo envió la cuenta vinculada. En WhatsApp incluye lo que manda el bot. */
    fromSelf: boolean('from_self').notNull(),
    /** Texto del mensaje, o el epígrafe si el mensaje es un adjunto con texto. */
    text: text('text'),
    /** Solo para canales de correo. Null en mensajería instantánea. */
    subject: text('subject'),
    /** Solo para canales de correo. Null en mensajería instantánea. */
    threadExternalId: text('thread_external_id'),
    replyToExternalId: text('reply_to_external_id'),
    /**
     * Carga original del proveedor, sin tipar a propósito: solo el adaptador que la
     * escribió sabe interpretarla.
     *
     * No sirve para reintentar una descarga. Los binarios no sobreviven al viaje por
     * jsonb: `mediaKey` vuelve como objeto común y no como `Uint8Array`, así que
     * `downloadMediaMessage` no lo acepta. El único reintento que existe hoy es el que
     * dispara una reentrega del mensaje, que trae su propia carga viva.
     */
    raw: jsonb('raw'),
    /** Null hasta que una búsqueda por tema fuerza a embeddear este mensaje. */
    embedding: vector('embedding', { dimensions: 768 }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_provider_external_id_idx').on(t.provider, t.externalId),
    index('messages_conversation_sent_at_idx').on(t.conversationId, t.sentAt),
  ],
)

/** Adjuntos de un mensaje, con el estado de la descarga de sus bytes. */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Identificador estable dentro del mensaje, por ejemplo `ABC123:0`. */
    externalId: text('external_id').notNull(),
    kind: text('kind').$type<AttachmentKind>().notNull(),
    mimeType: text('mime_type'),
    /** WhatsApp reports fileLength as uint64; int4 overflows near the 2 GiB document limit. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Duration in milliseconds for audio and video. Null otherwise. */
    durationMs: integer('duration_ms'),
    /** Ruta en disco una vez descargado. Null mientras esté pendiente o fallido. */
    localPath: text('local_path'),
    downloadStatus: text('download_status')
      .$type<DownloadStatus>()
      .notNull()
      .default('pending'),
    downloadAttempts: integer('download_attempts').notNull().default(0),
    downloadError: text('download_error'),
  },
  (t) => [uniqueIndex('attachments_message_external_id_idx').on(t.messageId, t.externalId)],
)

/**
 * Política de captura activa. Es una tabla de una sola fila, y hacen falta
 * las dos restricciones juntas para garantizarlo: el check limita `id` al
 * valor 1 y la clave primaria impide que ese valor se repita. Un `default(1)`
 * no alcanza, porque solo aporta el valor cuando el insert lo omite y no
 * evita que alguien inserte id 2. Es una excepción deliberada a la
 * preferencia por claves uuid, porque acá el objetivo es justamente que la
 * fila sea única.
 */
export const capturePolicy = pgTable(
  'capture_policy',
  {
    id: integer('id').primaryKey().default(1),
    mode: text('mode').$type<CaptureMode>().notNull().default('all'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('capture_policy_id_must_be_one', sql`${t.id} = 1`)],
)

/**
 * Excepciones a la política activa. En modo whitelist son las únicas
 * conversaciones que se capturan; en modo blacklist, las únicas que no.
 * En modo all se ignoran.
 */
export const captureRules = pgTable(
  'capture_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    conversationExternalId: text('conversation_external_id').notNull(),
  },
  (t) => [uniqueIndex('capture_rules_provider_conversation_idx').on(t.provider, t.conversationExternalId)],
)

/**
 * Outbound replies to send. The dispatcher claims `pending` rows whose
 * `next_attempt_at` is due, marks them `sending`, then `sent`, or returns
 * them to `pending` with backoff. `failed` is for non-retryable errors
 * (destination outside control).
 */
export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    conversationExternalId: text('conversation_external_id').notNull(),
    text: text('text').notNull(),
    /**
     * Used as `messageId` in Baileys. A retry with the same key produces the
     * same ID and WhatsApp drops it as a duplicate.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').$type<OutboundStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    sentExternalId: text('sent_external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outbound_messages_idempotency_key_idx').on(t.idempotencyKey),
    index('outbound_messages_due_idx').on(t.status, t.nextAttemptAt),
  ],
)

/**
 * IDs of messages the bot sent. The classifier checks these so it does not
 * treat the bot's own reply as a user request.
 */
export const botMessages = pgTable(
  'bot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    /** Native id of the sent message. On WhatsApp this is the Baileys ID. */
    externalId: text('external_id').notNull(),
    outboundId: uuid('outbound_id').references(() => outboundMessages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bot_messages_provider_external_id_idx').on(t.provider, t.externalId)],
)

/**
 * Pending request while the bot asked a follow-up. One active row per control
 * conversation: a new request replaces the previous one.
 */
export const pendingClarifications = pgTable(
  'pending_clarifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    conversationExternalId: text('conversation_external_id').notNull(),
    originalText: text('original_text').notNull(),
    question: text('question').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pending_clarifications_provider_conversation_idx').on(
      t.provider,
      t.conversationExternalId,
    ),
  ],
)

/**
 * Global summary preferences. Singleton row (id must be 1), same pattern as
 * `capture_policy`. Missing row falls back to `DEFAULT_PREFERENCES` in code.
 */
export const preferences = pgTable(
  'preferences',
  {
    id: integer('id').primaryKey().default(1),
    language: text('language'),
    length: text('length'),
    format: text('format'),
    tone: text('tone'),
    timezone: text('timezone'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('preferences_id_must_be_one', sql`${t.id} = 1`)],
)

/**
 * Per-conversation summary preferences and optional spoken alias used to
 * resolve a chat without calling the model.
 */
export const chatPreferences = pgTable(
  'chat_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    language: text('language'),
    length: text('length'),
    format: text('format'),
    tone: text('tone'),
    timezone: text('timezone'),
    focus: text('focus'),
    ignoreKinds: jsonb('ignore_kinds').$type<string[]>().notNull().default([]),
    /** Spoken name resolved deterministically, for example `la facu`. */
    alias: text('alias'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_preferences_conversation_id_idx').on(t.conversationId),
    uniqueIndex('chat_preferences_alias_idx').on(sql`lower(${t.alias})`),
  ],
)
