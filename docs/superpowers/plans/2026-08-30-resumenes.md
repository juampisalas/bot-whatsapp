# Resúmenes jerárquicos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pedidos en lenguaje natural en el grupo de control se traducen a un rango y una conversación, y el bot responde un resumen jerárquico cacheado por día. Todavía no transcribe audios ni busca por tema.

**Architecture:** Un puerto `Llm` envuelve el AI SDK para que `agent/` se teste con un falso y la captura no importe `ai`. El intérprete usa `generateText` con tools y `Output.object`. Los alias se resuelven antes que el modelo. El resumidor parte el rango en días de la zona horaria de las preferencias, reutiliza `chunk_summaries` cuando el conteo, el último mensaje, el modelo y la versión de prompt coinciden, y combina los parciales. El stub de control se reemplaza: el loop llama al intérprete y encola el texto.

**Tech Stack:** `ai` (verificar versión al instalar; el diseño nombra 7.0.85), `ai-sdk-ollama`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/deepseek`. Preferencias en Postgres. Tests con un `FakeLlm`.

## Global Constraints

- Las Global Constraints del plan de cola y control siguen vigentes.
- **Nunca escribir código del AI SDK de memoria.** Después de `bun add ai`, leer `node_modules/ai/docs/` y greppear los exports reales (`stepCountIs` vs `isStepCount`, `inputSchema` vs `parameters`). Context7 (`/websites/ai-sdk_dev`) es respaldo; el paquete instalado gana.
- `agent/`, `control/` y `store/` no importan `baileys`.
- `capture/` no importa `ai` ni `ai-sdk-ollama`. Extender `tests/arquitectura.test.ts` para `ai` en `capture`.
- Modelo de generación por entorno: `LLM_PROVIDER` (`ollama` | `openai` | `anthropic` | `deepseek`) default `ollama`; `LLM_MODEL` default `qwen3.6:35b-a3b`.
- Versión de prompt del resumidor: constante `SUMMARY_PROMPT_VERSION = 1` en `src/agent/summarize/prompt.ts`. Cambiar el texto del prompt exige subir esa constante.
- Zona horaria de los buckets: la de las preferencias globales, no `TIMEZONE` del env. El env queda como default de la primera fila de preferencias.
- El intérprete no elige solo ante ambigüedad: pregunta y guarda `pending_clarifications` (expira en 10 minutos).
- Token caching de Anthropic: marcar el system prompt con `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`. OpenAI y DeepSeek no se marcan. No esperar ahorro real; está porque el diseño lo pide.
- Sin embeddings ni derivaciones de media en este plan. El renderizado de transcripción usa el texto del mensaje y un marcador para cada adjunto (`[nota de voz, 45s]`, `[imagen]`).

## Mapa de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `src/config/index.ts` | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, claves de API |
| `src/store/schema.ts` | `preferences`, `chat_preferences`, `chunk_summaries` |
| `src/store/repositories/preferences.ts` | Cascada y alias |
| `src/store/repositories/chunks.ts` | Caché de parciales |
| `src/store/repositories/conversations.ts` | Búsqueda por nombre y conteo en rango |
| `src/agent/llm/port.ts` | Puerto `Llm` |
| `src/agent/llm/fake.ts` | Falso para tests |
| `src/agent/llm/registry.ts` | Factory del AI SDK |
| `src/agent/preferences.ts` | `ResolvedPreferences` y defaults |
| `src/agent/resolve-conversation.ts` | Alias primero, después similitud de nombre |
| `src/agent/interpret.ts` | Pedido → `SummaryRequest` o `AskUser` |
| `src/agent/transcript.ts` | Render de mensajes con presupuesto |
| `src/agent/buckets.ts` | Partir un rango en días TZ |
| `src/agent/summarize/prompt.ts` | Prompts y `SUMMARY_PROMPT_VERSION` |
| `src/agent/summarize/index.ts` | Jerárquico con caché |
| `src/control/loop.ts` | Deja el stub; llama al intérprete y al resumidor |
| `src/control/stub.ts` | Se borra |

---

### Task 1: Configuración LLM y verificación de APIs

**Files:**
- Modify: `src/config/index.ts`, `.env.example`, `tests/config.test.ts`
- Create: `src/agent/llm/port.ts`

**Interfaces:**
- Consumes: nada del AI SDK todavía, salvo instalarlo
- Produces: campos nuevos en `Config`; el puerto `Llm`

- [ ] **Step 1: Instalar y leer docs instaladas**

```bash
bun add ai ai-sdk-ollama @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/deepseek
```

Fijar versiones exactas las que `bun add` resuelva, y anotarlas en este commit. Después:

```bash
rg -n "export.*(stepCountIs|isStepCount|generateText|embedMany|Output)" node_modules/ai/dist
ls node_modules/ai/docs | head
```

El resto del plan usa `generateText`, `tool`, `Output.object` y el helper de `stopWhen` **con el nombre que exporta el paquete**. Si Context7 dijo `isStepCount` y el paquete exporta `stepCountIs`, se usa el del paquete.

- [ ] **Step 2: Tests de config**

```ts
test('LLM por defecto es ollama / qwen3.6:35b-a3b', () => {
  const config = loadConfig(base)
  expect(config.LLM_PROVIDER).toBe('ollama')
  expect(config.LLM_MODEL).toBe('qwen3.6:35b-a3b')
  expect(config.LLM_BASE_URL).toBe('http://127.0.0.1:11434')
})

test('rechaza un LLM_PROVIDER desconocido', () => {
  expect(() => loadConfig({ ...base, LLM_PROVIDER: 'gemini' })).toThrow(/LLM_PROVIDER/)
})
```

- [ ] **Step 3: Schema zod y puerto**

```ts
LLM_PROVIDER: z.enum(['ollama', 'openai', 'anthropic', 'deepseek']).default('ollama'),
LLM_MODEL: z.string().min(1).default('qwen3.6:35b-a3b'),
LLM_BASE_URL: z.string().min(1).default('http://127.0.0.1:11434'),
OPENAI_API_KEY: z.string().optional(),
ANTHROPIC_API_KEY: z.string().optional(),
DEEPSEEK_API_KEY: z.string().optional(),
```

```ts
// src/agent/llm/port.ts
export interface LlmGenerateInput {
  system: string
  prompt: string
  tools?: LlmTool[]
  schema?: unknown
}

export interface LlmTool {
  name: string
  description: string
  inputSchema: unknown
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export interface LlmGenerateResult {
  text: string
  output: unknown
}

export interface Llm {
  readonly provider: string
  readonly model: string
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>
}
```

El `schema` y `tools` se tipan con zod en el llamador; el puerto los acepta como `unknown` para no acoplar el dominio a la versión del SDK. El adaptador del registry hace el cast en la frontera, que es el único lugar permitido junto con Baileys.

- [ ] **Step 4: Commit**

```bash
bun test tests/config.test.ts
git add package.json bun.lock src/config src/agent/llm/port.ts tests/config.test.ts .env.example
git commit -m "feat: configuración de proveedores LLM y puerto Llm"
```

---

### Task 2: Preferencias

**Files:**
- Modify: `src/store/schema.ts`
- Create: `src/store/repositories/preferences.ts`
- Create: `src/agent/preferences.ts`
- Test: `tests/store/preferences.test.ts`, `tests/agent/preferences.test.ts`

**Interfaces:**
- Consumes: `TIMEZONE` del config como default
- Produces:
  - `ResolvedPreferences { language, length, format, tone, timezone, focus, ignoreKinds, alias }`
  - `DEFAULT_PREFERENCES`
  - `resolvePreferences(global, chat): ResolvedPreferences`
  - `getResolvedPreferences(db, conversationId | null): Promise<ResolvedPreferences>`
  - `findConversationIdByAlias(db, provider, alias): Promise<string | null>`
  - `upsertGlobalPreferences`, `upsertChatPreferences`

Defaults:

```ts
export const DEFAULT_PREFERENCES = {
  language: 'es',
  length: 'medium',
  format: 'bullets',
  tone: 'neutral',
  timezone: 'America/Argentina/Buenos_Aires',
  focus: null,
  ignoreKinds: [] as string[],
  alias: null,
} as const
```

`preferences` es tabla de una sola fila, mismo truco que `capture_policy`: `id` integer PK default 1 + check `id = 1`.

`chat_preferences.alias` tiene `uniqueIndex` por `provider` + `alias` (donde alias no es null). Un alias no puede apuntar a dos conversaciones.

- [ ] **Step 1: Tests de cascada, sin base**

```ts
test('el chat pisa lo global, lo global pisa el default', () => {
  const resolved = resolvePreferences(
    { language: 'en', length: null, format: null, tone: null, timezone: null },
    { language: null, length: 'short', format: null, tone: null, timezone: null, focus: 'plazos', ignoreKinds: ['sticker'], alias: 'la facu' },
  )
  expect(resolved.language).toBe('en')
  expect(resolved.length).toBe('short')
  expect(resolved.format).toBe('bullets')
  expect(resolved.focus).toBe('plazos')
  expect(resolved.alias).toBe('la facu')
})
```

- [ ] **Step 2: Tests de repositorio**

- Sin filas, `getResolvedPreferences` devuelve `DEFAULT_PREFERENCES` con timezone del default.
- Global `language=en` + chat `length=short` resuelve ambos.
- `findConversationIdByAlias` es case-insensitive: `La Facu` encuentra `la facu`.
- Cambiar `preferences.timezone` y verificar que el valor nuevo se lee. La invalidación del caché de chunks va en la Task 6.

- [ ] **Step 3: Tablas**

```ts
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
    /** Si está, el intérprete resuelve este nombre sin llamar al modelo. */
    alias: text('alias'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_preferences_conversation_id_idx').on(t.conversationId),
    uniqueIndex('chat_preferences_alias_idx').on(t.alias),
  ],
)
```

El unique de `alias` en Postgres trata dos nulls como distintos, así que varias filas sin alias conviven. Un alias repetido choca. La búsqueda case-insensitive se hace en SQL con `lower(alias) = lower($alias)`, no con el unique (el unique queda case-sensitive; documentarlo). Si el usuario pide alias case-insensitive únicos, eso es un índice `uniqueIndex` sobre `sql`lower(${t.alias})`` — preferir eso desde el vamos.

- [ ] **Step 4: Migrar, tests, commit**

```bash
bun run db:generate && bun run db:migrate
bun test tests/agent/preferences.test.ts tests/store/preferences.test.ts
git add src/store src/agent/preferences.ts tests drizzle
git commit -m "feat: preferencias globales, por chat y alias"
```

---

### Task 3: FakeLlm y registry

**Files:**
- Create: `src/agent/llm/fake.ts`
- Create: `src/agent/llm/registry.ts`
- Test: `tests/agent/llm-registry.test.ts`, `tests/agent/fake-llm.test.ts`

**Interfaces:**
- Consumes: `Llm`, `Config`
- Produces: `createLlm(config): Llm`, `FakeLlm`

El `FakeLlm` encola respuestas (`enqueue({ text, output, toolsToCall })`). Si le piden `generate` y no hay respuesta, tira. Los tests del intérprete y del resumidor no tocan la red.

El registry:

```ts
export function createLlm(config: Config): Llm {
  switch (config.LLM_PROVIDER) {
    case 'ollama': return createOllamaLlm(config)
    case 'openai': return createOpenAiLlm(config)
    case 'anthropic': return createAnthropicLlm(config)
    case 'deepseek': return createDeepSeekLlm(config)
  }
}
```

Cada adaptador llama `generateText` del SDK con el modelo correspondiente. Anthropic agrega el `cacheControl` en el mensaje de system. Ollama pasa `providerOptions.ollama.num_ctx` si el paquete lo documenta; si no, no inventar el campo.

Test del registry: no llama al modelo. Solo verifica que `createLlm` con `LLM_PROVIDER=openai` y sin key **no** tira al construir (la key se usa al generar). Y que un provider desconocido no compila — eso ya lo tapa zod.

Un test de `FakeLlm`: encolar una respuesta, `generate`, recibirla, el segundo `generate` tira.

- [ ] **Steps:** test → fail → implement → pass → commit `feat: registry de LLM y FakeLlm para tests`

---

### Task 4: Resolución de conversación

**Files:**
- Modify: `src/store/repositories/conversations.ts`
- Create: `src/agent/resolve-conversation.ts`
- Test: `tests/agent/resolve-conversation.test.ts`

**Interfaces:**
- Consumes: alias, `conversations.name`, `lastMessageAt`, `countMessagesInConversation`
- Produces:
  - `searchConversationsByName(db, provider, query): Promise<ConversationHit[]>`
  - `resolveConversation(db, provider, spokenName): Promise<ResolveResult>`
  - `ResolveResult = { kind: 'resolved', conversationId: string } | { kind: 'ambiguous', candidates: ConversationHit[] } | { kind: 'none' }`

`ConversationHit { id, name, lastMessageAt, messageCount }`

Algoritmo, en este orden:

1. Alias exacto case-insensitive → `resolved`.
2. `searchConversationsByName`: `ILIKE '%' || query || '%'` sobre `name`, provider igual, orden `lastMessageAt desc`, límite 5.
3. Cero hits → `none`.
4. Un hit → `resolved`.
5. Varios hits → `ambiguous`.

No hay fuzzy extra (trigram, levenshtein). ILIKE + alias cubren el diseño. Si duele, se abre otra tarea.

Tests con Postgres: sembrar tres conversaciones (`Grupo Facu`, `Facu fútbol`, `Trabajo`), alias `la facu` → Facu; query `facu` → ambiguous; query `trabajo` → resolved; query `zzz` → none.

- [ ] **Steps:** test → fail → implement → pass → commit `feat: resuelve conversaciones por alias y por nombre`

---

### Task 5: Intérprete

**Files:**
- Create: `src/agent/interpret.ts`
- Test: `tests/agent/interpret.test.ts`

**Interfaces:**
- Consumes: `Llm`, `resolveConversation`, `ResolvedPreferences.timezone`, `pending_clarifications`
- Produces:
  - `SummaryRequest { conversationId, from, to, focus: string | null }`
  - `InterpretResult = { kind: 'request', request: SummaryRequest } | { kind: 'ask', question: string } | { kind: 'help' }`
  - `interpret(input): Promise<InterpretResult>`

El modelo no elige fechas a ojo: el intérprete le da `now` y `timezone`, y le pide un objeto:

```ts
const InterpretSchema = z.object({
  intent: z.enum(['summarize', 'help', 'unknown']),
  conversationQuery: z.string().nullable(),
  range: z.enum(['today', 'yesterday', 'this_week', 'last_n_days', 'iso']).nullable(),
  lastNDays: z.number().int().positive().nullable(),
  isoFrom: z.string().nullable(),
  isoTo: z.string().nullable(),
  focus: z.string().nullable(),
})
```

`rangeToInterval(range, now, timezone)` es una función pura, testeada sin LLM:

- `today` / `yesterday` / `this_week` (lunes 00:00 al instante actual) usan la TZ.
- `last_n_days` con `n=7` son las últimas 168 horas desde `now`, no “esta semana”.
- `iso` parsea `isoFrom`/`isoTo` en esa TZ.

Tests puros de `rangeToInterval` con `now = 2026-08-30T18:00:00-03:00` y `America/Argentina/Buenos_Aires`.

Tests del intérprete con `FakeLlm`:

1. output `summarize` + `conversationQuery='la facu'` + alias sembrado → `request` con ese `conversationId`.
2. output `summarize` + query ambigua → `ask` que lista candidatas, y `saveClarification`.
3. siguiente mensaje, con aclaración activa, elige la candidata 1 (el FakeLlm devuelve `conversationQuery` más preciso, o el texto es `1`) → `request` y `clearClarification`.
4. aclaración vencida → se ignora, se interpreta de cero.
5. output `help` → `{ kind: 'help' }`.
6. `resolveConversation` = `none` → `ask`, no un request vacío.
7. `FakeLlm.generate` tira → `interpret` propaga; el loop (Task 8) lo convierte en mensaje de error. El intérprete no traga el error.

Tools: una sola, `searchConversations`, que llama `searchConversationsByName`. `stopWhen` con el helper real del SDK, 4 pasos (tools + output). Si el FakeLlm no implementa tools, el test 1 no las necesita: el output ya trae `conversationQuery`.

- [ ] **Steps:** test → fail → implement → pass → commit `feat: interpreta pedidos de resumen en lenguaje natural`

---

### Task 6: Buckets, transcripción y caché de parciales

**Files:**
- Create: `src/agent/buckets.ts`
- Create: `src/agent/transcript.ts`
- Modify: `src/store/schema.ts` (`chunk_summaries`)
- Create: `src/store/repositories/chunks.ts`
- Test: `tests/agent/buckets.test.ts`, `tests/agent/transcript.test.ts`, `tests/store/chunks.test.ts`

**Interfaces:**
- Consumes: mensajes de un rango, preferencias
- Produces:
  - `DayBucket { day: string /* YYYY-MM-DD en TZ */, from: Date, to: Date }`
  - `splitIntoDayBuckets(from, to, timezone): DayBucket[]`
  - `renderTranscript(messages, attachments, budgetChars): string`
  - `findValidChunk(db, key): Promise<string | null>`
  - `upsertChunk(db, key, text, messageCount, lastMessageAt)`
  - `invalidateChunksForTimezoneChange(db): Promise<void>`

`chunk_summaries` unique sobre `(conversationId, day, model, promptVersion)`. Columnas de invalidación: `messageCount`, `lastMessageAt`, `model`, `promptVersion`.

`findValidChunk` recuenta mensajes del bucket (`sent_at >= from AND sent_at < to`) y compara count + max(sent_at). Si no matchea, `null`.

`renderTranscript`:

```
[2026-08-30 09:01] Ana: vamos el jueves
[2026-08-30 09:02] Ana: [nota de voz, 45s]
[2026-08-30 09:03] Juan: [imagen]
```

Si el texto supera `budgetChars` (default 12_000), se recortan mensajes del medio y se inserta `… (N mensajes omitidos) …`. Nunca se parte un mensaje a la mitad. Tests con presupuesto chico.

`splitIntoDayBuckets` con un rango que cruza medianoche en `America/Argentina/Buenos_Aires` produce dos buckets. Un rango en UTC que es el mismo día en Buenos Aires produce uno. Este test es el que justifica no usar UTC.

Cuando `upsertGlobalPreferences` cambia `timezone`, llama `invalidateChunksForTimezoneChange`: `DELETE FROM chunk_summaries`. Documentarlo en el JSDoc del repo.

- [ ] **Steps:** tests → fail → schema + generate + implement → pass → commit `feat: buckets diarios, transcripción y caché de parciales`

---

### Task 7: Resumidor jerárquico

**Files:**
- Create: `src/agent/summarize/prompt.ts`
- Create: `src/agent/summarize/index.ts`
- Test: `tests/agent/summarize.test.ts`

**Interfaces:**
- Consumes: `Llm`, chunks, transcript, preferencias
- Produces: `summarize(input: { db, llm, request, preferences }): Promise<string>`

Algoritmo:

1. `splitIntoDayBuckets(request.from, request.to, preferences.timezone)`
2. Para cada bucket: `findValidChunk`; si hay, usarlo; si no, cargar mensajes, `renderTranscript`, `llm.generate` con el prompt de parcial, `upsertChunk`.
3. Si hay un solo parcial, devolverlo (igual se le aplica el prompt de combinación si el usuario pidió un formato distinto — no: un solo día se devuelve tal cual para no gastar una llamada).
4. Si hay varios, `llm.generate` con el prompt de combinación y la lista de parciales.
5. El system prompt incluye idioma, longitud, formato, tono y foco.

Prompts en `prompt.ts`, no inline. `SUMMARY_PROMPT_VERSION = 1`.

Tests con `FakeLlm` y Postgres:

1. Dos días, FakeLlm devuelve `parcial-A` y `parcial-B` y después `combo`. Resultado `combo`. Tres llamadas.
2. Mismo request de nuevo: una sola llamada (la de combo) si los parciales siguen válidos — o cero si cacheamos también el combo. **No cachear el combo.** Solo los días. El segundo request hace 1 llamada (combo) y 0 de parciales. Verificar `fake.calls` filtrado por system.
3. Llega un mensaje nuevo al día 2: el parcial 2 se regenera, el 1 no. `fake.calls` = 2 (parcial-2 + combo).
4. `FakeLlm` tira en un parcial: ese día se reemplaza por `[no se pudo resumir el 2026-08-29]` y el combo sigue. Un resumen parcial sirve más que ninguno.
5. Conversación sin mensajes en el rango: texto fijo `No hay mensajes en ese período.`, cero llamadas al LLM.

- [ ] **Steps:** test → fail → implement → pass → commit `feat: resumen jerárquico con caché por día`

---

### Task 8: Reemplazar el stub en el loop

**Files:**
- Modify: `src/control/loop.ts`
- Delete: `src/control/stub.ts`, `tests/control/stub.test.ts`
- Modify: `tests/control/loop.test.ts`, `tests/e2e/control.test.ts`
- Create: `tests/e2e/summary.test.ts`

**Interfaces:**
- Consumes: `interpret`, `summarize`, `createControlLoop`
- Produces: el bot resume de verdad

El loop queda:

```
classify → interpret →
  help → encolar texto de ayuda
  ask → saveClarification + encolar la pregunta (con BOT_PREFIX)
  request → summarize → encolar el resumen (con BOT_PREFIX)
```

Si `interpret` o `summarize` tiran: encolar `✦ No pude completar el pedido: <describirError>` y log.error. Nunca silencio.

El e2e `tests/e2e/control.test.ts` que esperaba el texto del stub se actualiza: `ayuda` ahora viene del intérprete (`kind: 'help'`). El FakeLlm se inyecta en el loop.

Nuevo e2e `tests/e2e/summary.test.ts`, los flujos del diseño que este plan cierra:

1. Pedido de resumen → respuesta en control con el texto del FakeLlm.
2. Pedido ambiguo → pregunta de vuelta → segundo mensaje resuelve y resume.
3. Segundo pedido solapado → el FakeLlm no vuelve a generar los parciales cacheados.

`createControlLoop` suma `llm: Llm` y usa `db` para interpret/summarize.

- [ ] **Step 1:** actualizar tests del stub/loop para que fallen
- [ ] **Step 2:** borrar stub, cablear
- [ ] **Step 3:** e2e + `bun test` + `typecheck`
- [ ] **Step 4:** commit `feat: el grupo de control pide y recibe resúmenes`

---

### Task 9: Cablear el LLM real y el README

**Files:**
- Modify: `src/index.ts` — `createLlm(config)` en vez de FakeLlm
- Modify: `README.md`, `.env.example`

Documentar `LLM_PROVIDER`, `LLM_MODEL`, que Ollama tiene que estar arriba, y que los resúmenes salen del grupo de control. Quitar “todavía no sé resumir”.

Un test de arquitectura nuevo:

```ts
test('src/capture no importa ai', ...)
```

Mismo truco que baileys.

- [ ] **Steps:** test de arquitectura → cablear index → README → `bun test && bun run typecheck` → commit `feat: resúmenes con Ollama por defecto y providers cloud listos`

## Verificación final

- [ ] `bun test` y `typecheck` verdes
- [ ] capture no importa `ai`
- [ ] Un segundo pedido reutiliza parciales (test 2 de la Task 7)
- [ ] Alias resuelve sin LLM (test de la Task 4)
- [ ] Ambigüedad pregunta, no elige
- [ ] Error de LLM se anuncia en control

## Fuera de este plan

Transcribir audios, describir imágenes, embeddings, HNSW, búsqueda por tema, persistir binarios de `raw`, barrer adjuntos `failed`. El `focus` del request se inyecta al prompt; no filtra mensajes por similitud todavía.
