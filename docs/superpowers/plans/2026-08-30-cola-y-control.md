# Cola de salida y bucle de control — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un bot que, además de capturar, distingue tus mensajes en el grupo de control de los que mandó él, encola una respuesta y la entrega con reintentos. Todavía no resume.

**Architecture:** La captura sigue igual. Un clasificador puro decide si un `InboundMessage` es un pedido. Si lo es, un manejador de control (en este plan, un stub) produce texto y lo escribe en `outbound_messages`. Un despachador toma filas vencidas, llama `provider.send` solo contra la conversación de control, y registra el ID enviado en `bot_messages`. El apagado gana un tope de tiempo que cubre el proceso entero.

**Tech Stack:** El mismo de fundación: Bun, TypeScript estricto, Drizzle, `bun test`, FakeProvider. Sin AI SDK.

## Global Constraints

- Runtime y gestor de paquetes: Bun. Nunca `npm install` ni `npx` para dependencias del proyecto.
- TypeScript estricto. Prohibido `any`. El campo `raw` es `unknown`.
- Nada en `src/capture`, `src/store` o `src/domain` importa `baileys`. El test `tests/arquitectura.test.ts` lo verifica.
- El bot no tiene camino de código que envíe a una conversación que no sea la de control. `enqueue` y el despachador rechazan cualquier otro destino.
- La ingesta no puede fallar porque falle el control o el despachador.
- Tests antes de la implementación, en todas las tareas.
- Un commit por tarea como mínimo.
- Esquema y consultas según `.agents/skills/drizzle`: nada de `pgEnum`, se usa `text().$type<Union>()`; siempre `db.select()`; clave primaria de una sola columna; unicidad de negocio en `uniqueIndex`; JSDoc en columnas cuyo significado no se deduce del nombre.
- `CONTROL_CONVERSATION_ID` vacío desactiva el control: se captura, no se responde. No se lista nada al arrancar.
- Prefijo de las respuestas del bot: `✦ ` (constante `BOT_PREFIX` en `src/control/classify.ts`). El clasificador descarta cualquier texto que lo lleve.
- Backoff del despachador: `min(60, 2 ** attempts)` segundos. No hay tope de intentos: una respuesta no se tira porque WhatsApp estuvo caído una hora.
- Tope del apagado: `SHUTDOWN_TIMEOUT_MS`, default `15000`. Cubre el apagado entero, no solo `disconnect`.
- No se crea la tabla `sync_state`. No hay lector; es YAGNI hasta que alguien mida el history sync.

## Mapa de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `src/domain/types.ts` | Suma `OutboundStatus` |
| `src/store/schema.ts` | Tablas `outbound_messages`, `bot_messages`, `pending_clarifications` |
| `src/store/repositories/outbox.ts` | Encolar, reclamar, marcar enviado/fallido |
| `src/store/repositories/bot-messages.ts` | Registrar y consultar IDs enviados por el bot |
| `src/store/repositories/clarifications.ts` | Guardar y leer el pedido en espera |
| `src/outbox/dispatcher.ts` | Toma vencidos, envía, reprograma |
| `src/control/classify.ts` | Función pura: ¿este mensaje es un pedido? |
| `src/control/guard.ts` | ¿El destino es la conversación de control? |
| `src/control/loop.ts` | Orquesta clasificar → stub → encolar |
| `src/control/stub.ts` | Respuestas fijas (`ayuda` / resto). El plan de resúmenes lo reemplaza |
| `src/config/index.ts` | Suma `SHUTDOWN_TIMEOUT_MS` |
| `src/shutdown.ts` | Tope de tiempo sobre el apagado entero |
| `src/index.ts` | Cablea control y despachador sin romper la captura |
| `tests/helpers/db.ts` | Pool de test y truncate compartido, para no repetir URLs |

---

### Task 1: Tipos de salida y esquema

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/store/schema.ts`
- Create: `drizzle/0002_*.sql` (el nombre lo pone `bun run db:generate`)
- Test: `tests/store/schema.test.ts` (extender)

**Interfaces:**
- Consumes: tablas actuales de `src/store/schema.ts`
- Produces: `OutboundStatus = 'pending' | 'sending' | 'sent' | 'failed'`; tablas `outboundMessages`, `botMessages`, `pendingClarifications`

- [ ] **Step 1: Escribir el test que falla**

En `tests/store/schema.test.ts` agregar, junto a los tests que ya existen, uno que inserte una fila de cada tabla nueva y lea las columnas. El truncate del `beforeAll` de ese archivo hoy solo nombra las tablas viejas: hay que sumar las tres nuevas ahí y en el `afterAll`.

```ts
test('outbound_messages, bot_messages y pending_clarifications aceptan una fila', async () => {
  const [conversation] = await handle.db
    .insert(conversations)
    .values({ provider: 'fake', externalId: 'ctrl', kind: 'group', name: 'Control' })
    .returning({ id: conversations.id })

  const [out] = await handle.db
    .insert(outboundMessages)
    .values({
      provider: 'fake',
      conversationExternalId: 'ctrl',
      text: '✦ hola',
      idempotencyKey: 'idemp-1',
      status: 'pending',
    })
    .returning({ id: outboundMessages.id, status: outboundMessages.status })

  await handle.db.insert(botMessages).values({
    provider: 'fake',
    externalId: 'bot-1',
    outboundId: out!.id,
  })

  await handle.db.insert(pendingClarifications).values({
    provider: 'fake',
    conversationExternalId: 'ctrl',
    originalText: 'resumime eso',
    question: '¿Cuál grupo?',
    expiresAt: new Date('2026-08-31T00:00:00Z'),
  })

  expect(out?.status).toBe('pending')
  expect(conversation?.id).toBeDefined()
})
```

- [ ] **Step 2: Correr el test y ver que falla**

```bash
bun test tests/store/schema.test.ts
```

Expected: FAIL porque las tablas no existen en el esquema.

- [ ] **Step 3: Agregar el tipo y las tablas**

En `src/domain/types.ts`, junto a `DownloadStatus`:

```ts
/** Estado de una fila de la cola de salida. */
export type OutboundStatus = 'pending' | 'sending' | 'sent' | 'failed'
```

En `src/store/schema.ts`, importar `OutboundStatus` y agregar al final:

```ts
/**
 * Respuestas a enviar. El despachador reclama las `pending` con
 * `next_attempt_at` vencido, las marca `sending` y después `sent` o
 * vuelve a `pending` con backoff. `failed` queda para un error que no
 * se reintenta (destino fuera de control).
 */
export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    conversationExternalId: text('conversation_external_id').notNull(),
    text: text('text').notNull(),
    /**
     * Se usa como `messageId` en Baileys. Un reintento con la misma clave
     * produce el mismo ID y WhatsApp lo descarta como duplicado.
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
 * IDs de mensajes que el bot envió. El clasificador los consulta para no
 * tratar una respuesta propia como pedido.
 */
export const botMessages = pgTable(
  'bot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ProviderId>().notNull(),
    /** Identificador nativo del mensaje enviado. En WhatsApp es el ID de Baileys. */
    externalId: text('external_id').notNull(),
    outboundId: uuid('outbound_id').references(() => outboundMessages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bot_messages_provider_external_id_idx').on(t.provider, t.externalId)],
)

/**
 * Pedido en espera cuando el bot preguntó de vuelta. Una sola fila activa
 * por conversación de control: un pedido nuevo reemplaza al anterior.
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
```

- [ ] **Step 4: Generar y aplicar la migración**

```bash
bun run db:generate
bun run db:migrate
```

Expected: un archivo nuevo en `drizzle/` y `Migraciones aplicadas`. No editar el SQL a mano.

- [ ] **Step 5: Correr el test y commitear**

```bash
bun test tests/store/schema.test.ts
```

Expected: PASS.

```bash
git add src/domain/types.ts src/store/schema.ts drizzle tests/store/schema.test.ts
git commit -m "feat: tablas de cola, mensajes del bot y aclaraciones"
```

---

### Task 2: Helper de base de test y repositorios

**Files:**
- Create: `tests/helpers/db.ts`
- Create: `src/store/repositories/outbox.ts`
- Create: `src/store/repositories/bot-messages.ts`
- Create: `src/store/repositories/clarifications.ts`
- Test: `tests/store/outbox.test.ts`, `tests/store/bot-messages.test.ts`, `tests/store/clarifications.test.ts`

**Interfaces:**
- Consumes: `Db`, las tres tablas nuevas
- Produces:
  - `enqueueOutbound(db, input): Promise<{ id: string }>`
  - `claimDueOutbound(db, now: Date, limit: number): Promise<OutboundRow[]>`
  - `markOutboundSent(db, id, sentExternalId): Promise<void>`
  - `markOutboundFailed(db, id, error, nextAttemptAt, terminal?: boolean): Promise<void>`
  - `recordBotMessage(db, input): Promise<void>`
  - `isBotMessage(db, provider, externalId): Promise<boolean>`
  - `saveClarification(db, input): Promise<void>`
  - `loadActiveClarification(db, provider, conversationExternalId, now): Promise<Clarification | null>`
  - `clearClarification(db, provider, conversationExternalId): Promise<void>`

- [ ] **Step 1: Extraer el helper de base**

`tests/helpers/db.ts` centraliza lo que hoy se copia en cada archivo de store. Los tests viejos pueden seguir como están; los nuevos usan esto.

```ts
import { createDb, type Db } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'

const TABLES = [
  'pending_clarifications',
  'bot_messages',
  'outbound_messages',
  'attachments',
  'messages',
  'participants',
  'conversations',
  'capture_rules',
  'capture_policy',
] as const

export function openTestDb() {
  const handle = createDb(TEST_DATABASE_URL)
  return handle
}

export async function resetTestDb(sql: ReturnType<typeof createDb>['sql']): Promise<void> {
  await runMigrations(TEST_DATABASE_URL)
  await sql.unsafe(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
}
```

- [ ] **Step 2: Escribir los tests que fallan**

`tests/store/outbox.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { outboundMessages } from '../../src/store/schema.ts'
import {
  claimDueOutbound,
  enqueueOutbound,
  markOutboundFailed,
  markOutboundSent,
} from '../../src/store/repositories/outbox.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

const destino = { provider: 'fake' as const, conversationExternalId: 'ctrl' }

test('claimDueOutbound no entrega dos veces la misma fila', async () => {
  await enqueueOutbound(handle.db, { ...destino, text: '✦ a', idempotencyKey: 'k1' })
  const primero = await claimDueOutbound(handle.db, new Date('2026-08-30T12:00:00Z'), 10)
  const segundo = await claimDueOutbound(handle.db, new Date('2026-08-30T12:00:00Z'), 10)
  expect(primero).toHaveLength(1)
  expect(segundo).toHaveLength(0)
})

test('claimDueOutbound ignora lo que todavía no venció', async () => {
  await enqueueOutbound(handle.db, { ...destino, text: '✦ b', idempotencyKey: 'k2' })
  const [claimed] = await claimDueOutbound(handle.db, new Date('2026-08-30T12:00:00Z'), 10)
  await markOutboundFailed(handle.db, claimed!.id, 'socket down', new Date('2026-08-30T12:05:00Z'))
  const ya = await claimDueOutbound(handle.db, new Date('2026-08-30T12:01:00Z'), 10)
  const despues = await claimDueOutbound(handle.db, new Date('2026-08-30T12:06:00Z'), 10)
  expect(ya).toHaveLength(0)
  expect(despues).toHaveLength(1)
})

test('markOutboundSent deja status sent y el id externo', async () => {
  await enqueueOutbound(handle.db, { ...destino, text: '✦ c', idempotencyKey: 'k3' })
  const [claimed] = await claimDueOutbound(handle.db, new Date(), 1)
  await markOutboundSent(handle.db, claimed!.id, 'ext-9')
  const rows = await handle.db.select().from(outboundMessages)
  const fila = rows.find((r) => r.id === claimed!.id)
  expect(fila?.status).toBe('sent')
  expect(fila?.sentExternalId).toBe('ext-9')
})

test('markOutboundFailed con terminal=true no vuelve a pending', async () => {
  await enqueueOutbound(handle.db, { ...destino, text: '✦ d', idempotencyKey: 'k4' })
  const [claimed] = await claimDueOutbound(handle.db, new Date(), 1)
  await markOutboundFailed(handle.db, claimed!.id, 'destino ilegal', new Date(), true)
  const otra = await claimDueOutbound(handle.db, new Date('2099-01-01T00:00:00Z'), 10)
  expect(otra.find((r) => r.id === claimed!.id)).toBeUndefined()
})
```

`tests/store/bot-messages.test.ts`: un `recordBotMessage` + `isBotMessage` verdadero, y uno inexistente falso. Un segundo `record` del mismo par no tira.

`tests/store/clarifications.test.ts`: `save` dos veces sobre el mismo control reemplaza; `loadActive` con `now` posterior a `expiresAt` devuelve `null`; `clear` deja `null`.

- [ ] **Step 3: Correr y ver que fallan**

```bash
bun test tests/store/outbox.test.ts tests/store/bot-messages.test.ts tests/store/clarifications.test.ts
```

Expected: FAIL, módulos no encontrados.

- [ ] **Step 4: Implementar los repositorios**

`claimDueOutbound` tiene que ser atómico. Usar `UPDATE … WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED) RETURNING *` vía `handle`/`sql` de drizzle, o una transacción que seleccione `pending` vencidos y los marque `sending` en el mismo `tx`. `SKIP LOCKED` evita que dos despachadores se lleven la misma fila.

```ts
// src/store/repositories/outbox.ts — claimDueOutbound
export async function claimDueOutbound(
  db: Db,
  now: Date,
  limit: number,
): Promise<OutboundRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.status, 'pending'),
          lte(outboundMessages.nextAttemptAt, now),
        ),
      )
      .orderBy(outboundMessages.nextAttemptAt)
      .limit(limit)
      .for('update', { skipLocked: true })

    if (due.length === 0) return []

    const ids = due.map((row) => row.id)
    await tx
      .update(outboundMessages)
      .set({
        status: 'sending',
        attempts: sql`${outboundMessages.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(outboundMessages.id, ids))

    return due.map((row) => ({ ...row, status: 'sending' as const, attempts: row.attempts + 1 }))
  })
}
```

Verificar contra la versión instalada de Drizzle si `.for('update', { skipLocked: true })` es la API vigente. Si no existe, usar `sql` crudo con `FOR UPDATE SKIP LOCKED`. No adivinar: grep en `node_modules/drizzle-orm`.

`enqueueOutbound` hace insert y, si choca el `idempotencyKey`, no inserta otra fila: `onConflictDoNothing` y devolver el id existente.

`isBotMessage` es un `select` con `limit 1`.

`saveClarification` usa `onConflictDoUpdate` sobre `(provider, conversationExternalId)`.

- [ ] **Step 5: Tests en verde y commit**

```bash
bun test tests/store/outbox.test.ts tests/store/bot-messages.test.ts tests/store/clarifications.test.ts
```

```bash
git add src/store/repositories tests/store tests/helpers/db.ts
git commit -m "feat: repositorios de cola, bot_messages y aclaraciones"
```

---

### Task 3: Guardia de destino y clasificador

**Files:**
- Create: `src/control/guard.ts`
- Create: `src/control/classify.ts`
- Test: `tests/control/guard.test.ts`, `tests/control/classify.test.ts`

**Interfaces:**
- Consumes: `InboundMessage`, `ConversationRef`, `Config` (`CONTROL_PROVIDER`, `CONTROL_CONVERSATION_ID`)
- Produces:
  - `BOT_PREFIX = '✦ '`
  - `isControlTarget(config, target): boolean`
  - `assertControlTarget(config, target): void` — tira `ControlTargetError` si no
  - `classifyControlMessage(input): 'request' | 'ignore'`

- [ ] **Step 1: Tests que fallan**

```ts
// tests/control/guard.test.ts
import { expect, test } from 'bun:test'
import { assertControlTarget, ControlTargetError, isControlTarget } from '../../src/control/guard.ts'

const config = {
  CONTROL_PROVIDER: 'fake' as const,
  CONTROL_CONVERSATION_ID: 'ctrl',
}

test('acepta solo el par proveedor + conversación de control', () => {
  expect(isControlTarget(config, { provider: 'fake', externalId: 'ctrl' })).toBe(true)
  expect(isControlTarget(config, { provider: 'fake', externalId: 'otro' })).toBe(false)
  expect(isControlTarget(config, { provider: 'whatsapp', externalId: 'ctrl' })).toBe(false)
})

test('sin CONTROL_CONVERSATION_ID no hay destino válido', () => {
  expect(isControlTarget({ ...config, CONTROL_CONVERSATION_ID: undefined }, { provider: 'fake', externalId: 'ctrl' })).toBe(false)
})

test('assertControlTarget tira ControlTargetError', () => {
  expect(() => assertControlTarget(config, { provider: 'fake', externalId: 'otro' })).toThrow(ControlTargetError)
})
```

```ts
// tests/control/classify.test.ts
import { expect, test } from 'bun:test'
import { BOT_PREFIX, classifyControlMessage } from '../../src/control/classify.ts'
import { mensaje } from '../helpers/fixtures.ts'

const control = { provider: 'fake' as const, conversationId: 'ctrl' }

test('un mensaje propio en control, sin prefijo y desconocido, es request', () => {
  expect(
    classifyControlMessage({
      message: mensaje({ fromSelf: true, text: 'ayuda', conversation: { externalId: 'ctrl', kind: 'group', name: 'C' } }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('request')
})

test('ignora lo que no es la conversación de control', () => {
  expect(
    classifyControlMessage({
      message: mensaje({ fromSelf: true, text: 'ayuda' }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})

test('ignora lo que no es propio', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: false,
        text: 'ayuda',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})

test('ignora un id ya registrado como enviado por el bot', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: 'ayuda',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: true,
    }),
  ).toBe('ignore')
})

test('ignora el prefijo del bot aunque el id no esté registrado', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: `${BOT_PREFIX}listo`,
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})

test('ignora texto vacío o solo espacios', () => {
  expect(
    classifyControlMessage({
      message: mensaje({
        fromSelf: true,
        text: '   ',
        conversation: { externalId: 'ctrl', kind: 'group', name: 'C' },
      }),
      control,
      isKnownBotMessage: false,
    }),
  ).toBe('ignore')
})
```

- [ ] **Step 2: Correr y ver que fallan**

```bash
bun test tests/control/guard.test.ts tests/control/classify.test.ts
```

- [ ] **Step 3: Implementar**

```ts
// src/control/guard.ts
import type { ConversationRef, ProviderId } from '../domain/types.ts'

export class ControlTargetError extends Error {
  constructor(target: ConversationRef) {
    super(`destino fuera de control: ${target.provider}:${target.externalId}`)
    this.name = 'ControlTargetError'
  }
}

export function isControlTarget(
  config: { CONTROL_PROVIDER: ProviderId; CONTROL_CONVERSATION_ID?: string },
  target: ConversationRef,
): boolean {
  return (
    config.CONTROL_CONVERSATION_ID !== undefined &&
    config.CONTROL_CONVERSATION_ID.length > 0 &&
    target.provider === config.CONTROL_PROVIDER &&
    target.externalId === config.CONTROL_CONVERSATION_ID
  )
}

export function assertControlTarget(
  config: { CONTROL_PROVIDER: ProviderId; CONTROL_CONVERSATION_ID?: string },
  target: ConversationRef,
): void {
  if (!isControlTarget(config, target)) throw new ControlTargetError(target)
}
```

```ts
// src/control/classify.ts
import type { InboundMessage, ProviderId } from '../domain/types.ts'

export const BOT_PREFIX = '✦ '

export function classifyControlMessage(input: {
  message: InboundMessage
  control: { provider: ProviderId; conversationId: string }
  isKnownBotMessage: boolean
}): 'request' | 'ignore' {
  const { message, control, isKnownBotMessage } = input
  if (message.provider !== control.provider) return 'ignore'
  if (message.conversation.externalId !== control.conversationId) return 'ignore'
  if (!message.fromSelf) return 'ignore'
  if (isKnownBotMessage) return 'ignore'
  const text = message.text?.trim() ?? ''
  if (text.length === 0) return 'ignore'
  if (text.startsWith(BOT_PREFIX.trimEnd()) || text.startsWith(BOT_PREFIX)) return 'ignore'
  return 'request'
}
```

El chequeo del prefijo tiene que cubrir `✦` y `✦ ` para no entrar en loop si alguien recorta el espacio.

- [ ] **Step 4: Tests en verde y commit**

```bash
bun test tests/control/guard.test.ts tests/control/classify.test.ts
git add src/control tests/control
git commit -m "feat: clasifica pedidos y prohíbe destinos fuera de control"
```

---

### Task 4: Stub de respuestas y bucle de control

**Files:**
- Create: `src/control/stub.ts`
- Create: `src/control/loop.ts`
- Test: `tests/control/stub.test.ts`, `tests/control/loop.test.ts`

**Interfaces:**
- Consumes: clasificador, guardia, `enqueueOutbound`, `isBotMessage`
- Produces:
  - `replyFor(text: string): string` — siempre con `BOT_PREFIX`
  - `createControlLoop(deps): { handle(message: InboundMessage): Promise<void> }`

El stub es deliberadamente tonto. El plan de resúmenes lo sustituye por el intérprete. Las cadenas exactas, para que los tests e2e no dependan de un LLM:

- texto igual a `ayuda` (sin importar mayúsculas) → `✦ Puedo contestar acá. Los resúmenes todavía no están.`
- cualquier otro pedido → `✦ Todavía no sé resumir. Escribí ayuda para ver qué puedo hacer.`

- [ ] **Step 1: Tests del stub**

```ts
import { expect, test } from 'bun:test'
import { BOT_PREFIX } from '../../src/control/classify.ts'
import { replyFor } from '../../src/control/stub.ts'

test('ayuda explica el estado', () => {
  expect(replyFor('ayuda')).toBe(`${BOT_PREFIX}Puedo contestar acá. Los resúmenes todavía no están.`)
  expect(replyFor('AYUDA')).toBe(`${BOT_PREFIX}Puedo contestar acá. Los resúmenes todavía no están.`)
})

test('cualquier otra cosa avisa que no resume', () => {
  expect(replyFor('resumime la facu')).toStartWith(BOT_PREFIX)
  expect(replyFor('resumime la facu')).toContain('Todavía no sé resumir')
})
```

- [ ] **Step 2: Tests del loop contra FakeProvider y la base**

```ts
// tests/control/loop.test.ts — casos
// 1. inject de un pedido en control → una fila pending en outbound, texto con BOT_PREFIX
// 2. inject de un mensaje en otro chat → cero filas
// 3. inject de un mensaje cuyo externalId ya está en bot_messages → cero filas
// 4. inject de un texto que ya lleva BOT_PREFIX → cero filas
// 5. CONTROL_CONVERSATION_ID vacío → cero filas, no tira
// 6. un fallo de enqueue no se propaga: handle resuelve, el log.warn se llamó
```

El loop **no envía**. Solo encola. El despachador es la tarea siguiente.

- [ ] **Step 3: Implementar stub y loop**

```ts
// src/control/loop.ts (esqueleto)
export function createControlLoop(deps: {
  db: Db
  config: Pick<Config, 'CONTROL_PROVIDER' | 'CONTROL_CONVERSATION_ID'>
  log: Logger
}) {
  async function handle(message: InboundMessage): Promise<void> {
    const conversationId = deps.config.CONTROL_CONVERSATION_ID
    if (!conversationId) return
    try {
      const known = await isBotMessage(deps.db, message.provider, message.externalId)
      if (
        classifyControlMessage({
          message,
          control: { provider: deps.config.CONTROL_PROVIDER, conversationId },
          isKnownBotMessage: known,
        }) !== 'request'
      ) {
        return
      }
      const text = replyFor(message.text ?? '')
      const target = { provider: message.provider, externalId: conversationId }
      assertControlTarget(deps.config, target)
      await enqueueOutbound(deps.db, {
        provider: target.provider,
        conversationExternalId: target.externalId,
        text,
        idempotencyKey: crypto.randomUUID(),
      })
    } catch (error) {
      deps.log.warn('control no pudo encolar la respuesta', {
        externalId: message.externalId,
        error: describirError(error),
      })
    }
  }

  return { handle }
}
```

La captura ya persistió el mensaje cuando el loop corre. El loop no toca el pipeline.

- [ ] **Step 4: Tests en verde y commit**

```bash
bun test tests/control/stub.test.ts tests/control/loop.test.ts
git add src/control tests/control
git commit -m "feat: bucle de control que encola respuestas stub"
```

---

### Task 5: Despachador

**Files:**
- Create: `src/outbox/dispatcher.ts`
- Test: `tests/outbox/dispatcher.test.ts`

**Interfaces:**
- Consumes: `claimDueOutbound`, `markOutboundSent`, `markOutboundFailed`, `recordBotMessage`, `assertControlTarget`, `MessagingProvider.send`
- Produces: `createDispatcher(deps): { tick(now?: Date): Promise<number>; start(intervalMs: number): () => void }`
  - `tick` procesa hasta 10 vencidos y devuelve cuántos envió
  - `start` arma un `setInterval`; el stop se pasa al shutdown

Backoff:

```ts
export function nextBackoff(attempts: number): Date {
  const seconds = Math.min(60, 2 ** Math.max(0, attempts - 1))
  return new Date(Date.now() + seconds * 1000)
}
```

`attempts` ya viene incrementado por `claimDueOutbound`. El primer fallo (attempts=1) espera 1s; el segundo, 2s; el sexto y siguientes, 60s.

- [ ] **Step 1: Tests que fallan**

```ts
// tests/outbox/dispatcher.test.ts
// 1. una fila pending + tick → FakeProvider.sent tiene un registro,
//    idempotencyKey === el de la fila, destino === control,
//    bot_messages tiene el externalId, status sent
// 2. failNextSend + tick → status pending, nextAttemptAt en el futuro, lastError seteado
// 3. segundo tick después de vencer → se envía
// 4. destino distinto de control → no llama send, status failed terminal, log.error
// 5. tick sin filas → 0, no llama send
```

Para el caso 4 hay que insertar la fila a mano, porque `enqueueOutbound` del loop no puede producirla. El despachador es la segunda traba.

- [ ] **Step 2: Correr y ver que fallan**

```bash
bun test tests/outbox/dispatcher.test.ts
```

- [ ] **Step 3: Implementar**

```ts
export function createDispatcher(deps: {
  db: Db
  provider: MessagingProvider
  config: Pick<Config, 'CONTROL_PROVIDER' | 'CONTROL_CONVERSATION_ID'>
  log: Logger
}) {
  async function tick(now = new Date()): Promise<number> {
    const due = await claimDueOutbound(deps.db, now, 10)
    let sent = 0
    for (const row of due) {
      const target = { provider: row.provider, externalId: row.conversationExternalId }
      try {
        assertControlTarget(deps.config, target)
        const result = await deps.provider.send(target, { text: row.text }, row.idempotencyKey)
        await markOutboundSent(deps.db, row.id, result.externalId)
        await recordBotMessage(deps.db, {
          provider: row.provider,
          externalId: result.externalId,
          outboundId: row.id,
        })
        sent += 1
      } catch (error) {
        const terminal = error instanceof ControlTargetError
        await markOutboundFailed(
          deps.db,
          row.id,
          describirError(error),
          terminal ? now : nextBackoff(row.attempts),
          terminal,
        )
        deps.log.warn('despacho fallido', {
          id: row.id,
          terminal,
          error: describirError(error),
        })
      }
    }
    return sent
  }

  function start(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void tick().catch((error) => {
        deps.log.error('tick del despachador reventó', { error: describirError(error) })
      })
    }, intervalMs)
    return () => clearInterval(timer)
  }

  return { tick, start }
}
```

Un `tick` que tire no puede tumbar el proceso: el `start` atrapa. Un fallo por fila no aborta el resto del lote.

- [ ] **Step 4: Tests en verde y commit**

```bash
bun test tests/outbox/dispatcher.test.ts
git add src/outbox tests/outbox
git commit -m "feat: despachador de salida con backoff y destino único"
```

---

### Task 6: Tope de tiempo del apagado

**Files:**
- Modify: `src/config/index.ts`, `.env.example`, `tests/config.test.ts`
- Modify: `src/shutdown.ts`, `tests/shutdown.test.ts`

**Interfaces:**
- Consumes: `createShutdown` actual
- Produces: `Config.SHUTDOWN_TIMEOUT_MS: number` (default 15000). `apagar()` resuelve en menos de ese tiempo aunque un paso cuelgue. Lo que quede en el buffer se cuenta como perdido.

Este es el pendiente que dejó la revisión de fundación: `disconnect` espera despachos en vuelo, y un `persist` colgado contra una base muda deja el apagado sin salida.

- [ ] **Step 1: Extender `tests/config.test.ts`**

```ts
test('aplica SHUTDOWN_TIMEOUT_MS por defecto', () => {
  expect(loadConfig(base).SHUTDOWN_TIMEOUT_MS).toBe(15_000)
})

test('convierte SHUTDOWN_TIMEOUT_MS a número', () => {
  expect(loadConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '8' }).SHUTDOWN_TIMEOUT_MS).toBe(8)
})
```

- [ ] **Step 2: Test del apagado que cuelga**

En `tests/shutdown.test.ts`, un entorno cuyo `flushBuffer` nunca resuelve. `apagar()` con `timeoutMs: 20` tiene que resolver, devolver los pendientes como perdidos y no dejar el test colgado.

```ts
test('un vaciado colgado no impide salir', async () => {
  const entorno = crearEntorno({ pendientes: 3, cuelgaVaciado: true })
  const perdidos = await entorno.shutdown.apagar()
  expect(perdidos).toBe(3)
})
```

Extender `crearEntorno` para aceptar `timeoutMs` y `cuelgaVaciado`. El `flushBuffer` colgado es `new Promise(() => {})`.

- [ ] **Step 3: Implementar**

`createShutdown` recibe `timeoutMs`. `correr()` se envuelve en `Promise.race` contra un timer. Si gana el timer: log.error `'apagado: se agotó el tiempo'`, devolver `pipeline.bufferSize`, y **igual** intentar `closeDb` y `disconnect` sin esperarlos más que el tiempo ya gastado — o sea, no bloquear otra vez. Lo práctico: al vencer, se dispara `void deps.provider.disconnect()` y `void deps.closeDb()` sin await, se loguea y se devuelve.

El timer se limpia si el apagado termina antes. Un timer vivo mantiene el event loop y rompe los tests.

Sumar `SHUTDOWN_TIMEOUT_MS` al schema de zod, default 15000, entero positivo.

- [ ] **Step 4: Tests en verde y commit**

```bash
bun test tests/config.test.ts tests/shutdown.test.ts
git add src/config src/shutdown.ts tests/config.test.ts tests/shutdown.test.ts .env.example
git commit -m "fix: el apagado sale aunque un paso se cuelgue"
```

---

### Task 7: Cablear captura, control y despachador

**Files:**
- Modify: `src/index.ts`
- Modify: `src/shutdown.ts` si hace falta un `stopDispatch`
- Test: `tests/e2e/control.test.ts`

**Interfaces:**
- Consumes: `createIngestPipeline`, `createControlLoop`, `createDispatcher`, `createShutdown`
- Produces: un proceso que captura y contesta en control

El orden del `onMessage` importa: primero persistir, después controlar. Un throw del control no puede impedir la captura, y al revés tampoco. Por eso no se componen con `await a(); await b()` a pelo: cada uno se aísla.

```ts
provider.onMessage(async (message) => {
  try {
    await pipeline.handle(message)
  } catch (error) {
    log.error('ingesta reventó', { error: describirError(error) })
  }
  try {
    await control.handle(message)
  } catch (error) {
    log.warn('control reventó', { error: describirError(error) })
  }
})
```

Hoy `pipeline.handle` ya no tira (mete al buffer). El try sigue siendo el cinturón.

El despachador arranca con intervalo de 1000 ms. Su `stop` se suma a `stopRetries` del shutdown, o se pasa un `stopDispatch` nuevo. Preferir un solo `stopTimers` que corte buffer y despachador, para no agrandar `ShutdownDeps` de más.

Si `CONTROL_CONVERSATION_ID` está vacío, no se crea el loop ni el despachador. Se loguea `'control desactivado: falta CONTROL_CONVERSATION_ID'`.

- [ ] **Step 1: Escribir el e2e que falla**

`tests/e2e/control.test.ts` levanta FakeProvider + Postgres + pipeline + loop + dispatcher, sin `src/index.ts` (ese archivo tiene efectos al importarse). El e2e ensambla las mismas piezas que `index.ts`.

Flujos, los tres que el diseño pide y este plan puede cumplir:

1. Pedido en control → `tick` → `provider.sent` tiene una respuesta con `BOT_PREFIX`, destino `ctrl`.
2. Fallo de envío → la fila queda pending → un segundo `tick` después de vencer entrega.
3. La respuesta del bot, reinyectada como inbound con el mismo `externalId` y `fromSelf: true`, no produce una segunda fila.

Y dos que el diseño lista pero este plan no cierra, y no hay que fingir que sí:

- Pedido ambiguo / pregunta de vuelta: el stub no pregunta. Va en el plan de resúmenes.
- Política de captura: ya la cubre `tests/capture/policy.test.ts`. No repetir.

```ts
test('un pedido en control produce una respuesta enviada', async () => {
  const provider = new FakeProvider()
  await provider.connect()
  const pipeline = createIngestPipeline({ db: handle.db, provider, policy: { mode: 'all', rules: new Set() }, bufferMax: 10 })
  const control = createControlLoop({
    db: handle.db,
    config: { CONTROL_PROVIDER: 'fake', CONTROL_CONVERSATION_ID: 'ctrl' },
    log: silentLogger,
  })
  const dispatcher = createDispatcher({
    db: handle.db,
    provider,
    config: { CONTROL_PROVIDER: 'fake', CONTROL_CONVERSATION_ID: 'ctrl' },
    log: silentLogger,
  })

  provider.onMessage(async (m) => {
    await pipeline.handle(m)
    await control.handle(m)
  })

  await provider.inject(
    mensaje({
      fromSelf: true,
      text: 'ayuda',
      conversation: { externalId: 'ctrl', kind: 'group', name: 'Control' },
    }),
  )
  const enviados = await dispatcher.tick(new Date())
  expect(enviados).toBe(1)
  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.target.externalId).toBe('ctrl')
  expect(provider.sent[0]?.content.text.startsWith('✦ ')).toBe(true)
})
```

- [ ] **Step 2: Correr el e2e**

```bash
bun test tests/e2e/control.test.ts
```

Expected: FAIL hasta cablear, o PASS si el e2e ensambla solo. El e2e no importa `src/index.ts`.

- [ ] **Step 3: Cablear `src/index.ts`**

Leer el archivo actual y agregar el loop y el despachador **después** de crear el pipeline, **antes** de `connect`. Registrar señales igual que ahora. Sumar el stop del despachador al apagado.

No extraer un `createApp` en este plan. `index.ts` ya es el ensamblador; sacarlo es un refactor que no pide el diseño.

- [ ] **Step 4: Suite completa, typecheck y commit**

```bash
bun test
bun run typecheck
```

Expected: PASS, sin errores.

```bash
git add src/index.ts src/shutdown.ts tests/e2e
git commit -m "feat: el proceso captura y contesta en el grupo de control"
```

---

### Task 8: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Actualizar las secciones que este plan cambia**

En **Comandos**, `bun start` ahora captura y, si hay `CONTROL_CONVERSATION_ID`, contesta.

En **Qué falta**, el ítem 1 pasa a hecho. Quedan 2 y 3, apuntando a los planes:

- `docs/superpowers/plans/2026-08-30-resumenes.md`
- `docs/superpowers/plans/2026-08-30-media-y-busqueda.md`

Documentar `BOT_PREFIX` y que sin `CONTROL_CONVERSATION_ID` no se responde.

Documentar `SHUTDOWN_TIMEOUT_MS`.

- [ ] **Step 2: Commit**

```bash
git add README.md .env.example
git commit -m "docs: el bot ya contesta en el grupo de control"
```

## Verificación final

- [ ] `bun test` pasa completo
- [ ] `bun run typecheck` sin errores
- [ ] `tests/arquitectura.test.ts` sigue verde
- [ ] No hay camino que llame `provider.send` con un `externalId` distinto de `CONTROL_CONVERSATION_ID`
- [ ] El stub no importa `ai` ni Ollama

## Fuera de este plan

Resúmenes, preferencias, intérprete, embeddings, transcripción, índice HNSW, y la decisión sobre binarios en `raw`. El stub se borra en el plan de resúmenes, no se deja convivir.
