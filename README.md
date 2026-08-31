# bot-whatsapp

Bot que resume conversaciones de WhatsApp a pedido. Se vincula a tu cuenta como dispositivo
enlazado, guarda los mensajes en Postgres y responde resúmenes en un grupo de control.

Estado: **la captura funciona**. El bot se vincula, persiste mensajes y descarga adjuntos.
Los resúmenes y el bucle de control todavía no están; ver [Qué falta](#qué-falta).

## Requisitos

- [Bun](https://bun.com) 1.4 o mayor
- Docker, para el Postgres con pgvector
- [Ollama](https://ollama.com), para los modelos locales (todavía no se usa)

## Puesta en marcha

```bash
bun install
cp .env.example .env
bun run db:up
bun run db:migrate
```

El `db:up` levanta Postgres 18 con la extensión `vector` en el puerto **5433**, para no
pisar una instalación local en el 5432. La primera vez también crea la base de tests.

Para conseguir el identificador del grupo de control:

```bash
bun run src/index.ts list-conversations
```

La primera vez aparece un QR en la terminal. Escanealo desde WhatsApp, en Ajustes →
Dispositivos vinculados. Después se listan las conversaciones con su identificador, uno por
línea: copiá el del grupo de control a `CONTROL_CONVERSATION_ID` en `.env`.

La sesión queda guardada en `WHATSAPP_AUTH_DIR`, así que el QR solo se pide una vez.

Para capturar mensajes:

```bash
bun start
```

## Comandos

| Comando | Qué hace |
|---|---|
| `bun start` | Captura mensajes y los persiste |
| `bun run src/index.ts list-conversations` | Lista las conversaciones con su identificador |
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
- `CONTROL_CONVERSATION_ID`: el grupo donde pedir los resúmenes.
- `CAPTURE_BUFFER_MAX`: cuántos mensajes retener en memoria si Postgres no responde.

## Cómo está organizado

```
src/
  domain/      Tipos y puertos, sin dependencias de infraestructura
  providers/   Adaptadores de mensajería: whatsapp (Baileys), fake
  store/       Esquema Drizzle, migraciones y repositorios
  capture/     Política de captura, buffer, pipeline de ingesta, descarga de adjuntos
  cli.ts       Parseo del subcomando
  shutdown.ts  Apagado ordenado
  index.ts     Punto de entrada
```

La regla que sostiene el diseño: **nada en `capture/`, `store/` o `domain/` importa
`baileys`**. Los mensajes de WhatsApp se traducen a tipos neutros en
`providers/whatsapp/normalize.ts`, y todo lo de aguas abajo trabaja con esos tipos. Por eso
agregar Telegram o Slack más adelante es escribir un adaptador, no tocar la captura.

Dos comportamientos que no se ven en la estructura y conviene saber:

**Si Postgres se cae, los mensajes no se pierden.** Van a un buffer acotado en memoria que se
reintenta cada 30 segundos y al apagar. Si el buffer se llena, descarta los más viejos y lo
dice. Si al apagar queda algo sin persistir, el proceso lo informa y sale con código distinto
de cero.

**Los adjuntos se descargan una sola vez.** La base decide qué falta descargar, con tope de
intentos, así que una reentrega no vuelve a bajar lo que ya está y un fallo transitorio se
reintenta solo.

## Qué falta

En orden, cada uno con su propio plan en `docs/superpowers/plans/`:

1. **Cola de salida y bucle de control**: el despachador con reintentos y el módulo que
   distingue tus mensajes de los del bot. Deja un bot que contesta, todavía sin resumir.
2. **Resúmenes**: proveedores de LLM vía AI SDK, interpretación del pedido en lenguaje
   natural, troceado por día y resumen jerárquico con caché.
3. **Media y búsqueda semántica**: transcripción de audios, descripción de imágenes y
   embeddings con índice HNSW sobre la columna vectorial.

## Diseño

El documento de diseño está en `docs/superpowers/specs/`, y los planes de implementación
—con el razonamiento detrás de cada decisión, incluidos los errores encontrados en revisión—
en `docs/superpowers/plans/`.
