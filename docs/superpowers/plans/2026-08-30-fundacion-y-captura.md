# Fundación y captura — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un proceso que se conecta a WhatsApp, persiste en Postgres todos los mensajes que llegan según la política de captura configurada, y descarga sus adjuntos, sin ninguna dependencia de un LLM.

**Architecture:** Puerto y adaptadores. Los tipos de dominio y la interfaz `MessagingProvider` viven en `src/domain` y no conocen Baileys. El adaptador de WhatsApp y un adaptador falso en memoria implementan ese puerto. El pipeline de ingesta consume el puerto, aplica una política de captura pura y persiste vía repositorios de Drizzle. Ninguna capa de este plan llama a un modelo.

**Tech Stack:** Bun 1.4, TypeScript estricto, `baileys` 7.0.0-rc14, PostgreSQL 18 con pgvector, Drizzle ORM con `postgres.js`, zod para configuración, `bun test` como runner.

## Global Constraints

- Runtime y gestor de paquetes: Bun. Nunca `npm install` ni `npx` para dependencias del proyecto.
- TypeScript en modo estricto. Prohibido `any`, implícito o explícito. El campo `raw` es `unknown`. Las aserciones de tipo se permiten únicamente en la frontera con Baileys, donde nuestros tipos neutrales se traducen a los suyos, y en ningún otro lugar.
- Versión exacta de Baileys: `7.0.0-rc14`. No usar rango `^`, porque la `latest` publicada es un release candidate.
- Dimensión del vector de embeddings: exactamente `768`. Corresponde a `embeddinggemma:300m`.
- Zona horaria por defecto: `America/Argentina/Buenos_Aires`, configurable por entorno.
- Postgres local escucha en el puerto **5433** del host, para no chocar con instalaciones previas.
- El bot no debe tener ningún camino de código que envíe mensajes a una conversación que no sea la de control. En este plan no se envía nada.
- La ingesta no puede depender de un LLM ni fallar por causa de uno.
- Todos los secretos por variables de entorno. Nunca hardcodeados.
- Tests antes de la implementación, en todas las tareas.
- Un commit por tarea como mínimo.

## Mapa de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `package.json` | Dependencias y scripts |
| `tsconfig.json` | TypeScript estricto |
| `.gitignore` | Excluye credenciales, adjuntos y entorno |
| `.env.example` | Documenta todas las variables |
| `docker-compose.yml` | Postgres con pgvector |
| `docker/init-db.sql` | Crea base de tests y la extensión vector en ambas bases |
| `drizzle.config.ts` | Configuración de drizzle-kit |
| `src/config/index.ts` | Lectura y validación del entorno |
| `src/domain/types.ts` | Tipos neutrales de canal |
| `src/domain/provider.ts` | La interfaz `MessagingProvider` |
| `src/domain/logger.ts` | La interfaz `Logger`, para que ninguna capa dependa de otra solo por el log |
| `src/store/schema.ts` | Tablas de Drizzle |
| `src/store/client.ts` | Conexión y instancia de Drizzle |
| `src/store/repositories/conversations.ts` | Alta y búsqueda de conversaciones y participantes |
| `src/store/repositories/messages.ts` | Alta idempotente de mensajes |
| `src/store/repositories/attachments.ts` | Alta y actualización de estado de adjuntos |
| `src/store/repositories/capture-policy.ts` | Lectura de la política y sus reglas |
| `src/providers/registry.ts` | Factory de proveedores por identificador |
| `src/providers/fake/index.ts` | Adaptador en memoria para tests |
| `src/providers/whatsapp/normalize.ts` | `WAMessage` a `InboundMessage` |
| `src/providers/whatsapp/index.ts` | Conexión Baileys y ciclo de vida |
| `src/capture/policy.ts` | Función pura que decide si capturar |
| `src/capture/buffer.ts` | Buffer acotado ante caída de la base |
| `src/capture/ingest.ts` | Pipeline de ingesta |
| `src/index.ts` | Punto de entrada y comando de listado |

---

### Task 1: Andamiaje del proyecto y configuración

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `src/config/index.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config` y el tipo `Config` con los campos `DATABASE_URL`, `PROVIDER`, `WHATSAPP_AUTH_DIR`, `MEDIA_DIR`, `CONTROL_PROVIDER`, `CONTROL_CONVERSATION_ID`, `CAPTURE_BUFFER_MAX`, `TIMEZONE`, `LOG_LEVEL`.

- [ ] **Step 1: Inicializar el proyecto e instalar dependencias**

```bash
cd /Users/juansalas/Desktop/bot-whatsapp
bun init -y
bun add baileys@7.0.0-rc14 drizzle-orm postgres zod qrcode-terminal
bun add -d drizzle-kit @types/bun @types/qrcode-terminal
```

- [ ] **Step 2: Escribir `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "tests", "drizzle.config.ts"]
}
```

- [ ] **Step 3: Escribir `.gitignore`**

```gitignore
node_modules/
data/
.env
.env.local
*.log
dist/
```

- [ ] **Step 4: Escribir `.env.example`**

```bash
# Conexión a Postgres. El puerto 5433 lo publica docker-compose.
DATABASE_URL=postgres://bot:bot@localhost:5433/botwhatsapp
DATABASE_URL_TEST=postgres://bot:bot@localhost:5433/botwhatsapp_test

# Proveedor de mensajería activo: whatsapp | fake
PROVIDER=whatsapp

# Credenciales de sesión de WhatsApp y adjuntos descargados
WHATSAPP_AUTH_DIR=./data/wa-auth
MEDIA_DIR=./data/media

# Conversación de control. Si CONTROL_CONVERSATION_ID está vacío,
# el bot lista las conversaciones disponibles al arrancar.
CONTROL_PROVIDER=whatsapp
CONTROL_CONVERSATION_ID=

# Máximo de mensajes retenidos en memoria si Postgres no responde
CAPTURE_BUFFER_MAX=1000

TIMEZONE=America/Argentina/Buenos_Aires
LOG_LEVEL=info
```

- [ ] **Step 5: Escribir el test que falla**

```ts
// tests/config.test.ts
import { test, expect } from 'bun:test'
import { loadConfig } from '../src/config/index.ts'

const base = { DATABASE_URL: 'postgres://bot:bot@localhost:5433/botwhatsapp' }

test('aplica los valores por defecto', () => {
  const config = loadConfig(base)
  expect(config.PROVIDER).toBe('whatsapp')
  expect(config.CAPTURE_BUFFER_MAX).toBe(1000)
  expect(config.TIMEZONE).toBe('America/Argentina/Buenos_Aires')
})

test('convierte CAPTURE_BUFFER_MAX a número', () => {
  const config = loadConfig({ ...base, CAPTURE_BUFFER_MAX: '25' })
  expect(config.CAPTURE_BUFFER_MAX).toBe(25)
})

test('falla con mensaje explícito si falta DATABASE_URL', () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
})

test('rechaza un proveedor desconocido', () => {
  expect(() => loadConfig({ ...base, PROVIDER: 'telegram' })).toThrow(/PROVIDER/)
})
```

- [ ] **Step 6: Correr el test y verificar que falla**

Run: `bun test tests/config.test.ts`
Expected: FAIL, no resuelve el módulo `../src/config/index.ts`.

- [ ] **Step 7: Implementar la configuración**

```ts
// src/config/index.ts
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PROVIDER: z.enum(['whatsapp', 'fake']).default('whatsapp'),
  WHATSAPP_AUTH_DIR: z.string().min(1).default('./data/wa-auth'),
  MEDIA_DIR: z.string().min(1).default('./data/media'),
  CONTROL_PROVIDER: z.enum(['whatsapp', 'fake']).default('whatsapp'),
  CONTROL_CONVERSATION_ID: z.string().optional(),
  CAPTURE_BUFFER_MAX: z.coerce.number().int().positive().default(1000),
  TIMEZONE: z.string().min(1).default('America/Argentina/Buenos_Aires'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Configuración de entorno inválida:\n${detail}`)
  }
  return parsed.data
}
```

- [ ] **Step 8: Correr el test y verificar que pasa**

Run: `bun test tests/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Agregar scripts a `package.json`**

Dentro de `package.json`, agregar la clave `scripts`:

```json
{
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun run src/store/migrate.ts"
  }
}
```

- [ ] **Step 10: Verificar tipos y commitear**

```bash
bun run typecheck
git add package.json bun.lock tsconfig.json .gitignore .env.example src/config tests/config.test.ts
git commit -m "feat: andamiaje del proyecto y configuración validada por entorno"
```

---

### Task 2: Postgres con pgvector y cliente de base

**Files:**
- Create: `docker-compose.yml`, `docker/init-db.sql`, `drizzle.config.ts`
- Create: `src/store/client.ts`
- Test: `tests/store/client.test.ts`

**Interfaces:**
- Consumes: `loadConfig` de Task 1
- Produces: `createDb(connectionString: string)` que devuelve `{ db, sql, close }`, donde `db` es la instancia de Drizzle sobre `postgres.js`, `sql` es el cliente crudo de `postgres` para consultas de test, y `close` cierra el pool. Produce además el tipo `Db`, que es el tipo de esa instancia de Drizzle y el que reciben todos los repositorios.

- [ ] **Step 1: Escribir `docker/init-db.sql`**

Este script corre una sola vez, cuando el volumen de datos se crea vacío. Crea la base de tests y habilita la extensión en las dos bases, porque `CREATE EXTENSION` es por base y la imagen no lo hace sola.

```sql
CREATE DATABASE botwhatsapp_test OWNER bot;

\c botwhatsapp
CREATE EXTENSION IF NOT EXISTS vector;

\c botwhatsapp_test
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 2: Escribir `docker-compose.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg18
    container_name: botwhatsapp-postgres
    environment:
      POSTGRES_USER: bot
      POSTGRES_PASSWORD: bot
      POSTGRES_DB: botwhatsapp
    ports:
      - '5433:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/init-db.sql:/docker-entrypoint-initdb.d/10-init-db.sql:ro
    restart: unless-stopped
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U bot -d botwhatsapp']
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  pgdata:
```

- [ ] **Step 3: Levantar la base y verificar la extensión**

```bash
bun run db:up
docker exec botwhatsapp-postgres psql -U bot -d botwhatsapp_test -c "SELECT extversion FROM pg_extension WHERE extname='vector';"
```

Expected: una fila con el número de versión de pgvector. Si sale vacío, el volumen ya existía de antes y el script de init no corrió: correr `docker compose down -v` y repetir.

- [ ] **Step 4: Escribir `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/store/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://bot:bot@localhost:5433/botwhatsapp',
  },
})
```

- [ ] **Step 5: Escribir el test que falla**

```ts
// tests/store/client.test.ts
import { test, expect, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'

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
```

- [ ] **Step 6: Correr el test y verificar que falla**

Run: `bun test tests/store/client.test.ts`
Expected: FAIL, no resuelve `../../src/store/client.ts`.

- [ ] **Step 7: Implementar el cliente**

```ts
// src/store/client.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

export function createDb(connectionString: string) {
  const sql = postgres(connectionString, { max: 10, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  }
}

export type Db = ReturnType<typeof createDb>['db']
```

- [ ] **Step 8: Crear un `schema.ts` vacío provisorio**

`client.ts` importa el esquema, que se define en Task 3. Para que este test corra, crear el archivo vacío:

```ts
// src/store/schema.ts
export {}
```

- [ ] **Step 9: Correr el test y verificar que pasa**

Run: `bun test tests/store/client.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 10: Commitear**

```bash
git add docker-compose.yml docker/init-db.sql drizzle.config.ts src/store tests/store
git commit -m "feat: Postgres con pgvector y cliente de base"
```

---

### Task 3: Esquema y migraciones

**Files:**
- Modify: `src/store/schema.ts` (reemplaza el archivo provisorio de Task 2)
- Create: `src/store/migrate.ts`
- Test: `tests/store/schema.test.ts`

**Interfaces:**
- Consumes: `createDb` de Task 2
- Produces: las tablas `conversations`, `participants`, `messages`, `attachments`, `capturePolicy`, `captureRules`, y los enums `providerEnum`, `conversationKindEnum`, `attachmentKindEnum`, `downloadStatusEnum`, `captureModeEnum`. Produce además `runMigrations(connectionString: string): Promise<void>`.

Solo se crean las tablas que este plan necesita. Las de resúmenes, preferencias, cola de salida, derivaciones de adjuntos, aclaraciones pendientes y estado de sincronización las agregan los planes siguientes con sus propias migraciones. La columna `embedding` sí se incluye ahora, porque fija la dimensión y valida que la extensión funcione, pero su índice HNSW lo crea el plan de búsqueda semántica cuando haga falta.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/store/schema.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

beforeAll(async () => {
  await runMigrations(url)
})

afterAll(async () => {
  await handle.close()
})

test('existen todas las tablas del plan', async () => {
  const rows = await handle.sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `
  const names = rows.map((r) => r.table_name)
  for (const expected of [
    'conversations',
    'participants',
    'messages',
    'attachments',
    'capture_policy',
    'capture_rules',
  ]) {
    expect(names).toContain(expected)
  }
})

test('la columna embedding tiene 768 dimensiones', async () => {
  const rows = await handle.sql<{ atttypmod: number }[]>`
    SELECT atttypmod FROM pg_attribute
    WHERE attrelid = 'messages'::regclass AND attname = 'embedding'
  `
  expect(rows[0]?.atttypmod).toBe(768)
})

test('un mensaje es único por proveedor e id externo', async () => {
  const rows = await handle.sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'messages' AND indexname = 'messages_provider_external_id_idx'
  `
  expect(rows[0]?.indexdef).toContain('UNIQUE')
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/store/schema.test.ts`
Expected: FAIL, no resuelve `../../src/store/migrate.ts`.

- [ ] **Step 3: Escribir el esquema**

```ts
// src/store/schema.ts
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

export const providerEnum = pgEnum('provider', ['whatsapp', 'telegram', 'slack', 'gmail', 'fake'])
export const conversationKindEnum = pgEnum('conversation_kind', ['dm', 'group', 'channel', 'thread'])
export const attachmentKindEnum = pgEnum('attachment_kind', [
  'image',
  'audio',
  'video',
  'document',
  'sticker',
])
export const downloadStatusEnum = pgEnum('download_status', ['pending', 'ok', 'failed'])
export const captureModeEnum = pgEnum('capture_mode', ['all', 'whitelist', 'blacklist'])

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: providerEnum('provider').notNull(),
    externalId: text('external_id').notNull(),
    kind: conversationKindEnum('kind').notNull(),
    name: text('name'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_provider_external_id_idx').on(t.provider, t.externalId)],
)

export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: providerEnum('provider').notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('participants_provider_external_id_idx').on(t.provider, t.externalId)],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: providerEnum('provider').notNull(),
    externalId: text('external_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').references(() => participants.id),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    fromSelf: boolean('from_self').notNull(),
    text: text('text'),
    subject: text('subject'),
    threadExternalId: text('thread_external_id'),
    replyToExternalId: text('reply_to_external_id'),
    raw: jsonb('raw'),
    embedding: vector('embedding', { dimensions: 768 }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_provider_external_id_idx').on(t.provider, t.externalId),
    index('messages_conversation_sent_at_idx').on(t.conversationId, t.sentAt),
  ],
)

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    kind: attachmentKindEnum('kind').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    durationMs: integer('duration_ms'),
    localPath: text('local_path'),
    downloadStatus: downloadStatusEnum('download_status').notNull().default('pending'),
    downloadAttempts: integer('download_attempts').notNull().default(0),
    downloadError: text('download_error'),
  },
  (t) => [uniqueIndex('attachments_message_external_id_idx').on(t.messageId, t.externalId)],
)

export const capturePolicy = pgTable('capture_policy', {
  id: integer('id').primaryKey().default(1),
  mode: captureModeEnum('mode').notNull().default('all'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const captureRules = pgTable(
  'capture_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: providerEnum('provider').notNull(),
    conversationExternalId: text('conversation_external_id').notNull(),
  },
  (t) => [uniqueIndex('capture_rules_provider_conversation_idx').on(t.provider, t.conversationExternalId)],
)
```

- [ ] **Step 4: Generar la migración**

```bash
bun run db:generate
```

Expected: se crea `drizzle/0000_*.sql` junto a `drizzle/meta/`.

- [ ] **Step 5: Agregar la extensión al principio de la migración generada**

Abrir el archivo `drizzle/0000_*.sql` e insertar como primera línea:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Esto hace que la migración funcione contra cualquier base, no solo contra las que creó `init-db.sql`.

- [ ] **Step 6: Escribir el corredor de migraciones**

```ts
// src/store/migrate.ts
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.ts'

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString)
  try {
    await migrate(handle.db, { migrationsFolder: './drizzle' })
  } finally {
    await handle.close()
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Falta DATABASE_URL')
  await runMigrations(url)
  console.log('Migraciones aplicadas')
}
```

- [ ] **Step 7: Correr el test y verificar que pasa**

Run: `bun test tests/store/schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Verificar tipos y commitear**

```bash
bun run typecheck
git add src/store drizzle tests/store
git commit -m "feat: esquema de captura con columna vectorial de 768 dimensiones"
```

---

### Task 4: Tipos de dominio, puerto y adaptador falso

**Files:**
- Create: `src/domain/types.ts`, `src/domain/provider.ts`, `src/domain/logger.ts`
- Create: `src/providers/fake/index.ts`
- Test: `tests/providers/fake.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: los tipos `ProviderId`, `ConversationKind`, `ConversationRef`, `InboundAttachment`, `InboundMessage`, `OutboundContent`, `SentMessage`, `ConversationSummary`, `DownloadedMedia`; las interfaces `MessagingProvider` y `Logger`; la constante `silentLogger`; y la clase `FakeProvider` con los métodos extra de test `inject(message: InboundMessage): Promise<void>`, `get sent(): SentRecord[]`, `failNextSend(error: Error): void`, `seedConversations(items: ConversationSummary[]): void`.

El puerto incluye `waitUntilReady(timeoutMs?: number)`, separado de `connect`, porque en WhatsApp conectar solo inicia el proceso: puede requerir que una persona escanee un QR antes de que exista sesión utilizable. Sin esta separación, quien consume el puerto termina adivinando con esperas fijas.

`Logger` vive en `src/domain` y no en el módulo de captura. Si viviera en `capture/ingest.ts`, el adaptador de WhatsApp tendría que importar desde `capture` solo para tipar su log, lo que rompería la regla de que los proveedores no dependen de las capas de arriba.

El adaptador falso es lo que hace posible los tests end-to-end de los planes siguientes, así que se construye junto al puerto para demostrar que el puerto es implementable.

- [ ] **Step 1: Escribir los tipos de dominio**

```ts
// src/domain/types.ts
export type ProviderId = 'whatsapp' | 'telegram' | 'slack' | 'gmail' | 'fake'

export type ConversationKind = 'dm' | 'group' | 'channel' | 'thread'

export type AttachmentKind = 'image' | 'audio' | 'video' | 'document' | 'sticker'

export interface ConversationRef {
  provider: ProviderId
  externalId: string
}

export interface InboundAttachment {
  externalId: string
  kind: AttachmentKind
  mimeType: string | null
  sizeBytes: number | null
  durationMs: number | null
}

export interface InboundMessage {
  provider: ProviderId
  externalId: string
  conversation: {
    externalId: string
    kind: ConversationKind
    name: string | null
  }
  sender: {
    externalId: string
    displayName: string | null
  } | null
  sentAt: Date
  fromSelf: boolean
  text: string | null
  /** Solo para canales de correo. Null en mensajería instantánea. */
  subject: string | null
  /** Solo para canales de correo. Null en mensajería instantánea. */
  threadExternalId: string | null
  replyToExternalId: string | null
  attachments: InboundAttachment[]
  /**
   * Carga original del proveedor. Únicamente el adaptador que la produjo
   * puede interpretarla; el resto del sistema solo la persiste y la devuelve.
   */
  raw: unknown
}

export interface OutboundContent {
  text: string
}

export interface SentMessage {
  externalId: string
}

export interface ConversationSummary {
  externalId: string
  kind: ConversationKind
  name: string | null
  participantCount: number | null
}

export interface DownloadedMedia {
  localPath: string
  sizeBytes: number
}
```

- [ ] **Step 2: Escribir el puerto**

```ts
// src/domain/provider.ts
import type {
  ConversationRef,
  ConversationSummary,
  DownloadedMedia,
  InboundMessage,
  OutboundContent,
  ProviderId,
  SentMessage,
} from './types.ts'

export type InboundHandler = (message: InboundMessage) => Promise<void>

export interface MessagingProvider {
  readonly id: ProviderId

  /**
   * Establece la conexión. No asume tiempo real: un adaptador que
   * internamente hace polling cumple el contrato igual.
   */
  connect(): Promise<void>

  /**
   * Resuelve cuando el canal está listo para operar. Existe porque
   * `connect` solo inicia el proceso: en WhatsApp puede hacer falta que
   * el usuario escanee un QR antes de que haya sesión utilizable.
   * Rechaza si vence el tiempo o si la sesión quedó cerrada.
   */
  waitUntilReady(timeoutMs?: number): Promise<void>

  disconnect(): Promise<void>

  /** Registra el manejador de mensajes entrantes. */
  onMessage(handler: InboundHandler): void

  /**
   * Envía un mensaje. `idempotencyKey` se usa como identificador del
   * mensaje cuando el canal lo permite, para que un reintento no
   * produzca un duplicado.
   */
  send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage>

  /** Descarga un adjunto de un mensaje ya recibido. */
  downloadAttachment(message: InboundMessage, attachmentExternalId: string): Promise<DownloadedMedia>

  listConversations(): Promise<ConversationSummary[]>
}
```

- [ ] **Step 3: Escribir la interfaz de log**

```ts
// src/domain/logger.ts
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
```

- [ ] **Step 4: Escribir el test que falla**

```ts
// tests/providers/fake.test.ts
import { test, expect } from 'bun:test'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import type { InboundMessage } from '../../src/domain/types.ts'

function mensaje(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    provider: 'fake',
    externalId: 'm1',
    conversation: { externalId: 'c1', kind: 'group', name: 'Grupo Facu' },
    sender: { externalId: 'p1', displayName: 'Ana' },
    sentAt: new Date('2026-08-30T12:00:00Z'),
    fromSelf: false,
    text: 'hola',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    attachments: [],
    raw: { fake: true },
    ...overrides,
  }
}

test('entrega los mensajes inyectados al manejador', async () => {
  const provider = new FakeProvider()
  const recibidos: InboundMessage[] = []
  provider.onMessage(async (m) => {
    recibidos.push(m)
  })
  await provider.connect()
  await provider.inject(mensaje())

  expect(recibidos).toHaveLength(1)
  expect(recibidos[0]?.text).toBe('hola')
})

test('registra los mensajes enviados con su clave de idempotencia', async () => {
  const provider = new FakeProvider()
  await provider.connect()
  const enviado = await provider.send(
    { provider: 'fake', externalId: 'c1' },
    { text: 'respuesta' },
    'clave-1',
  )

  expect(enviado.externalId).toBe('clave-1')
  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.content.text).toBe('respuesta')
})

test('puede simular un fallo de envío una sola vez', async () => {
  const provider = new FakeProvider()
  await provider.connect()
  provider.failNextSend(new Error('socket caído'))

  await expect(
    provider.send({ provider: 'fake', externalId: 'c1' }, { text: 'x' }, 'k1'),
  ).rejects.toThrow('socket caído')

  const enviado = await provider.send({ provider: 'fake', externalId: 'c1' }, { text: 'x' }, 'k1')
  expect(enviado.externalId).toBe('k1')
})

test('rechaza inyectar antes de conectar', async () => {
  const provider = new FakeProvider()
  await expect(provider.inject(mensaje())).rejects.toThrow(/sin conectar/)
})

test('waitUntilReady resuelve una vez conectado y falla si no', async () => {
  const provider = new FakeProvider()
  await expect(provider.waitUntilReady()).rejects.toThrow(/sin conectar/)
  await provider.connect()
  await expect(provider.waitUntilReady()).resolves.toBeUndefined()
})
```

- [ ] **Step 5: Correr el test y verificar que falla**

Run: `bun test tests/providers/fake.test.ts`
Expected: FAIL, no resuelve `../../src/providers/fake/index.ts`.

- [ ] **Step 6: Implementar el adaptador falso**

```ts
// src/providers/fake/index.ts
import type { InboundHandler, MessagingProvider } from '../../domain/provider.ts'
import type {
  ConversationRef,
  ConversationSummary,
  DownloadedMedia,
  InboundMessage,
  OutboundContent,
  ProviderId,
  SentMessage,
} from '../../domain/types.ts'

export interface SentRecord {
  target: ConversationRef
  content: OutboundContent
  idempotencyKey: string
}

export class FakeProvider implements MessagingProvider {
  readonly id: ProviderId = 'fake'

  private handler: InboundHandler | null = null
  private connected = false
  private nextSendError: Error | null = null
  private readonly sentRecords: SentRecord[] = []
  private readonly conversations: ConversationSummary[] = []

  get sent(): readonly SentRecord[] {
    return this.sentRecords
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async waitUntilReady(): Promise<void> {
    if (!this.connected) throw new Error('FakeProvider sin conectar')
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler
  }

  /** Simula la llegada de un mensaje desde el canal. */
  async inject(message: InboundMessage): Promise<void> {
    if (!this.connected) throw new Error('FakeProvider sin conectar')
    if (!this.handler) throw new Error('FakeProvider sin manejador registrado')
    await this.handler(message)
  }

  /** Hace fallar el próximo envío, una única vez. */
  failNextSend(error: Error): void {
    this.nextSendError = error
  }

  /** Registra conversaciones que devolverá `listConversations`. */
  seedConversations(items: ConversationSummary[]): void {
    this.conversations.splice(0, this.conversations.length, ...items)
  }

  async send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage> {
    if (this.nextSendError) {
      const error = this.nextSendError
      this.nextSendError = null
      throw error
    }
    this.sentRecords.push({ target, content, idempotencyKey })
    return { externalId: idempotencyKey }
  }

  async downloadAttachment(
    _message: InboundMessage,
    attachmentExternalId: string,
  ): Promise<DownloadedMedia> {
    return { localPath: `/tmp/fake/${attachmentExternalId}`, sizeBytes: 0 }
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return [...this.conversations]
  }
}
```

- [ ] **Step 7: Correr el test y verificar que pasa**

Run: `bun test tests/providers/fake.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Verificar tipos y commitear**

```bash
bun run typecheck
git add src/domain src/providers/fake tests/providers
git commit -m "feat: tipos de dominio, puerto de mensajería y adaptador falso"
```

---

### Task 5: Repositorios de conversaciones, participantes y mensajes

**Files:**
- Create: `src/store/repositories/conversations.ts`
- Create: `src/store/repositories/messages.ts`
- Test: `tests/store/repositories.test.ts`

**Interfaces:**
- Consumes: `Db` de Task 2, tablas de Task 3, tipos de Task 4
- Produces:
  - `upsertConversation(db: Db, input: { provider: ProviderId; externalId: string; kind: ConversationKind; name: string | null }): Promise<string>` que devuelve el UUID
  - `upsertParticipant(db: Db, input: { provider: ProviderId; externalId: string; displayName: string | null }): Promise<string>`
  - `insertMessage(db: Db, input: InsertMessageInput): Promise<{ id: string; inserted: boolean }>`
  - `countMessagesInConversation(db: Db, conversationId: string): Promise<number>`

`insertMessage` es idempotente: si el par proveedor e id externo ya existe, no duplica y devuelve `inserted: false`. Esto importa porque el history sync de WhatsApp reentrega mensajes que ya se recibieron en vivo.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/store/repositories.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { upsertConversation, upsertParticipant } from '../../src/store/repositories/conversations.ts'
import { countMessagesInConversation, insertMessage } from '../../src/store/repositories/messages.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

beforeAll(async () => {
  await runMigrations(url)
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await handle.close()
})

test('upsertConversation devuelve el mismo id al repetir', async () => {
  const primero = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c1',
    kind: 'group',
    name: 'Grupo Facu',
  })
  const segundo = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c1',
    kind: 'group',
    name: 'Grupo Facu Renombrado',
  })
  expect(segundo).toBe(primero)
})

test('upsertConversation actualiza el nombre', async () => {
  const id = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c1',
    kind: 'group',
    name: 'Nombre Final',
  })
  const rows = await handle.sql<{ name: string }[]>`SELECT name FROM conversations WHERE id = ${id}`
  expect(rows[0]?.name).toBe('Nombre Final')
})

test('insertMessage no duplica el mismo id externo', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c2',
    kind: 'dm',
    name: null,
  })
  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: 'p1',
    displayName: 'Ana',
  })

  const entrada = {
    provider: 'fake' as const,
    externalId: 'm1',
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

test('insertMessage actualiza lastMessageAt de la conversación', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c3',
    kind: 'group',
    name: 'Otro',
  })
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: 'm2',
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
  const rows = await handle.sql<{ last_message_at: Date }[]>`
    SELECT last_message_at FROM conversations WHERE id = ${conversationId}
  `
  expect(rows[0]?.last_message_at.toISOString()).toBe('2026-08-30T15:00:00.000Z')
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/store/repositories.test.ts`
Expected: FAIL, no resuelve los módulos de repositorios.

- [ ] **Step 3: Implementar el repositorio de conversaciones**

```ts
// src/store/repositories/conversations.ts
import { sql } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { conversations, participants } from '../schema.ts'
import type { ConversationKind, ProviderId } from '../../domain/types.ts'

export async function upsertConversation(
  db: Db,
  input: { provider: ProviderId; externalId: string; kind: ConversationKind; name: string | null },
): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      kind: input.kind,
      name: input.name,
    })
    .onConflictDoUpdate({
      target: [conversations.provider, conversations.externalId],
      set: { name: sql`COALESCE(EXCLUDED.name, ${conversations.name})` },
    })
    .returning({ id: conversations.id })

  const id = rows[0]?.id
  if (!id) throw new Error('upsertConversation no devolvió id')
  return id
}

export async function upsertParticipant(
  db: Db,
  input: { provider: ProviderId; externalId: string; displayName: string | null },
): Promise<string> {
  const rows = await db
    .insert(participants)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      displayName: input.displayName,
    })
    .onConflictDoUpdate({
      target: [participants.provider, participants.externalId],
      set: { displayName: sql`COALESCE(EXCLUDED.display_name, ${participants.displayName})` },
    })
    .returning({ id: participants.id })

  const id = rows[0]?.id
  if (!id) throw new Error('upsertParticipant no devolvió id')
  return id
}
```

- [ ] **Step 4: Implementar el repositorio de mensajes**

```ts
// src/store/repositories/messages.ts
import { and, count, eq, sql } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { conversations, messages } from '../schema.ts'
import type { ProviderId } from '../../domain/types.ts'

export interface InsertMessageInput {
  provider: ProviderId
  externalId: string
  conversationId: string
  participantId: string | null
  sentAt: Date
  fromSelf: boolean
  text: string | null
  subject: string | null
  threadExternalId: string | null
  replyToExternalId: string | null
  raw: unknown
}

export async function insertMessage(
  db: Db,
  input: InsertMessageInput,
): Promise<{ id: string; inserted: boolean }> {
  const inserted = await db
    .insert(messages)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      conversationId: input.conversationId,
      participantId: input.participantId,
      sentAt: input.sentAt,
      fromSelf: input.fromSelf,
      text: input.text,
      subject: input.subject,
      threadExternalId: input.threadExternalId,
      replyToExternalId: input.replyToExternalId,
      raw: input.raw,
    })
    .onConflictDoNothing({ target: [messages.provider, messages.externalId] })
    .returning({ id: messages.id })

  const nuevoId = inserted[0]?.id
  if (nuevoId) {
    await db
      .update(conversations)
      .set({ lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${input.sentAt}), ${input.sentAt})` })
      .where(eq(conversations.id, input.conversationId))
    return { id: nuevoId, inserted: true }
  }

  const existente = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.provider, input.provider), eq(messages.externalId, input.externalId)))
    .limit(1)

  const id = existente[0]?.id
  if (!id) throw new Error('insertMessage no pudo resolver el mensaje existente')
  return { id, inserted: false }
}

export async function countMessagesInConversation(db: Db, conversationId: string): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
  return Number(rows[0]?.total ?? 0)
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `bun test tests/store/repositories.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verificar tipos y commitear**

```bash
bun run typecheck
git add src/store/repositories tests/store/repositories.test.ts
git commit -m "feat: repositorios idempotentes de conversaciones y mensajes"
```

---

### Task 6: Política de captura

**Files:**
- Create: `src/capture/policy.ts`
- Create: `src/store/repositories/capture-policy.ts`
- Test: `tests/capture/policy.test.ts`

**Interfaces:**
- Consumes: `Db` de Task 2, tablas de Task 3
- Produces:
  - `shouldCapture(policy: CapturePolicy, conversationExternalId: string): boolean`
  - el tipo `CapturePolicy = { mode: CaptureMode; rules: ReadonlySet<string> }`
  - `loadCapturePolicy(db: Db, provider: ProviderId): Promise<CapturePolicy>`

La decisión es una función pura sin base de datos, para poder testear los tres modos sin infraestructura. La carga desde la base es una función aparte.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/capture/policy.test.ts
import { test, expect } from 'bun:test'
import { shouldCapture } from '../../src/capture/policy.ts'

test('modo all captura cualquier conversación', () => {
  expect(shouldCapture({ mode: 'all', rules: new Set() }, 'c1')).toBe(true)
  expect(shouldCapture({ mode: 'all', rules: new Set(['c9']) }, 'c1')).toBe(true)
})

test('modo whitelist captura solo lo listado', () => {
  const policy = { mode: 'whitelist' as const, rules: new Set(['c1']) }
  expect(shouldCapture(policy, 'c1')).toBe(true)
  expect(shouldCapture(policy, 'c2')).toBe(false)
})

test('modo blacklist captura todo menos lo listado', () => {
  const policy = { mode: 'blacklist' as const, rules: new Set(['c1']) }
  expect(shouldCapture(policy, 'c1')).toBe(false)
  expect(shouldCapture(policy, 'c2')).toBe(true)
})

test('whitelist vacía no captura nada', () => {
  expect(shouldCapture({ mode: 'whitelist', rules: new Set() }, 'c1')).toBe(false)
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/capture/policy.test.ts`
Expected: FAIL, no resuelve `../../src/capture/policy.ts`.

- [ ] **Step 3: Implementar la política**

```ts
// src/capture/policy.ts
export type CaptureMode = 'all' | 'whitelist' | 'blacklist'

export interface CapturePolicy {
  mode: CaptureMode
  rules: ReadonlySet<string>
}

export function shouldCapture(policy: CapturePolicy, conversationExternalId: string): boolean {
  switch (policy.mode) {
    case 'all':
      return true
    case 'whitelist':
      return policy.rules.has(conversationExternalId)
    case 'blacklist':
      return !policy.rules.has(conversationExternalId)
  }
}
```

- [ ] **Step 4: Implementar la carga desde la base**

```ts
// src/store/repositories/capture-policy.ts
import { eq } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { capturePolicy, captureRules } from '../schema.ts'
import type { CapturePolicy } from '../../capture/policy.ts'
import type { ProviderId } from '../../domain/types.ts'

export async function loadCapturePolicy(db: Db, provider: ProviderId): Promise<CapturePolicy> {
  const fila = await db.select({ mode: capturePolicy.mode }).from(capturePolicy).limit(1)
  const mode = fila[0]?.mode ?? 'all'

  const reglas = await db
    .select({ conversationExternalId: captureRules.conversationExternalId })
    .from(captureRules)
    .where(eq(captureRules.provider, provider))

  return { mode, rules: new Set(reglas.map((r) => r.conversationExternalId)) }
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `bun test tests/capture/policy.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commitear**

```bash
bun run typecheck
git add src/capture/policy.ts src/store/repositories/capture-policy.ts tests/capture
git commit -m "feat: política de captura con modos all, whitelist y blacklist"
```

---

### Task 7: Buffer acotado ante caída de la base

**Files:**
- Create: `src/capture/buffer.ts`
- Test: `tests/capture/buffer.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `class BoundedBuffer<T>` con `push(item: T): void`, `drain(): T[]`, `get size(): number`, `get dropped(): number`.

Al llenarse descarta el elemento más antiguo y lleva la cuenta de descartes, que es lo que después se registra en el log. El límite viene de `CAPTURE_BUFFER_MAX`, mil por defecto.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/capture/buffer.test.ts
import { test, expect } from 'bun:test'
import { BoundedBuffer } from '../../src/capture/buffer.ts'

test('acumula y vacía en orden de llegada', () => {
  const buffer = new BoundedBuffer<number>(5)
  buffer.push(1)
  buffer.push(2)
  expect(buffer.size).toBe(2)
  expect(buffer.drain()).toEqual([1, 2])
  expect(buffer.size).toBe(0)
})

test('descarta los más antiguos al superar el límite y los cuenta', () => {
  const buffer = new BoundedBuffer<number>(2)
  buffer.push(1)
  buffer.push(2)
  buffer.push(3)
  expect(buffer.drain()).toEqual([2, 3])
  expect(buffer.dropped).toBe(1)
})

test('rechaza un límite no positivo', () => {
  expect(() => new BoundedBuffer<number>(0)).toThrow(/positivo/)
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/capture/buffer.test.ts`
Expected: FAIL, no resuelve `../../src/capture/buffer.ts`.

- [ ] **Step 3: Implementar el buffer**

```ts
// src/capture/buffer.ts
export class BoundedBuffer<T> {
  private readonly items: T[] = []
  private droppedCount = 0

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('El límite del buffer debe ser un entero positivo')
    }
  }

  get size(): number {
    return this.items.length
  }

  get dropped(): number {
    return this.droppedCount
  }

  push(item: T): void {
    if (this.items.length >= this.limit) {
      this.items.shift()
      this.droppedCount += 1
    }
    this.items.push(item)
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length)
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `bun test tests/capture/buffer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commitear**

```bash
bun run typecheck
git add src/capture/buffer.ts tests/capture/buffer.test.ts
git commit -m "feat: buffer acotado con conteo de descartes"
```

---

### Task 8: Pipeline de ingesta

**Files:**
- Create: `src/capture/ingest.ts`
- Test: `tests/capture/ingest.test.ts`

**Interfaces:**
- Consumes: `MessagingProvider` y tipos de Task 4, repositorios de Task 5, `shouldCapture` y `CapturePolicy` de Task 6, `BoundedBuffer` de Task 7, `Db` de Task 2
- Produces: `createIngestPipeline(deps: IngestDeps): { handle(message: InboundMessage): Promise<void>; flushBuffer(): Promise<number> }` donde `IngestDeps = { db: Db; policy: CapturePolicy; provider: MessagingProvider; bufferMax: number; log?: Logger }`. El pipeline no recibe `mediaDir`: las rutas locales las resuelve el proveedor, que es el único que sabe cómo nombrar sus archivos.

Este es el test end-to-end de este plan: se inyecta un mensaje en el adaptador falso y se verifica que aparece en Postgres.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/capture/ingest.test.ts
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import type { InboundMessage } from '../../src/domain/types.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

function mensaje(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    provider: 'fake',
    externalId: 'm1',
    conversation: { externalId: 'c1', kind: 'group', name: 'Grupo Facu' },
    sender: { externalId: 'p1', displayName: 'Ana' },
    sentAt: new Date('2026-08-30T12:00:00Z'),
    fromSelf: false,
    text: 'hola gente',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    attachments: [],
    raw: { fake: true },
    ...overrides,
  }
}

beforeAll(async () => {
  await runMigrations(url)
})

beforeEach(async () => {
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await handle.close()
})

test('persiste un mensaje entrante de punta a punta', async () => {
  const provider = new FakeProvider()
  const pipeline = createIngestPipeline({
    db: handle.db,
    policy: { mode: 'all', rules: new Set() },
    provider,
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(mensaje())

  const rows = await handle.sql<{ text: string; from_self: boolean }[]>`
    SELECT text, from_self FROM messages
  `
  expect(rows).toHaveLength(1)
  expect(rows[0]?.text).toBe('hola gente')
  expect(rows[0]?.from_self).toBe(false)
})

test('no persiste conversaciones excluidas por la política', async () => {
  const provider = new FakeProvider()
  const pipeline = createIngestPipeline({
    db: handle.db,
    policy: { mode: 'blacklist', rules: new Set(['c1']) },
    provider,
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(mensaje())

  const rows = await handle.sql`SELECT 1 FROM messages`
  expect(rows).toHaveLength(0)
})

test('reentregar el mismo mensaje no lo duplica', async () => {
  const provider = new FakeProvider()
  const pipeline = createIngestPipeline({
    db: handle.db,
    policy: { mode: 'all', rules: new Set() },
    provider,
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(mensaje())
  await provider.inject(mensaje())

  const rows = await handle.sql`SELECT 1 FROM messages`
  expect(rows).toHaveLength(1)
})

test('registra los adjuntos con estado pendiente', async () => {
  const provider = new FakeProvider()
  const pipeline = createIngestPipeline({
    db: handle.db,
    policy: { mode: 'all', rules: new Set() },
    provider,
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(
    mensaje({
      attachments: [
        { externalId: 'a1', kind: 'audio', mimeType: 'audio/ogg', sizeBytes: 1024, durationMs: 45000 },
      ],
    }),
  )

  const rows = await handle.sql<{ kind: string; duration_ms: number }[]>`
    SELECT kind, duration_ms FROM attachments
  `
  expect(rows).toHaveLength(1)
  expect(rows[0]?.kind).toBe('audio')
  expect(rows[0]?.duration_ms).toBe(45000)
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/capture/ingest.test.ts`
Expected: FAIL, no resuelve `../../src/capture/ingest.ts`.

- [ ] **Step 3: Implementar el repositorio de adjuntos**

```ts
// src/store/repositories/attachments.ts
import type { Db } from '../client.ts'
import { attachments } from '../schema.ts'
import type { InboundAttachment } from '../../domain/types.ts'

export async function insertAttachments(
  db: Db,
  messageId: string,
  items: readonly InboundAttachment[],
): Promise<void> {
  if (items.length === 0) return
  await db
    .insert(attachments)
    .values(
      items.map((item) => ({
        messageId,
        externalId: item.externalId,
        kind: item.kind,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        durationMs: item.durationMs,
      })),
    )
    .onConflictDoNothing({ target: [attachments.messageId, attachments.externalId] })
}
```

- [ ] **Step 4: Implementar el pipeline**

```ts
// src/capture/ingest.ts
import type { Db } from '../store/client.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { InboundMessage } from '../domain/types.ts'
import { upsertConversation, upsertParticipant } from '../store/repositories/conversations.ts'
import { insertMessage } from '../store/repositories/messages.ts'
import { insertAttachments } from '../store/repositories/attachments.ts'
import { shouldCapture, type CapturePolicy } from './policy.ts'
import { BoundedBuffer } from './buffer.ts'
import { silentLogger, type Logger } from '../domain/logger.ts'

export interface IngestDeps {
  db: Db
  policy: CapturePolicy
  provider: MessagingProvider
  bufferMax: number
  log?: Logger
}

export function createIngestPipeline(deps: IngestDeps) {
  const log = deps.log ?? silentLogger
  const buffer = new BoundedBuffer<InboundMessage>(deps.bufferMax)

  async function persist(message: InboundMessage): Promise<void> {
    const conversationId = await upsertConversation(deps.db, {
      provider: message.provider,
      externalId: message.conversation.externalId,
      kind: message.conversation.kind,
      name: message.conversation.name,
    })

    const participantId = message.sender
      ? await upsertParticipant(deps.db, {
          provider: message.provider,
          externalId: message.sender.externalId,
          displayName: message.sender.displayName,
        })
      : null

    const { id, inserted } = await insertMessage(deps.db, {
      provider: message.provider,
      externalId: message.externalId,
      conversationId,
      participantId,
      sentAt: message.sentAt,
      fromSelf: message.fromSelf,
      text: message.text,
      subject: message.subject,
      threadExternalId: message.threadExternalId,
      replyToExternalId: message.replyToExternalId,
      raw: message.raw,
    })

    if (inserted) {
      await insertAttachments(deps.db, id, message.attachments)
    }
  }

  async function handle(message: InboundMessage): Promise<void> {
    if (!shouldCapture(deps.policy, message.conversation.externalId)) return

    try {
      await persist(message)
    } catch (error) {
      buffer.push(message)
      log.warn('no se pudo persistir, mensaje en buffer', {
        externalId: message.externalId,
        enBuffer: buffer.size,
        descartados: buffer.dropped,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Reintenta lo acumulado. Devuelve cuántos logró persistir. */
  async function flushBuffer(): Promise<number> {
    const pendientes = buffer.drain()
    let persistidos = 0
    for (const message of pendientes) {
      try {
        await persist(message)
        persistidos += 1
      } catch {
        buffer.push(message)
      }
    }
    if (persistidos > 0) log.info('buffer vaciado', { persistidos })
    return persistidos
  }

  return { handle, flushBuffer }
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `bun test tests/capture/ingest.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verificar tipos y commitear**

```bash
bun run typecheck
git add src/capture/ingest.ts src/store/repositories/attachments.ts tests/capture/ingest.test.ts
git commit -m "feat: pipeline de ingesta con buffer de contingencia"
```

---

### Task 9: Normalización de mensajes de WhatsApp

**Files:**
- Create: `src/providers/whatsapp/normalize.ts`
- Test: `tests/providers/whatsapp/normalize.test.ts`

**Interfaces:**
- Consumes: tipos de Task 4
- Produces: `normalizeWAMessage(waMessage: WAMessage, selfJid: string): InboundMessage | null`. Devuelve `null` para mensajes que no se pueden interpretar, como protocolos internos o mensajes sin clave.

Un `WAMessage` de Baileys anida el contenido de formas distintas según el tipo, y los mensajes efímeros o con vista única lo envuelven una o dos veces más. La normalización desenvuelve y traduce a nuestro tipo plano.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/providers/whatsapp/normalize.test.ts
import { test, expect } from 'bun:test'
import { normalizeWAMessage } from '../../../src/providers/whatsapp/normalize.ts'
import type { WAMessage } from 'baileys'

const SELF = '5491100000000@s.whatsapp.net'

function waMessage(overrides: Record<string, unknown> = {}): WAMessage {
  return {
    key: {
      remoteJid: '120363000000000000@g.us',
      id: 'ABC123',
      fromMe: false,
      participant: '5491111111111@s.whatsapp.net',
    },
    messageTimestamp: 1756555200,
    pushName: 'Ana',
    message: { conversation: 'hola gente' },
    ...overrides,
  } as unknown as WAMessage
}

test('normaliza un mensaje de texto de grupo', () => {
  const result = normalizeWAMessage(waMessage(), SELF)
  expect(result).not.toBeNull()
  expect(result?.externalId).toBe('ABC123')
  expect(result?.text).toBe('hola gente')
  expect(result?.conversation.kind).toBe('group')
  expect(result?.conversation.externalId).toBe('120363000000000000@g.us')
  expect(result?.sender?.externalId).toBe('5491111111111@s.whatsapp.net')
  expect(result?.sender?.displayName).toBe('Ana')
  expect(result?.fromSelf).toBe(false)
  expect(result?.sentAt.toISOString()).toBe('2026-08-30T12:00:00.000Z')
})

test('detecta una conversación uno a uno', () => {
  const result = normalizeWAMessage(
    waMessage({ key: { remoteJid: '5491111111111@s.whatsapp.net', id: 'X1', fromMe: false } }),
    SELF,
  )
  expect(result?.conversation.kind).toBe('dm')
  expect(result?.sender?.externalId).toBe('5491111111111@s.whatsapp.net')
})

test('marca fromSelf cuando el mensaje es propio', () => {
  const result = normalizeWAMessage(
    waMessage({ key: { remoteJid: '120363000000000000@g.us', id: 'X2', fromMe: true } }),
    SELF,
  )
  expect(result?.fromSelf).toBe(true)
  expect(result?.sender?.externalId).toBe(SELF)
})

test('extrae el texto de un mensaje extendido', () => {
  const result = normalizeWAMessage(
    waMessage({ message: { extendedTextMessage: { text: 'con formato' } } }),
    SELF,
  )
  expect(result?.text).toBe('con formato')
})

test('desenvuelve mensajes efímeros', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: { ephemeralMessage: { message: { conversation: 'desaparece' } } },
    }),
    SELF,
  )
  expect(result?.text).toBe('desaparece')
})

test('traduce una nota de voz a un adjunto de audio', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 45, fileLength: 20480 },
      },
    }),
    SELF,
  )
  expect(result?.attachments).toHaveLength(1)
  expect(result?.attachments[0]?.kind).toBe('audio')
  expect(result?.attachments[0]?.durationMs).toBe(45000)
  expect(result?.attachments[0]?.sizeBytes).toBe(20480)
})

test('toma el caption de una imagen como texto', () => {
  const result = normalizeWAMessage(
    waMessage({
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'mirá esto', fileLength: 1000 } },
    }),
    SELF,
  )
  expect(result?.text).toBe('mirá esto')
  expect(result?.attachments[0]?.kind).toBe('image')
})

test('devuelve null si falta la clave o el id', () => {
  expect(normalizeWAMessage(waMessage({ key: { remoteJid: null, id: null } }), SELF)).toBeNull()
})

test('devuelve null para mensajes sin contenido interpretable', () => {
  expect(normalizeWAMessage(waMessage({ message: {} }), SELF)).toBeNull()
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/providers/whatsapp/normalize.test.ts`
Expected: FAIL, no resuelve `normalize.ts`.

- [ ] **Step 3: Implementar la normalización**

```ts
// src/providers/whatsapp/normalize.ts
import type { WAMessage, proto } from 'baileys'
import type {
  AttachmentKind,
  ConversationKind,
  InboundAttachment,
  InboundMessage,
} from '../../domain/types.ts'

/** Desenvuelve las capas con las que WhatsApp anida el contenido real. */
function unwrap(content: proto.IMessage | null | undefined): proto.IMessage | null {
  let current = content ?? null
  for (let depth = 0; current && depth < 4; depth += 1) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.documentWithCaptionMessage?.message ??
      null
    if (!inner) return current
    current = inner
  }
  return current
}

function conversationKind(remoteJid: string): ConversationKind {
  if (remoteJid.endsWith('@g.us')) return 'group'
  if (remoteJid.endsWith('@newsletter')) return 'channel'
  return 'dm'
}

interface MediaSpec {
  kind: AttachmentKind
  mimeType: string | null
  sizeBytes: number | null
  durationMs: number | null
  caption: string | null
}

function mediaSpec(content: proto.IMessage): MediaSpec | null {
  // `fileLength` llega como number o como Long de protobufjs según el caso,
  // y Number() cubre las dos formas sin importar el tipo Long.
  const toBytes = (value: unknown): number | null => {
    if (value === null || value === undefined) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (content.audioMessage) {
    const m = content.audioMessage
    return {
      kind: 'audio',
      mimeType: m.mimetype ?? null,
      sizeBytes: toBytes(m.fileLength),
      durationMs: m.seconds ? m.seconds * 1000 : null,
      caption: null,
    }
  }
  if (content.imageMessage) {
    const m = content.imageMessage
    return {
      kind: 'image',
      mimeType: m.mimetype ?? null,
      sizeBytes: toBytes(m.fileLength),
      durationMs: null,
      caption: m.caption ?? null,
    }
  }
  if (content.videoMessage) {
    const m = content.videoMessage
    return {
      kind: 'video',
      mimeType: m.mimetype ?? null,
      sizeBytes: toBytes(m.fileLength),
      durationMs: m.seconds ? m.seconds * 1000 : null,
      caption: m.caption ?? null,
    }
  }
  if (content.documentMessage) {
    const m = content.documentMessage
    return {
      kind: 'document',
      mimeType: m.mimetype ?? null,
      sizeBytes: toBytes(m.fileLength),
      durationMs: null,
      caption: m.caption ?? null,
    }
  }
  if (content.stickerMessage) {
    const m = content.stickerMessage
    return {
      kind: 'sticker',
      mimeType: m.mimetype ?? null,
      sizeBytes: toBytes(m.fileLength),
      durationMs: null,
      caption: null,
    }
  }
  return null
}

function plainText(content: proto.IMessage): string | null {
  return content.conversation ?? content.extendedTextMessage?.text ?? null
}

export function normalizeWAMessage(waMessage: WAMessage, selfJid: string): InboundMessage | null {
  const remoteJid = waMessage.key?.remoteJid
  const externalId = waMessage.key?.id
  if (!remoteJid || !externalId) return null

  const content = unwrap(waMessage.message)
  if (!content) return null

  const media = mediaSpec(content)
  const text = plainText(content) ?? media?.caption ?? null
  if (text === null && !media) return null

  const fromSelf = waMessage.key?.fromMe === true
  const kind = conversationKind(remoteJid)

  const senderJid = fromSelf
    ? selfJid
    : kind === 'group'
      ? (waMessage.key?.participant ?? null)
      : remoteJid

  const attachments: InboundAttachment[] = media
    ? [
        {
          externalId: `${externalId}:0`,
          kind: media.kind,
          mimeType: media.mimeType,
          sizeBytes: media.sizeBytes,
          durationMs: media.durationMs,
        },
      ]
    : []

  const timestamp = Number(waMessage.messageTimestamp ?? 0)

  return {
    provider: 'whatsapp',
    externalId,
    conversation: {
      externalId: remoteJid,
      kind,
      name: kind === 'group' ? null : (waMessage.pushName ?? null),
    },
    sender: senderJid
      ? { externalId: senderJid, displayName: fromSelf ? null : (waMessage.pushName ?? null) }
      : null,
    sentAt: new Date(timestamp * 1000),
    fromSelf,
    text,
    subject: null,
    threadExternalId: null,
    replyToExternalId:
      content.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    attachments,
    raw: waMessage,
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `bun test tests/providers/whatsapp/normalize.test.ts`
Expected: PASS, 9 tests. Si alguna propiedad de `proto.IMessage` no existe con ese nombre en la versión instalada, verificar contra `node_modules/baileys/lib/Types/` antes de cambiar el test.

- [ ] **Step 5: Verificar tipos y commitear**

```bash
bun run typecheck
git add src/providers/whatsapp/normalize.ts tests/providers/whatsapp
git commit -m "feat: normalización de mensajes de WhatsApp a tipos de dominio"
```

---

### Task 10: Adaptador de WhatsApp

**Files:**
- Create: `src/providers/whatsapp/index.ts`
- Create: `src/providers/registry.ts`
- Test: `tests/providers/registry.test.ts`

**Interfaces:**
- Consumes: puerto de Task 4, `normalizeWAMessage` de Task 9
- Produces: `class WhatsAppProvider implements MessagingProvider` construida con `{ authDir: string; mediaDir: string; log?: Logger }`, y `createProvider(id: ProviderId, config: Config): MessagingProvider`.

La conexión real no se testea de forma automatizada. Lo que sí se testea es que la factory devuelva el adaptador correcto sin conectarse.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/providers/registry.test.ts
import { test, expect } from 'bun:test'
import { createProvider } from '../../src/providers/registry.ts'
import { loadConfig } from '../../src/config/index.ts'

const config = loadConfig({ DATABASE_URL: 'postgres://bot:bot@localhost:5433/botwhatsapp' })

test('devuelve el adaptador falso', () => {
  expect(createProvider('fake', config).id).toBe('fake')
})

test('devuelve el adaptador de WhatsApp sin conectar', () => {
  expect(createProvider('whatsapp', config).id).toBe('whatsapp')
})

test('rechaza un proveedor no implementado', () => {
  // @ts-expect-error se prueba a propósito un valor fuera de lo soportado
  expect(() => createProvider('telegram', config)).toThrow(/no implementado/)
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/providers/registry.test.ts`
Expected: FAIL, no resuelve `registry.ts`.

- [ ] **Step 3: Implementar el adaptador de WhatsApp**

```ts
// src/providers/whatsapp/index.ts
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import qrcode from 'qrcode-terminal'
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from 'baileys'
import type { InboundHandler, MessagingProvider } from '../../domain/provider.ts'
import type {
  ConversationRef,
  ConversationSummary,
  DownloadedMedia,
  InboundMessage,
  OutboundContent,
  ProviderId,
  SentMessage,
} from '../../domain/types.ts'
import { silentLogger, type Logger } from '../../domain/logger.ts'
import { normalizeWAMessage } from './normalize.ts'

export interface WhatsAppProviderOptions {
  authDir: string
  mediaDir: string
  log?: Logger
}

export class WhatsAppProvider implements MessagingProvider {
  readonly id: ProviderId = 'whatsapp'

  private socket: WASocket | null = null
  private handler: InboundHandler | null = null
  private closing = false
  private reconnectDelayMs = 1_000
  private open = false
  private readyWaiters: { resolve: () => void; reject: (error: Error) => void }[] = []

  constructor(private readonly options: WhatsAppProviderOptions) {}

  private get log(): Logger {
    return this.options.log ?? silentLogger
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler
  }

  async connect(): Promise<void> {
    this.closing = false
    await mkdir(this.options.authDir, { recursive: true })
    await mkdir(this.options.mediaDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir)
    const { version } = await fetchLatestBaileysVersion()

    // No se pasa `printQRInTerminal`: está deprecado en esta versión, solo
    // emite una advertencia y no dibuja nada. Baileys exige manejar el QR
    // desde el evento `connection.update`, que es lo que se hace abajo.
    const socket = makeWASocket({
      auth: state,
      version,
      syncFullHistory: true,
    })
    this.socket = socket

    socket.ev.on('creds.update', () => {
      void saveCreds()
    })

    socket.ev.on('connection.update', (update) => {
      if (update.qr) {
        this.log.info('escaneá este QR desde WhatsApp en Dispositivos vinculados')
        // `update.qr` es la carga cruda; hay que dibujarla para que sea
        // escaneable. Imprimirla como texto no sirve.
        qrcode.generate(update.qr, { small: true })
      }
      if (update.connection === 'open') {
        this.reconnectDelayMs = 1_000
        this.open = true
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve()
        this.log.info('conexión establecida con WhatsApp')
      }
      if (update.connection === 'close') {
        void this.handleClose(update.lastDisconnect?.error)
      }
    })

    socket.ev.on('messages.upsert', ({ messages }) => {
      void this.dispatch(messages)
    })

    socket.ev.on('messaging-history.set', ({ messages }) => {
      void this.dispatch(messages)
    })
  }

  /**
   * Espera a que la sesión esté utilizable. El tiempo por defecto es
   * generoso porque la primera vez incluye que una persona escanee el QR.
   */
  async waitUntilReady(timeoutMs = 120_000): Promise<void> {
    if (this.open) return
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.readyWaiters.push(waiter)
      setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter)
        if (index === -1) return
        this.readyWaiters.splice(index, 1)
        reject(new Error(`La conexión no estuvo lista en ${timeoutMs} ms`))
      }, timeoutMs)
    })
  }

  private failReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error)
  }

  private async dispatch(waMessages: readonly unknown[]): Promise<void> {
    const handler = this.handler
    const selfJid = this.socket?.user?.id
    if (!handler || !selfJid) return

    for (const raw of waMessages) {
      const normalized = normalizeWAMessage(raw as Parameters<typeof normalizeWAMessage>[0], selfJid)
      if (!normalized) continue
      try {
        await handler(normalized)
      } catch (error) {
        this.log.error('el manejador falló con un mensaje entrante', {
          externalId: normalized.externalId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async handleClose(error: unknown): Promise<void> {
    this.open = false
    if (this.closing) return

    const statusCode =
      typeof error === 'object' && error !== null && 'output' in error
        ? (error as { output?: { statusCode?: number } }).output?.statusCode
        : undefined

    if (statusCode === DisconnectReason.loggedOut) {
      this.log.error(
        'la sesión se cerró desde el teléfono: borrá el directorio de credenciales y volvé a vincular',
        { authDir: this.options.authDir },
      )
      this.failReadyWaiters(new Error('La sesión de WhatsApp fue cerrada desde el teléfono'))
      return
    }

    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(delay * 2, 60_000)
    this.log.warn('conexión caída, reintentando', { enMs: delay })
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (!this.closing) await this.connect()
  }

  async disconnect(): Promise<void> {
    this.closing = true
    this.open = false
    this.failReadyWaiters(new Error('Se cerró la conexión antes de estar lista'))
    this.socket?.end(undefined)
    this.socket = null
  }

  async send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage> {
    if (!this.socket) throw new Error('WhatsAppProvider sin conectar')
    const sent = await this.socket.sendMessage(
      target.externalId,
      { text: content.text },
      { messageId: idempotencyKey },
    )
    return { externalId: sent?.key?.id ?? idempotencyKey }
  }

  async downloadAttachment(
    message: InboundMessage,
    attachmentExternalId: string,
  ): Promise<DownloadedMedia> {
    const buffer = await downloadMediaMessage(
      message.raw as Parameters<typeof downloadMediaMessage>[0],
      'buffer',
      {},
    )
    const localPath = join(this.options.mediaDir, attachmentExternalId.replace(/[/:]/g, '_'))
    await Bun.write(localPath, buffer as Uint8Array)
    return { localPath, sizeBytes: (buffer as Uint8Array).byteLength }
  }

  async listConversations(): Promise<ConversationSummary[]> {
    if (!this.socket) throw new Error('WhatsAppProvider sin conectar')
    const groups = await this.socket.groupFetchAllParticipating()
    return Object.values(groups).map((group) => ({
      externalId: group.id,
      kind: 'group' as const,
      name: group.subject ?? null,
      participantCount: group.participants?.length ?? null,
    }))
  }
}
```

- [ ] **Step 4: Implementar la factory**

```ts
// src/providers/registry.ts
import type { Config } from '../config/index.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import type { Logger } from '../domain/logger.ts'
import { FakeProvider } from './fake/index.ts'
import { WhatsAppProvider } from './whatsapp/index.ts'

export function createProvider(id: ProviderId, config: Config, log?: Logger): MessagingProvider {
  switch (id) {
    case 'fake':
      return new FakeProvider()
    case 'whatsapp':
      return new WhatsAppProvider({
        authDir: config.WHATSAPP_AUTH_DIR,
        mediaDir: config.MEDIA_DIR,
        log,
      })
    default:
      throw new Error(`Proveedor no implementado: ${id}`)
  }
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `bun test tests/providers/registry.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Verificar tipos y commitear**

```bash
bun run typecheck
git add src/providers tests/providers/registry.test.ts
git commit -m "feat: adaptador de WhatsApp y factory de proveedores"
```

---

### Task 11: Descarga de adjuntos

**Files:**
- Create: `src/capture/media.ts`
- Modify: `src/capture/ingest.ts` (agregar la llamada a la descarga tras persistir)
- Modify: `src/store/repositories/attachments.ts` (agregar `markAttachmentDownloaded` y `markAttachmentFailed`)
- Test: `tests/capture/media.test.ts`

**Interfaces:**
- Consumes: puerto de Task 4, repositorio de adjuntos de Task 8
- Produces:
  - `downloadPendingAttachments(deps: { db: Db; provider: MessagingProvider; log?: Logger }, message: InboundMessage, messageId: string): Promise<void>`
  - `markAttachmentDownloaded(db: Db, messageId: string, externalId: string, localPath: string, sizeBytes: number): Promise<void>`
  - `markAttachmentFailed(db: Db, messageId: string, externalId: string, error: string): Promise<void>`

Los bytes se bajan al llegar, porque WhatsApp deja de servirlos después. El procesamiento con IA es perezoso y lo hace otro plan. Un fallo de descarga nunca impide que el mensaje quede guardado.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/capture/media.test.ts
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import type { InboundMessage } from '../../src/domain/types.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

function conAudio(): InboundMessage {
  return {
    provider: 'fake',
    externalId: 'm-audio',
    conversation: { externalId: 'c1', kind: 'group', name: 'Grupo' },
    sender: { externalId: 'p1', displayName: 'Ana' },
    sentAt: new Date('2026-08-30T12:00:00Z'),
    fromSelf: false,
    text: null,
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    attachments: [
      { externalId: 'a1', kind: 'audio', mimeType: 'audio/ogg', sizeBytes: 10, durationMs: 3000 },
    ],
    raw: {},
  }
}

beforeAll(async () => {
  await runMigrations(url)
})

beforeEach(async () => {
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await handle.close()
})

test('marca el adjunto como descargado con su ruta local', async () => {
  const provider = new FakeProvider()
  const pipeline = createIngestPipeline({
    db: handle.db,
    policy: { mode: 'all', rules: new Set() },
    provider,
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(conAudio())

  const rows = await handle.sql<{ download_status: string; local_path: string }[]>`
    SELECT download_status, local_path FROM attachments
  `
  expect(rows[0]?.download_status).toBe('ok')
  expect(rows[0]?.local_path).toBe('/tmp/fake/a1')
})

test('un fallo de descarga no impide guardar el mensaje', async () => {
  const provider = new FakeProvider()
  provider.downloadAttachment = async () => {
    throw new Error('adjunto expirado')
  }
  const pipeline = createIngestPipeline({
    db: handle.db,
    policy: { mode: 'all', rules: new Set() },
    provider,
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()

  await provider.inject(conAudio())

  const mensajes = await handle.sql`SELECT 1 FROM messages`
  expect(mensajes).toHaveLength(1)

  const adjuntos = await handle.sql<{ download_status: string; download_error: string }[]>`
    SELECT download_status, download_error FROM attachments
  `
  expect(adjuntos[0]?.download_status).toBe('failed')
  expect(adjuntos[0]?.download_error).toContain('adjunto expirado')
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/capture/media.test.ts`
Expected: FAIL, el estado del adjunto queda en `pending` porque nadie lo descarga.

- [ ] **Step 3: Agregar los marcadores al repositorio de adjuntos**

Primero, en la cabecera de `src/store/repositories/attachments.ts`, agregar el import que estas funciones necesitan:

```ts
import { and, eq, sql } from 'drizzle-orm'
```

Después, agregar las dos funciones al final del mismo archivo:

```ts
export async function markAttachmentDownloaded(
  db: Db,
  messageId: string,
  externalId: string,
  localPath: string,
  sizeBytes: number,
): Promise<void> {
  await db
    .update(attachments)
    .set({ downloadStatus: 'ok', localPath, sizeBytes, downloadError: null })
    .where(and(eq(attachments.messageId, messageId), eq(attachments.externalId, externalId)))
}

export async function markAttachmentFailed(
  db: Db,
  messageId: string,
  externalId: string,
  error: string,
): Promise<void> {
  await db
    .update(attachments)
    .set({
      downloadStatus: 'failed',
      downloadError: error,
      downloadAttempts: sql`${attachments.downloadAttempts} + 1`,
    })
    .where(and(eq(attachments.messageId, messageId), eq(attachments.externalId, externalId)))
}
```

- [ ] **Step 4: Implementar la descarga**

```ts
// src/capture/media.ts
import type { Db } from '../store/client.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { InboundMessage } from '../domain/types.ts'
import {
  markAttachmentDownloaded,
  markAttachmentFailed,
} from '../store/repositories/attachments.ts'
import type { Logger } from '../domain/logger.ts'

export interface MediaDeps {
  db: Db
  provider: MessagingProvider
  log?: Logger
}

export async function downloadPendingAttachments(
  deps: MediaDeps,
  message: InboundMessage,
  messageId: string,
): Promise<void> {
  for (const attachment of message.attachments) {
    try {
      const media = await deps.provider.downloadAttachment(message, attachment.externalId)
      await markAttachmentDownloaded(
        deps.db,
        messageId,
        attachment.externalId,
        media.localPath,
        media.sizeBytes,
      )
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error)
      await markAttachmentFailed(deps.db, messageId, attachment.externalId, detalle)
      deps.log?.warn('no se pudo descargar un adjunto', {
        externalId: attachment.externalId,
        error: detalle,
      })
    }
  }
}
```

- [ ] **Step 5: Conectar la descarga al pipeline**

En `src/capture/ingest.ts`, agregar el import y reemplazar el bloque `if (inserted)` de la función `persist`:

```ts
import { downloadPendingAttachments } from './media.ts'
```

```ts
    if (inserted) {
      await insertAttachments(deps.db, id, message.attachments)
      await downloadPendingAttachments(
        { db: deps.db, provider: deps.provider, log },
        message,
        id,
      )
    }
```

- [ ] **Step 6: Correr los tests y verificar que pasan**

Run: `bun test tests/capture/`
Expected: PASS, todos los tests de captura incluidos los dos nuevos.

- [ ] **Step 7: Verificar tipos y commitear**

```bash
bun run typecheck
git add src/capture src/store/repositories/attachments.ts tests/capture/media.test.ts
git commit -m "feat: descarga de adjuntos resiliente a fallos"
```

---

### Task 12: Punto de entrada y listado de conversaciones

**Files:**
- Create: `src/index.ts`
- Create: `src/logger.ts`
- Test: `tests/logger.test.ts`

**Interfaces:**
- Consumes: todo lo anterior
- Produces: `createLogger(level: Config['LOG_LEVEL']): Logger` y un ejecutable que acepta el subcomando `list-conversations`.

El listado resuelve el problema práctico de conseguir el identificador del grupo de control, que hace falta antes de que el plan siguiente pueda responder algo.

- [ ] **Step 1: Escribir el test que falla**

```ts
// tests/logger.test.ts
import { test, expect } from 'bun:test'
import { createLogger } from '../src/logger.ts'

test('filtra por nivel', () => {
  const lineas: string[] = []
  const original = console.log
  console.log = (linea: string) => lineas.push(linea)
  try {
    const log = createLogger('warn')
    log.info('esto no se ve')
    log.warn('esto sí')
  } finally {
    console.log = original
  }
  expect(lineas).toHaveLength(1)
  expect(lineas[0]).toContain('esto sí')
})

test('incluye los metadatos como JSON', () => {
  const lineas: string[] = []
  const original = console.log
  console.log = (linea: string) => lineas.push(linea)
  try {
    createLogger('info').info('hola', { a: 1 })
  } finally {
    console.log = original
  }
  expect(lineas[0]).toContain('{"a":1}')
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun test tests/logger.test.ts`
Expected: FAIL, no resuelve `../src/logger.ts`.

- [ ] **Step 3: Implementar el logger**

```ts
// src/logger.ts
import type { Config } from './config/index.ts'
import type { Logger } from './domain/logger.ts'

const orden = { debug: 10, info: 20, warn: 30, error: 40 } as const

export function createLogger(level: Config['LOG_LEVEL']): Logger {
  const minimo = orden[level]

  const emitir =
    (nivel: keyof typeof orden) =>
    (message: string, meta?: Record<string, unknown>): void => {
      if (orden[nivel] < minimo) return
      const sufijo = meta ? ` ${JSON.stringify(meta)}` : ''
      console.log(`${new Date().toISOString()} ${nivel.toUpperCase()} ${message}${sufijo}`)
    }

  return { info: emitir('info'), warn: emitir('warn'), error: emitir('error') }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `bun test tests/logger.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Implementar el punto de entrada**

```ts
// src/index.ts
import { loadConfig } from './config/index.ts'
import { createLogger } from './logger.ts'
import { createDb } from './store/client.ts'
import { createProvider } from './providers/registry.ts'
import { loadCapturePolicy } from './store/repositories/capture-policy.ts'
import { createIngestPipeline } from './capture/ingest.ts'

const config = loadConfig()
const log = createLogger(config.LOG_LEVEL)
const { db, close } = createDb(config.DATABASE_URL)
const provider = createProvider(config.PROVIDER, config, log)

const comando = process.argv[2] ?? 'run'

if (comando === 'list-conversations') {
  await provider.connect()
  await provider.waitUntilReady()
  for (const conversacion of await provider.listConversations()) {
    console.log(`${conversacion.externalId}\t${conversacion.name ?? '(sin nombre)'}`)
  }
  await provider.disconnect()
  await close()
  process.exit(0)
}

const policy = await loadCapturePolicy(db, provider.id)
log.info('política de captura cargada', { modo: policy.mode, reglas: policy.rules.size })

const pipeline = createIngestPipeline({
  db,
  policy,
  provider,
  bufferMax: config.CAPTURE_BUFFER_MAX,
  log,
})

provider.onMessage(pipeline.handle)

// Reintenta lo que quedó en el buffer cuando la base no respondía.
const reintento = setInterval(() => {
  void pipeline.flushBuffer()
}, 30_000)

const apagar = async (): Promise<void> => {
  clearInterval(reintento)
  await provider.disconnect()
  await close()
  process.exit(0)
}

process.on('SIGINT', () => void apagar())
process.on('SIGTERM', () => void apagar())

await provider.connect()
log.info('capturando mensajes')
```

- [ ] **Step 6: Correr la suite completa y verificar tipos**

```bash
bun run db:up
bun run db:migrate
bun test
bun run typecheck
```

Expected: todos los tests en verde y sin errores de tipos.

- [ ] **Step 7: Prueba manual de vinculación**

```bash
bun run src/index.ts list-conversations
```

Expected: aparece un QR en la terminal la primera vez. Al escanearlo desde WhatsApp en Dispositivos vinculados, se listan los grupos con sus identificadores. Copiar el del grupo de control a `CONTROL_CONVERSATION_ID` en `.env`.

- [ ] **Step 8: Commitear**

```bash
git add src/index.ts src/logger.ts tests/logger.test.ts
git commit -m "feat: punto de entrada de captura y listado de conversaciones"
```

---

## Verificación final del plan

- [ ] `bun test` pasa completo
- [ ] `bun run typecheck` sin errores
- [ ] El bot se vincula, lista los grupos y persiste mensajes reales en Postgres
- [ ] Ningún archivo de `src/capture`, `src/store` o `src/domain` importa `baileys`
- [ ] `data/` y `.env` no aparecen en `git status`

## Planes siguientes

Este plan deja un capturador funcionando. Lo que resta, en orden, cada uno con su propio plan:

1. **Cola de salida y bucle de control**: tablas `outbound_messages`, `bot_messages` y `pending_clarifications`, el despachador con reintentos y fijación de `messageId`, y el módulo de control que distingue tus mensajes de los del bot. Deja un bot que contesta en el grupo, todavía sin resumir.
2. **Resúmenes**: registry de proveedores del AI SDK, intérprete de lenguaje natural con tool calling, renderizado de transcripciones con presupuesto de tokens, troceado por día en la zona horaria configurada, resumen jerárquico con caché invalidado por modelo y prompt, y las tablas de preferencias con su cascada y alias.
3. **Media y búsqueda semántica**: enriquecimiento perezoso de audios e imágenes con caché en `attachment_derivations`, embeddings perezosos acotados por conversación y rango, e índice HNSW sobre la columna vectorial.
