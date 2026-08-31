# bot-whatsapp

Bot que resume conversaciones de WhatsApp a pedido. Se vincula a tu cuenta como dispositivo
enlazado, guarda los mensajes en Postgres y responde resúmenes en un grupo de control.

Estado: la captura, el bucle de control, los resúmenes, el enriquecimiento perezoso de
media y la búsqueda semántica están escritos y cubiertos por tests, pero **todavía nadie
vinculó un teléfono**. Lo que sí está comprobado corriendo: la suite completa, el
arranque contra Postgres (incluido el LLM real con Ollama), el QR apareciendo en la
terminal y el Ctrl-C durante esa espera. Lo que falta comprobar empieza justo después de
escanear ese QR: que los mensajes reales lleguen a la base, que los adjuntos reales bajen y
que el bot responda de verdad en el grupo de control.

## Requisitos

- [Bun](https://bun.com) 1.4 o mayor
- Docker, para el Postgres con pgvector
- [Ollama](https://ollama.com) en marcha (por defecto; ver `LLM_PROVIDER`)

## Puesta en marcha

```bash
bun install
cp .env.example .env
bun run db:up
bun run db:migrate
```

El `db:up` levanta Postgres 18 con la extensión `vector` en el puerto **5433**, para no
pisar una instalación local en el 5432. La primera vez también crea la base de tests.

Con el proveedor por defecto (`ollama`), Ollama tiene que estar arriba y los modelos de
`LLM_MODEL` y `EMBEDDING_MODEL` descargados (`ollama pull …`) antes de pedir un resumen
(sobre todo si el pedido tiene foco temático).

Para conseguir el identificador del grupo de control:

```bash
bun run src/index.ts list-conversations
```

La primera vez aparece un QR en la terminal. Escanealo desde WhatsApp, en Ajustes →
Dispositivos vinculados. Después se listan **los grupos en los que participás**, uno por
línea, con su identificador y su nombre: copiá el del grupo de control a
`CONTROL_CONVERSATION_ID` en `.env`. Los chats uno a uno no aparecen, y para el grupo de
control eso alcanza.

La sesión queda guardada en `WHATSAPP_AUTH_DIR`, así que el QR solo se pide una vez. Si
cerrás el dispositivo vinculado desde el teléfono, hay que borrar ese directorio y volver a
vincular.

Para capturar mensajes y responder en el grupo de control (si `CONTROL_CONVERSATION_ID`
está definido):

```bash
bun start
```

Sin `CONTROL_CONVERSATION_ID` el bot solo captura: no encola ni responde nada. Con el
identificador configurado, los mensajes del grupo de control pasan por el bucle de control.
Ahí pedís resúmenes (y `help`); podés pedir un resumen *sobre un tema* y el bot embeddea
solo el rango pedido y filtra por similitud. Las respuestas del bot llevan el prefijo
`BOT_PREFIX` (`✦ `): lo que ya empieza con ese prefijo se ignora, para no reaccionar a los
propios mensajes.

Las imágenes del rango se describen al resumir (visión multimodal vía el mismo
`LLM_MODEL` / Ollama). **La transcripción de audio no está disponible con este provider**
(ai-sdk-ollama acepta imágenes en `generateText`; no hay API de audio ni Whisper).

## Comandos

| Comando | Qué hace |
|---|---|
| `bun start` | Captura mensajes y, si `CONTROL_CONVERSATION_ID` está definido, responde en el grupo de control |
| `bun run src/index.ts list-conversations` | Lista los grupos en los que participás, con su identificador |
| `bun run dev` | Igual que `start`, recargando al editar |
| `bun test` | Corre la suite (necesita Postgres arriba) |
| `bun run typecheck` | Verifica tipos sin emitir |
| `bun run db:up` / `db:down` | Levanta o baja Postgres |
| `bun run db:generate` | Genera una migración a partir del esquema |
| `bun run db:migrate` | Aplica las migraciones pendientes |

## Configuración

Todo se configura por entorno y se valida con zod al arrancar: si falta algo o está mal, el
proceso falla con el detalle en lugar de arrancar a medias. Ver `.env.example` para la lista
completa.

Lo que más se toca:

- `PROVIDER`: `whatsapp` o `fake`. El falso sirve para probar sin teléfono.
- `CONTROL_CONVERSATION_ID`: el grupo donde el bot escucha y responde. Sin valor, no hay
  respuesta. Los pedidos de resumen salen de ese grupo.
- `LLM_PROVIDER`: `ollama` (default), `openai`, `anthropic` o `deepseek`.
- `LLM_MODEL`: modelo a usar (default `qwen3.6:35b-a3b` con Ollama).
- `LLM_BASE_URL`: base de Ollama u otro endpoint compatible (default
  `http://127.0.0.1:11434`).
- `EMBEDDING_MODEL`: modelo de embeddings (default `embeddinggemma:300m`, 768 dims).
  Solo Ollama y OpenAI; Anthropic/DeepSeek no exponen embeddings en este adapter.
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`: solo si usás ese provider.
- `CAPTURE_BUFFER_MAX`: cuántos mensajes retener en memoria si Postgres no responde.
- `SHUTDOWN_TIMEOUT_MS`: tope duro (ms) de toda la secuencia de apagado. Por defecto
  `15000`.

El prefijo de las respuestas del bot es la constante `BOT_PREFIX` (`✦ `) en el código, no
una variable de entorno.

### Política de captura

Por defecto se captura todo. Para acotarlo hay tres modos —`all`, `whitelist` y `blacklist`—
más una lista de excepciones por conversación. En `all` las excepciones se ignoran; en
`whitelist` son las únicas conversaciones que se capturan; en `blacklist`, las únicas que no.

**Esto no se configura por entorno.** No existe un `CAPTURE_MODE`: la política vive en la
base, el código solo la lee y ninguna migración siembra la fila, así que hoy el único modo de
cambiarla es escribir SQL a mano. Sin fila, el modo efectivo es `all`. Y se lee una sola vez,
al arrancar: después de tocarla hay que reiniciar el proceso.

Para abrir una consola contra la base:

```bash
docker compose exec postgres psql -U bot -d botwhatsapp
```

Fijar el modo. `capture_policy` es una tabla de una sola fila, con `id` forzado a 1 por un
check, así que el mismo enunciado sirve para crearla la primera vez y para cambiarla después:

```sql
INSERT INTO capture_policy (id, mode) VALUES (1, 'whitelist')
  ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now();
```

Agregar una conversación a las excepciones. El identificador es el JID que devuelve
`list-conversations`, y el proveedor importa porque las reglas se filtran por él:

```sql
INSERT INTO capture_rules (provider, conversation_external_id)
VALUES ('whatsapp', '120363000000000000@g.us')
  ON CONFLICT (provider, conversation_external_id) DO NOTHING;
```

Sacarla:

```sql
DELETE FROM capture_rules
 WHERE provider = 'whatsapp' AND conversation_external_id = '120363000000000000@g.us';
```

Ver qué va a leer el bot en el próximo arranque:

```sql
SELECT mode FROM capture_policy;
SELECT provider, conversation_external_id FROM capture_rules ORDER BY 1, 2;
```

El arranque lo confirma en el log: `política de captura cargada {"modo":"whitelist","reglas":2}`.

## Cómo está organizado

```
src/
  config/      Lectura y validación del entorno
  domain/      Tipos y puertos, sin dependencias de infraestructura
  providers/   Adaptadores de mensajería: whatsapp (Baileys), fake
  store/       Esquema Drizzle, migraciones y repositorios
  capture/     Política de captura, buffer, pipeline de ingesta, descarga de adjuntos
  control/     Bucle de control, clasificación y guarda
  outbox/      Despacho de respuestas al canal
  agent/       Interpretación, resúmenes y adaptadores LLM
  cli.ts       Parseo del subcomando
  logger.ts    Logger de consola con filtrado por nivel
  shutdown.ts  Apagado ordenado
  index.ts     Punto de entrada
```

La regla que sostiene el diseño: **nada en `capture/`, `store/` o `domain/` importa
`baileys`**, y **`capture/` tampoco importa `ai`**. Los mensajes de WhatsApp se traducen a
tipos neutros en `providers/whatsapp/normalize.ts`, y todo lo de aguas abajo trabaja con esos
tipos. El SDK de AI vive en el agente. Por eso agregar Telegram o Slack más adelante es
escribir un adaptador, no tocar la captura. `tests/arquitectura.test.ts` verifica ambas
reglas en cada corrida, porque un import de más pasa el typecheck sin que nadie se entere.

Cuatro comportamientos que no se ven en la estructura y conviene saber:

**Si Postgres se cae, los mensajes no se pierden.** Van a un buffer acotado en memoria que se
reintenta cada 30 segundos y al apagar. Si el buffer se llena, descarta los más viejos y lo
dice. El apagado corta primero la entrada y recién después vacía, para que el mensaje que
estaba llegando cuando entró la señal alcance ese último intento. Si igual queda algo sin
persistir, el proceso lo informa y sale con código distinto de cero.

**Los adjuntos se descargan una sola vez, y un fallo no se reintenta solo.** Los bytes van a
`MEDIA_DIR/<conversación>/<adjunto>`, y qué falta bajar lo decide la base y no el mensaje: se
descarga lo que no esté en `ok` y lleve menos de tres intentos, así que una reentrega del
history sync no vuelve a bajar lo que ya está. El costado incómodo es el mismo mecanismo: **el
único disparador de un reintento es que WhatsApp reentregue el mensaje**. Si no vuelve, el
adjunto queda en `failed` con el motivo en `download_error` y no lo mira nadie. No hay tarea de
fondo que barra los fallidos, y la columna `raw` no sirve para rescatarlos: los binarios de
Baileys no sobreviven al viaje por jsonb.

**No todo lo que llega es una conversación.** Los estados (`status@broadcast`) y las listas de
difusión entran por el mismo evento que los mensajes, y la normalización los descarta: el
primero acumularía las historias de todos los contactos en un único chat falso, y el segundo
no tiene interlocutor ni diálogo que resumir. Lo que le llega a cada destinatario de una
difusión sí se captura, por su chat.

**Si la sesión se cierra desde el teléfono, el proceso se apaga.** El adaptador lo avisa por
un canal de fallo terminal; el bot vacía el buffer, cierra todo y sale con 1, en vez de quedar
en pie sin capturar nada. Una caída de conexión común, en cambio, reconecta con backoff.

## Qué falta

Además de la prueba de vinculación con un teléfono, en este orden:

1. ~~Cola de salida y bucle de control~~ — hecho
2. ~~[Resúmenes](docs/superpowers/plans/2026-08-30-resumenes.md)~~ — hecho
3. ~~[Media y búsqueda semántica](docs/superpowers/plans/2026-08-30-media-y-busqueda.md)~~ — hecho

## Diseño

El documento de diseño está en `docs/superpowers/specs/`, y los planes de implementación
—con el razonamiento detrás de cada decisión, incluidos los errores encontrados en revisión—
en `docs/superpowers/plans/`.
