# Media y búsqueda semántica — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Los resúmenes incluyen transcripciones de audio y descripciones de imagen, cacheadas. Un pedido “sobre X” embeddea solo el rango pedido y filtra por similitud. Los adjuntos fallidos se pueden reintentar cuando se los necesita, y `raw` deja de ser un callejón sin salida.

**Architecture:** Sigue sin haber workers. Al resumir (o al buscar por tema) se mira el rango, se enriquecen los adjuntos de ese rango que no tengan derivación, se embeddean los mensajes de ese rango que no tengan vector, y se cachea todo. El índice HNSW se crea ahora, cuando por fin hay queries. La transcripción y la descripción pasan por el puerto `Llm` / un puerto `MediaModel` chico, testeable con falsos.

**Tech Stack:** El mismo del plan de resúmenes, más `embedMany` del AI SDK y `cosineDistance` de Drizzle. Modelo de embeddings: `embeddinggemma:300m`, 768 dimensiones (ya fijadas en `messages.embedding`).

## Global Constraints

- Las Global Constraints de los dos planes anteriores siguen vigentes.
- Embeddings perezosos: nunca un scan de toda la tabla. Siempre `conversation_id` + rango de `sent_at`.
- Derivaciones perezosas: solo adjuntos del rango pedido. Caché por `(attachmentId, model, kind)`.
- Concurrencia: como máximo 2 descargas/enriquecimientos y 1 lote de embeddings a la vez. Sin eso Ollama se ahoga.
- Dimensión 768. Si `embedMany` devuelve otra, se tira y no se escribe.
- `capture/` sigue sin importar `ai`.
- Verificar APIs del AI SDK en `node_modules/ai/docs/` (el plan de resúmenes ya lo instaló).
- Decisiones que este plan **tiene** que tomar, las dejó abiertas la fundación:
  1. Binarios en `raw`: se persisten en base64.
  2. Adjuntos `failed`: se reintentan al enriquecer, si `download_attempts < 3` y hay bytes o un `raw` recuperable.

## Mapa de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `src/store/schema.ts` | `attachment_derivations`; índice HNSW; `messages.raw` documenta base64 |
| `src/store/repositories/derivations.ts` | Caché de transcripciones/descripciones |
| `src/store/repositories/embeddings.ts` | Escribir vectores y buscar por similitud |
| `src/store/raw.ts` | Codificar/decodificar binarios de `raw` |
| `src/agent/media/port.ts` | Puerto `MediaModel` |
| `src/agent/media/fake.ts` | Falso para tests |
| `src/agent/media/enrich.ts` | Enriquece un rango, con caché |
| `src/agent/embed.ts` | Embeddea lo que falta de un rango |
| `src/agent/search.ts` | Query semántica acotada |
| `src/agent/transcript.ts` | Usa derivaciones si existen |
| `src/agent/interpret.ts` | El `focus` dispara búsqueda |
| `src/capture/ingest.ts` | Codifica `raw` al persistir |
| `src/providers/whatsapp/normalize.ts` | Deja los binarios como `Uint8Array`; no los toca |
| `drizzle/00xx_hnsw.sql` | Índice HNSW |

---

### Task 1: Codificar binarios de `raw`

**Files:**
- Create: `src/store/raw.ts`
- Modify: `src/capture/ingest.ts` (pasa `raw` por el encoder antes de `insertMessage`)
- Modify: `src/store/schema.ts` (JSDoc de `raw`)
- Test: `tests/store/raw.test.ts`, extender `tests/capture/ingest.test.ts`

**Interfaces:**
- Consumes: `unknown`
- Produces:
  - `encodeRaw(raw: unknown): unknown` — clona y convierte `Uint8Array` / `ArrayBuffer` / `Buffer` en `{ $bin: 'b64', data: string }`
  - `decodeRaw(raw: unknown): unknown` — inverso, para el adaptador de WhatsApp al reintentar

Esta es la decisión que el diseño dejó abierta. Se toma acá: **sí, base64**. El costo es espacio. El beneficio es poder armar de nuevo lo que `downloadMediaMessage` necesita sin esperar a que WhatsApp reentregue.

- [ ] **Step 1: Tests puros**

```ts
test('encodeRaw marca los bytes y decodeRaw los restaura', () => {
  const raw = { mediaKey: new Uint8Array([1, 2, 3]), caption: 'hola' }
  const encoded = encodeRaw(raw)
  expect(encoded).toEqual({
    mediaKey: { $bin: 'b64', data: Buffer.from([1, 2, 3]).toString('base64') },
    caption: 'hola',
  })
  const decoded = decodeRaw(encoded)
  expect(decoded).toEqual({ mediaKey: new Uint8Array([1, 2, 3]), caption: 'hola' })
})

test('encodeRaw no muta el original', () => {
  const raw = { mediaKey: new Uint8Array([9]) }
  encodeRaw(raw)
  expect(raw.mediaKey).toBeInstanceOf(Uint8Array)
})

test('decodeRaw deja intacto lo que no lleva $bin', () => {
  expect(decodeRaw({ a: 1 })).toEqual({ a: 1 })
})
```

Recorrer objetos y arrays. No intentar “arreglar” JSON ya persistido sin marca: el histórico sigue sin ser reintentable, y no hay migración de datos. Solo lo nuevo.

- [ ] **Step 2: Test de ingesta**

Inyectar un mensaje cuyo `raw` tiene `Uint8Array`. Leer `messages.raw` de la base y comprobar la marca `$bin`. Hoy el test de ingest guarda `{ fake: true }`; agregar uno nuevo, no romper el viejo.

- [ ] **Step 3: Implementar y cablear**

`insertMessage` no encodea: no es su trabajo. `persist` en `ingest.ts` llama `encodeRaw(message.raw)` antes de insertar. El adaptador de WhatsApp, cuando reintente una descarga, llama `decodeRaw` sobre la fila.

Actualizar el JSDoc de `messages.raw`: ya no dice que no sirve para reintentar. Dice que los binarios van como `{ $bin: 'b64', data }` y que `decodeRaw` los restaura.

- [ ] **Step 4: Commit** `fix: persiste los binarios de raw en base64 para poder reintentar`

---

### Task 2: Derivaciones y enriquecimiento

**Files:**
- Modify: `src/store/schema.ts`
- Create: `src/store/repositories/derivations.ts`
- Create: `src/agent/media/port.ts`
- Create: `src/agent/media/fake.ts`
- Create: `src/agent/media/enrich.ts`
- Test: `tests/store/derivations.test.ts`, `tests/agent/enrich.test.ts`

**Interfaces:**
- Consumes: adjuntos del rango, `MediaModel`, `decodeRaw`, `provider.downloadAttachment`
- Produces:
  - `MediaModel { transcribe(path, mime): Promise<string>; describe(path, mime): Promise<string>; readonly model: string }`
  - `enrichRange(db, provider, media, conversationId, from, to): Promise<void>`
  - `getDerivation(db, attachmentId, kind, model): Promise<string | null>`

`attachment_derivations`:

```ts
export const attachmentDerivations = pgTable(
  'attachment_derivations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    /** `transcript` para audio; `description` para imagen. */
    kind: text('kind').$type<'transcript' | 'description'>().notNull(),
    model: text('model').notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('attachment_derivations_unique_idx').on(t.attachmentId, t.kind, t.model)],
)
```

`enrichRange`:

1. Selecciona adjuntos de mensajes en el rango cuyo `kind` sea `audio` o `image`.
2. Si ya hay derivación para `(id, kind, model)`, skip.
3. Si `downloadStatus !== 'ok'` y `downloadAttempts < 3`: reintentar descarga. Si `raw` tiene `$bin`, el adaptador de WhatsApp tiene que aceptar un mensaje reconstruido con `decodeRaw`. Si no puede, se deja el marcador.
4. Si sigue sin bytes, no se llama al modelo: no hay derivación, el transcript seguirá mostrando `[nota de voz, 45s]`.
5. Si hay bytes: `transcribe` o `describe`, `upsert` de la derivación.
6. Si el modelo tira: log.warn, no derivación, el resumen sigue con el marcador. Un resumen parcial sirve más que ninguno.
7. Concurrencia 2, cola interna.

`FakeMediaModel` encola respuestas por `localPath`.

Tests:

1. Audio sin derivación → una llamada a `transcribe`, fila creada.
2. Segundo `enrichRange` → cero llamadas.
3. Imagen → `describe`.
4. Video/documento/sticker → cero llamadas.
5. `transcribe` tira → cero filas, no propaga.
6. Adjunto `failed` con `attempts=1` y `raw` decodificable → el FakeProvider registra un `download`, status pasa a `ok`, después se transcribe.
7. Adjunto `failed` con `attempts=3` → no descarga, no transcribe.

El FakeProvider de hoy no reconstruye desde `raw`. El test 6 usa `failNextDownload` primero para dejarlo `failed`, después un `enrichRange` con el provider ya sin error. No hace falta un WhatsApp real.

- [ ] **Steps:** tests → fail → generate migration → implement → pass → commit `feat: enriquecimiento perezoso de audio e imagen con caché`

---

### Task 3: Transcript con derivaciones

**Files:**
- Modify: `src/agent/transcript.ts`, `src/agent/summarize/index.ts`
- Test: extender `tests/agent/transcript.test.ts`, `tests/agent/summarize.test.ts`

**Interfaces:**
- `renderTranscript` recibe ahora las derivaciones ya cargadas: `Map<attachmentId, string>`.
- Si hay texto derivado, se rendera `[nota de voz] hola juan` / `[imagen] pizarrón con fechas`.
- Si no, el marcador de siempre.

El resumidor, antes de renderizar cada bucket, llama `enrichRange` para ese día. Así un pedido de una semana enriquece siete días, no el histórico.

Test: un mensaje con audio y derivación “nos vemos el jueves” aparece en la transcripción; sin derivación aparece `[nota de voz, 45s]`. El test de resumidor verifica que `FakeMedia.calls === 1` la primera vez y `0` la segunda.

- [ ] **Steps:** test → fail → implement → pass → commit `feat: los resúmenes usan transcripciones y descripciones cacheadas`

---

### Task 4: Embeddings perezosos e índice HNSW

**Files:**
- Modify: `src/store/schema.ts` (índice HNSW sobre `messages.embedding`)
- Create: `src/store/repositories/embeddings.ts`
- Create: `src/agent/embed.ts`
- Create: `src/agent/llm/embedder.ts` (adaptador `embedMany`)
- Create: `src/agent/llm/fake-embedder.ts`
- Test: `tests/agent/embed.test.ts`, `tests/store/embeddings.test.ts`

**Interfaces:**
- Consumes: `embedMany`, mensajes del rango sin `embeddedAt`
- Produces:
  - `Embedder { embed(texts: string[]): Promise<number[][]>; readonly model: string; readonly dimensions: 768 }`
  - `embedMissing(db, embedder, conversationId, from, to): Promise<number>` — devuelve cuántos embeddeó
  - `searchSimilar(db, conversationId, from, to, queryVector, limit): Promise<SimilarMessage[]>`

HNSW, copiado de la guía de Drizzle (Context7 `/drizzle-team/drizzle-orm-docs`):

```ts
index('messages_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
```

Sobre una columna anulable pgvector admite HNSW; las filas null no entran al índice. Generar la migración con `bun run db:generate`. No escribir el SQL a mano.

`embedMissing`:

1. Selecciona mensajes del rango con `embeddedAt IS NULL`.
2. Arma el texto: `renderTranscript` de un solo mensaje, o `text` plano si no hay adjuntos. Los mensajes sin texto ni derivación se saltean y **no** se marcan embeddeados (así un enrich posterior puede completarlos).
3. Lotes de 32. `embedder.embed`.
4. Si un vector no tiene 768 dimensiones, se tira el lote entero y no se escribe.
5. Update de `embedding` + `embeddedAt = now()`.
6. Un solo lote a la vez.

`FakeEmbedder` devuelve vectores de 768 con un patrón determinístico (hash del texto). Tests:

1. Tres mensajes sin vector → `embedMissing` = 3, `fake.calls` = 1 (un lote).
2. Segunda vez → 0, `fake.calls` = 0.
3. Un mensaje nuevo en el rango → 1.
4. Mensaje fuera del rango → 0.
5. Vector de 8 dimensiones → tira, `embeddedAt` sigue null.

`searchSimilar` usa `cosineDistance` y `1 - distance` como similarity, `gt(similarity, 0.3)`, `orderBy desc`, `limit 20`, siempre con `conversationId` + rango en el `where`. Test con tres vectores sembrados a mano (sin Ollama): el más cercano sale primero; uno de otra conversación no aparece.

- [ ] **Steps:** tests → fail → generate HNSW → implement → pass → commit `feat: embeddings perezosos por rango e índice HNSW`

---

### Task 5: Búsqueda por tema en el intérprete y el resumidor

**Files:**
- Create: `src/agent/search.ts`
- Modify: `src/agent/interpret.ts` (el `focus` no cambia de schema)
- Modify: `src/agent/summarize/index.ts`
- Test: `tests/agent/search.test.ts`, extender `tests/e2e/summary.test.ts`

**Interfaces:**
- `searchByTopic(db, embedder, conversationId, from, to, topic): Promise<Inbound-ish[]>`
  1. `embedMissing` del rango
  2. `embedder.embed([topic])` — un solo vector de query
  3. `searchSimilar`
  4. Devuelve los mensajes en orden temporal, no por score, para el transcript

El resumidor: si `request.focus` no es null, en vez de tomar todos los mensajes del bucket toma `searchByTopic` acotado a ese día. Si la búsqueda devuelve cero, el bucket se trata como vacío (no se inventa un resumen del día entero: el usuario pidió un tema).

E2e del diseño, flujo 5: “un pedido con foco embeddea solo lo que falta y reutiliza el resto”. FakeEmbedder + dos llamadas: la primera embeddea N, la segunda 0.

Flujo 6: adjuntos del rango se enriquecen una vez.

- [ ] **Steps:** tests → fail → implement → pass → commit `feat: los resúmenes con foco filtran por similitud`

---

### Task 6: Reintento de descarga desde `raw` en WhatsApp

**Files:**
- Modify: `src/providers/whatsapp/index.ts` (`downloadAttachment`)
- Modify: `src/capture/media.ts` si hace falta aceptar un `raw` decodificado
- Test: `tests/providers/whatsapp/download-raw.test.ts`

**Interfaces:**
- Si `message.raw` ya pasó por `decodeRaw` y tiene `mediaKey` como `Uint8Array`, `downloadMediaMessage` puede usarlo. El test no habla con WhatsApp: inyecta un `downloadMedia` falso en el constructor (el adaptador ya tiene `options.downloadMedia` para tests) y comprueba que se lo llama con el raw decodificado, no con el objeto jsonb.

Si después de decode el raw sigue sin servirle a Baileys, el test lo documenta y el enrich sigue con el marcador. No se finge un éxito.

Leer `src/providers/whatsapp/index.ts` `downloadAttachment` antes de tocar. No reabrir la conexión.

- [ ] **Steps:** leer código → test → implement → pass → commit `fix: reintenta descargas reconstruyendo raw en base64`

---

### Task 7: Registry de embeddings y README

**Files:**
- Modify: `src/agent/llm/registry.ts` — `createEmbedder(config)`
- Modify: `src/config/index.ts` — `EMBEDDING_MODEL` default `embeddinggemma:300m`
- Modify: `src/index.ts` — pasa embedder y media model al loop/summarize
- Modify: `README.md`, `.env.example`
- Extend: `tests/arquitectura.test.ts`

Ollama para embeddings: `ollama.embeddingModel(config.EMBEDDING_MODEL)` según docs de `ai-sdk-ollama` / `ollama-ai-provider-v2`. Verificar el export real.

Media model: para v1, transcribir y describir también van por el LLM local (audio se manda como archivo si el provider lo soporta; si Ollama no acepta audio por el AI SDK, transcribir con un comando `whisper` **no** entra en este plan). Decisión concreta:

- Si el provider de Ollama documenta input de imagen/audio en `generateText`, usarlo.
- Si no: `MediaModel` de Ollama describe imágenes (multimodal de Qwen) y para audio, si no hay API, se deja el marcador y se loguea `'transcripción de audio no disponible con este provider'`. No instalar Whisper por la puerta de atrás.

Esa verificación es el paso 1 de esta tarea, contra docs instaladas. El resultado se escribe en el README con una frase, no se deja implícito.

Extender arquitectura: `capture/` no importa `ai`.

- [ ] **Steps:** verificar docs → config → cablear → README → `bun test && typecheck` → commit `feat: búsqueda semántica y media perezosas en el proceso real`

## Verificación final

- [ ] `bun test` y `typecheck` verdes
- [ ] Segundo pedido con el mismo foco no re-embeddea (e2e flujo 5)
- [ ] Adjuntos se enriquecen una vez (e2e flujo 6)
- [ ] Un vector de dimensión distinta no se escribe
- [ ] `raw` nuevo redondo: encode → persist → decode → `Uint8Array`
- [ ] Histórico viejo sin `$bin` no se “arregla” solo
- [ ] capture no importa `ai`

## Cierra el diseño

Con este plan quedan cubiertos los siete e2e del spec (1-4 en resúmenes/control, 5-6 acá, 7 en captura). Quedan fuera de la v1, como el diseño dijo: interfaz web, resúmenes programados, memorias inferidas, reranking, multi-cuenta, y enviar a cualquier chat que no sea control.
