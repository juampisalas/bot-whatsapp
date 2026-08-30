import { sql } from 'drizzle-orm'
import {
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
     * Carga original del proveedor, sin tipar a propósito. Solo el adaptador
     * que la escribió sabe interpretarla, y se guarda porque volver a
     * descargar un adjunto que falló la necesita. No es una columna de
     * extensión especulativa: tiene ese consumidor concreto.
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
    sizeBytes: integer('size_bytes'),
    /** Duración en milisegundos para audio y video. Null en el resto. */
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
 * Política de captura activa. Es una tabla de una sola fila: la restricción
 * que exige id 1 impide que existan dos políticas en conflicto. Es una
 * excepción deliberada a la preferencia por claves uuid, porque acá el
 * objetivo es justamente que la fila sea única.
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
