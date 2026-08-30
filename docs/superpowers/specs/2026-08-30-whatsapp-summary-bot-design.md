# Bot de resúmenes de WhatsApp — Diseño

Fecha: 2026-08-30
Estado: aprobado, pendiente de plan de implementación

## 1. Objetivo

Un bot que se conecta a WhatsApp como dispositivo vinculado, captura los mensajes
que llegan a todas las conversaciones y responde pedidos de resumen en lenguaje
natural dentro de un grupo de control dedicado.

El bot lee de todas las conversaciones y escribe en una sola. Esa asimetría es
deliberada y es también una propiedad de seguridad: no existe camino de código
que le permita enviar un mensaje a un chat que no sea el de control.

## 2. Decisiones tomadas

Cada decisión incluye el motivo, para que quien lea esto después no tenga que
reconstruirlo.

| Decisión | Elección | Motivo |
| --- | --- | --- |
| Fuente de mensajes | Base de datos propia alimentada en vivo, más lo que traiga el history sync inicial | Baileys no da acceso confiable al historial previo; el sync inicial es un extra oportunista, no un cimiento |
| Superficie de control | Un grupo de WhatsApp propio | El usuario lo prefiere sobre el chat consigo mismo |
| Interacción | Lenguaje natural interpretado por LLM con tool calling | Menor fricción que recordar sintaxis de comandos |
| Alcance de captura | Configurable: todos, lista blanca o lista negra | Flexibilidad sin obligar a decidir de antemano |
| Adjuntos | Se transcriben audios y se describen imágenes | Sin esto los resúmenes quedan incompletos en chats con mucha voz |
| Momento del procesamiento de adjuntos | Perezoso, con caché | La mayoría de los mensajes capturados nunca se resumen |
| Embeddings | Perezosos, con caché, sin worker de fondo | Coherente con lo anterior; se acota por conversación y rango antes de embeddear |
| Estrategia de resumen | Jerárquica: trozos por día, cacheados y recombinados | Escala a cualquier volumen y reutiliza trabajo previo entre pedidos |
| Despliegue | Local para desarrollar, portable a servidor 24/7 | Sin dependencias de la máquina del usuario |
| Base de datos | PostgreSQL con pgvector | Necesitamos búsqueda semántica junto a filtros relacionales |
| Capa vectorial | Drizzle con pgvector nativo, sin framework de RAG | Cada consulta combina similitud con filtros por conversación y fecha; un vector store aparte obligaría a duplicar el texto y filtrar por JSONB en lugar de índices reales |
| Preferencias | Tablas propias, determinísticas | Una preferencia escrita a propósito no debe pasar por extracción probabilística |
| Memorias inferidas | Fuera de la v1 | YAGNI; Mem0 se puede enchufar después sin tocar el resto |
| Proveedor LLM por defecto | Ollama local | Privacidad: el contenido no sale de la máquina salvo cambio explícito |
| Proveedores alternativos | OpenAI, Anthropic y DeepSeek listos | Sin lock-in, seleccionables por entorno |
| Canales de mensajería | Puerto y adaptadores, con WhatsApp como primer adaptador | Telegram, Slack y Gmail previstos como adaptadores futuros |
| Entrega de respuestas | Cola persistente con reintentos | Una respuesta no se puede perder porque el socket falló |

## 3. Stack

- Runtime y gestor de paquetes: Bun
- Lenguaje: TypeScript en modo estricto
- WhatsApp: `baileys` 7.0.0-rc14
- LLM: `ai` 7.0.85 con `ai-sdk-ollama` por defecto, más `@ai-sdk/openai`,
  `@ai-sdk/anthropic` y `@ai-sdk/deepseek`
- Base de datos: PostgreSQL con la extensión pgvector, vía Drizzle ORM
- Validación de configuración: zod
- Infraestructura local: Docker Compose para Postgres

### Modelos

El modelo de generación se define por entorno mediante `LLM_MODEL`. Para la
máquina de desarrollo (MacBook Pro M4 Pro, 48 GB de memoria unificada, 37.4 GiB
disponibles para Metal) el default es **`qwen3.6:35b-a3b`**, la variante MoE de
35B con 3B activos, elegida porque activa una fracción de los parámetros por
token y por lo tanto procesa prompts largos mucho más rápido que una densa
equivalente. El cuello de botella de esta carga es justamente procesar
transcripciones largas.

Alternativas verificadas en el registro de Ollama, documentadas por si la MoE no
rinde: `qwen3.6:27b-q4_K_M`, la densa de la misma generación, y `qwen3.8:27b`,
que es de generación posterior pero solo existe en variantes densas de 27B. La
comparación entre estas tres es una tarea de ajuste, no un bloqueante.

El modelo de embeddings es **`embeddinggemma:300m`**, con 768 dimensiones, que es
la cifra fijada en el esquema.

Ajustes de entorno de Ollama que importan para contexto largo:

- `OLLAMA_KV_CACHE_TYPE=q8_0` reduce a la mitad la memoria del KV cache
- `OLLAMA_FLASH_ATTENTION=1`
- `OLLAMA_CONTEXT_LENGTH` fijado explícitamente, porque el default es chico

Cambiar más adelante a un modelo de embeddings de otra dimensión exige migrar el
esquema y re-embeddear todo el histórico, razón por la cual la dimensión se fija
explícitamente y no se infiere.

### Caching de tokens por proveedor

Anthropic requiere marcar breakpoints explícitos con
`providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }`.
OpenAI y DeepSeek cachean automáticamente al detectar un prefijo repetido.

Advertencia registrada a propósito: en esta carga de trabajo el beneficio del
caching de proveedor es limitado, porque cada resumen envía una transcripción
distinta y el único prefijo estable es el system prompt, que probablemente no
alcance el mínimo de 1024 tokens que Anthropic exige. El ahorro real viene del
caché propio de resúmenes parciales en la base. Con Ollama por defecto no hay
facturación por token que optimizar. Se configura de todos modos, sin esperar
que sea la palanca principal.

Toda escritura de código contra el AI SDK se verifica contra los docs de la
versión instalada en `node_modules/ai/docs/`, nunca de memoria.

## 4. Arquitectura

```text
src/
  config/           Lectura y validación del entorno. Un objeto tipado.
  domain/           Tipos neutrales de canal y el puerto MessagingProvider.
                    Ninguna capa superior conoce Baileys.
  providers/
    registry.ts     Factory: identificador de proveedor -> constructor
    whatsapp/       Adaptador Baileys
    fake/           Adaptador en memoria para tests
  store/            Esquema, migraciones y repositorios
  capture/          Ingesta: política de captura y persistencia. Sin IA.
  outbox/           Cola de salida y despachador con reintentos
  control/          Escucha la conversación de control y responde
  agent/            Todo lo que toca el LLM
```

Las dependencias van en una sola dirección. `capture`, `control` y `agent`
dependen de `domain` y `store`, nunca de `providers/whatsapp`. El resultado es
que `agent` se testea entero sin WhatsApp y `capture` sin LLM.

### El puerto de mensajería

`MessagingProvider` expone lo mínimo que todo canal necesita: conectar,
desconectar, suscribirse a mensajes entrantes, enviar, descargar adjuntos y
listar conversaciones.

El puerto se diseña contra WhatsApp y Telegram, que son casi isomorfos y donde
tenemos certeza. Gmail se contempla solo en los tipos de dominio: los mensajes
llevan campos opcionales de asunto e hilo, y `connect` no asume tiempo real, de
modo que un adaptador que internamente hace polling encaja sin violar el
contrato. No se diseña hoy la abstracción completa del correo, porque inventar
una interfaz para un canal que todavía no conocemos en detalle produce
precisamente el tipo de abstracción que después estorba.

### El adaptador falso

`providers/fake` implementa el mismo puerto en memoria. Permite inyectar
mensajes entrantes y observar los salientes, lo que habilita tests end-to-end de
flujos completos sin WhatsApp real. Es el mayor beneficio práctico de haber
abstraído el canal.

## 5. Modelo de datos

Catorce tablas. Las conversaciones y los mensajes llevan columna de proveedor con
unicidad sobre la combinación de proveedor e ID externo, de modo que agregar un
canal nuevo no requiera migrar datos existentes.

| Tabla | Propósito |
| --- | --- |
| `conversations` | Chats, grupos e hilos. Único por proveedor e ID externo |
| `participants` | Remitentes, único por proveedor e ID externo |
| `messages` | Mensajes con texto, `from_self`, asunto e hilo opcionales, y columna `embedding vector(768)` anulable |
| `attachments` | Adjuntos descargados, con estado de descarga, intentos y ruta local |
| `attachment_derivations` | Caché de transcripciones y descripciones, por adjunto y modelo |
| `chunk_summaries` | Resúmenes parciales por conversación y bucket temporal |
| `preferences` | Preferencias globales |
| `chat_preferences` | Preferencias y alias por conversación |
| `capture_policy` | Modo activo: todos, lista blanca o lista negra |
| `capture_rules` | Excepciones por conversación para el modo activo |
| `bot_messages` | IDs de mensajes enviados por el bot, para no responderse a sí mismo |
| `outbound_messages` | Cola de salida con estado, intentos, próximo intento y clave de idempotencia |
| `pending_clarifications` | Pedido en espera cuando el bot preguntó de vuelta, con expiración |
| `sync_state` | Contabilidad del history sync por proveedor |

### Invalidación del caché de resúmenes

Un resumen parcial de un bucket solo es reutilizable si el conjunto de mensajes
que lo originó no cambió. Cada fila de `chunk_summaries` guarda la cantidad de
mensajes y el timestamp del último mensaje del bucket. Al buscar en el caché se
recuenta el bucket y se compara; si difiere, el resumen se regenera. Es una
consulta barata y evita servir resúmenes desactualizados cuando llegan mensajes
retrasados.

La validez también depende del modelo y del prompt que produjeron el resumen.
Cada fila guarda el identificador del modelo y una versión de prompt, y un
resumen generado con una combinación distinta a la vigente se considera
inválido. Sin esto, cambiar el prompt de resumen dejaría el caché lleno de
resultados que no son comparables entre sí.

Los buckets diarios se delimitan usando la zona horaria configurada en las
preferencias globales, no UTC. Como consecuencia, cambiar la zona horaria
invalida los buckets existentes, y ese cambio dispara una limpieza del caché de
resúmenes.

## 6. Flujos

### Ingesta (siempre activa)

Evento del proveedor, normalización al tipo de dominio, aplicación de la
política de captura, persistencia del mensaje, descarga de los bytes de los
adjuntos. Cero llamadas a un LLM en todo el camino: si el modelo local está
caído o un proveedor rechaza la petición, no se pierde ningún mensaje.

### Consulta (bajo demanda)

1. Llega un mensaje a la conversación de control
2. Se clasifica: propio y no registrado como enviado por el bot
3. El intérprete traduce el pedido a parámetros mediante tool calling
4. Si el pedido menciona un tema, se embeddean los mensajes del alcance que
   todavía no tengan vector y se acota por similitud; si no, se toma el rango
   completo
5. El rango se parte en buckets por día
6. Cada bucket consulta el caché; los faltantes se generan, enriqueciendo los
   adjuntos necesarios y cacheando sus derivaciones
7. Los parciales se combinan en la respuesta final
8. Se aplican las preferencias resueltas en cascada
9. La respuesta se encola en `outbound_messages`

No hay ningún proceso que precalcule trabajo especulativo. Todo se hace cuando
se pide y se guarda para la próxima.

### Salida

El despachador toma lo pendiente y vencido de `outbound_messages`, lo envía por
el proveedor, y ante éxito lo marca como enviado registrando además el ID
externo en `bot_messages`. Ante fallo incrementa intentos y reprograma con
backoff. Cuando la cola está vacía queda dormido.

Este despachador no contradice la decisión de no usar workers: no hace trabajo
especulativo ni toca modelos, solo entrega lo que ya existe.

El riesgo de doble envío queda resuelto: si el envío tiene éxito y el proceso
muere antes de marcarlo, el reintento podría duplicar el mensaje, pero Baileys
acepta `messageId` en las opciones de `sendMessage` para fijar el ID desde el
cliente (verificado en `MinimalRelayOptions` de la versión instalada). La clave
de idempotencia de la cola se usa como ese ID, de modo que un reintento produce
el mismo ID y WhatsApp lo descarta como duplicado en lugar de mostrarlo dos
veces.

## 7. Conversación de control

Se identifica por proveedor más identificador de conversación, tomados del
entorno. Si el identificador no está seteado, en el primer arranque el bot
lista las conversaciones disponibles con sus IDs para que el usuario copie la
que quiera.

Distinguir los pedidos del usuario de las respuestas del propio bot es un
problema real, porque en WhatsApp ambos salen de la misma cuenta y llegan
marcados como propios. La solución principal es registrar el ID de cada mensaje
enviado en `bot_messages` y descartar cualquier entrante cuyo ID ya se conozca.
Como red de seguridad, el bot además prefija sus respuestas con un marcador y
descarta los mensajes que lo llevan, de modo que una escritura perdida no
provoque un loop.

Cuando un pedido queda genuinamente ambiguo, el bot pregunta de vuelta en lugar
de elegir por su cuenta. El pedido en espera se guarda en
`pending_clarifications` con expiración.

## 8. Preferencias

Se resuelven en cascada: la preferencia de la conversación, si no la global, y
si no el default. El resultado se inyecta en el system prompt del resumidor.

Las preferencias globales incluyen idioma, longitud, formato, tono y **zona
horaria**. La zona horaria no es decorativa: sin ella, "resumime hoy" o "esta
semana" no tienen una interpretación única.

Las preferencias por conversación agregan foco temático, tipos de mensaje a
ignorar, y un **alias**. El alias hace determinística la resolución: si se
registra "la facu" como alias de un grupo, el pedido "resumime la facu" no
depende de que el modelo acierte entre nombres parecidos.

## 9. Resolución de conversaciones

El intérprete recibe una herramienta que busca conversaciones por nombre con
similitud, devolviendo candidatas con su actividad reciente y cantidad de
mensajes. Los alias se resuelven antes, sin intervención del modelo. Si queda
ambigüedad, se pregunta de vuelta.

## 10. Manejo de errores

La regla que ordena todo: la ingesta nunca pierde un mensaje por una falla de
una capa superior.

- Falla la descarga de un adjunto: el mensaje se guarda igual, el adjunto queda
  marcado como fallido y se reintenta cuando se lo necesite
- Falla el enriquecimiento de un adjunto: la transcripción se reemplaza por el
  marcador y el resumen sale igual. Un resumen parcial sirve más que ninguno
- Falla el LLM: el error se reporta en la conversación de control, nunca queda
  en silencio
- Se cierra la sesión desde el teléfono: se limpian las credenciales y se
  muestra un QR nuevo, sin entrar en ciclo de reinicio
- Se cae la conexión: reconexión con backoff exponencial
- Descargas de adjuntos y lotes de embeddings con límite de concurrencia

Punto débil aceptado: si Postgres está caído no hay dónde guardar, y WhatsApp no
reenvía lo ya entregado. La mitigación para la v1 es un buffer en memoria con
capacidad máxima configurable, por defecto mil mensajes, que descarta los más
antiguos al llenarse y registra en el log cuántos se perdieron. Se suma una
política de reinicio en Docker Compose. No es infalible y se documenta como tal.

## 11. Testing

Desarrollo guiado por tests: los tests se escriben antes de la implementación.

Unitarios: normalización de mensajes de Baileys desde fixtures, política de
captura, clasificación de mensajes en la conversación de control, cascada de
preferencias, resolución de alias, renderizado de transcripciones con
presupuesto de tokens, troceado por día, e invalidación del caché de resúmenes.

Integración: repositorios contra un Postgres real levantado en Docker, y el
pipeline de resumen contra modelos simulados.

End-to-end sobre el adaptador falso, cubriendo flujos completos:

1. Pedido de resumen que produce respuesta en la conversación de control
2. Pedido ambiguo que produce pregunta de vuelta y luego resolución
3. Fallo de envío que deja el mensaje en la cola y se entrega en el reintento
4. Segundo pedido solapado que reutiliza resúmenes parciales cacheados
5. Búsqueda por tema que embeddea solo lo que falta y reutiliza el resto
6. Adjuntos que se enriquecen solo dentro del rango pedido y quedan cacheados
7. Política de captura que filtra según el modo activo y sus excepciones

Las dos propiedades más importantes del diseño, que un segundo pedido no repita
trabajo y que no se re-embeddee lo ya embeddeado, se verifican explícitamente.

Queda fuera del alcance automatizado la conexión real con WhatsApp y la calidad
del texto generado. Eso se valida a mano.

## 12. Privacidad

El directorio de credenciales de sesión, la carpeta de adjuntos y el archivo de
entorno van al gitignore. Todos los secretos entran por variables de entorno.
Con Ollama como proveedor por defecto, el contenido de las conversaciones no
sale de la máquina salvo cambio explícito de proveedor.

## 13. Fuera de alcance de la v1

Por YAGNI: interfaz web, resúmenes programados o automáticos, memorias
inferidas, reranking de resultados, y soporte para más de una cuenta.

Por decisión de seguridad, no como pendiente: enviar mensajes a cualquier
conversación que no sea la de control.

## 14. Riesgos conocidos

1. `baileys` publica un release candidate como versión `latest`; no hay 7.0
   estable. Se fija la versión exacta y se acepta el riesgo
2. El provider de Ollama para el AI SDK es comunitario, no oficial. Se elige
   `ai-sdk-ollama` por estar construido sobre el cliente oficial de Ollama y
   por resolver los problemas conocidos de tool calling con respuestas vacías,
   que nos importan porque el intérprete depende de tool calling
3. La primera búsqueda por tema sobre un rango grande será lenta, porque
   embeddea en el momento. Es consecuencia aceptada de la decisión de pereza
4. Vincular un dispositivo por librería no oficial conlleva riesgo de bloqueo de
   cuenta por parte de WhatsApp
5. Cambiar de modelo de embeddings exige migración y re-embeddeo completo

## 15. Preparación previa a la implementación

1. Instalar Bun, que no está presente en la máquina
2. Instalar Ollama y descargar el modelo de generación y el de embeddings
3. Levantar Postgres con pgvector vía Docker Compose
4. Configurar Context7 como MCP para tener documentación actualizada de las
   librerías durante el desarrollo
