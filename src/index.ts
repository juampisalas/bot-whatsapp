import { createIngestPipeline } from './capture/ingest.ts'
import type { CapturePolicy } from './capture/policy.ts'
import { parseCommand, type Command } from './cli.ts'
import { loadConfig } from './config/index.ts'
import { describirError } from './domain/logger.ts'
import { createLogger } from './logger.ts'
import { createProvider } from './providers/registry.ts'
import { createShutdown } from './shutdown.ts'
import { createDb } from './store/client.ts'
import { loadCapturePolicy } from './store/repositories/capture-policy.ts'

const config = loadConfig()
const log = createLogger(config.LOG_LEVEL)

let comando: Command
try {
  comando = parseCommand(process.argv.slice(2))
} catch (error) {
  // Un error de uso no merece un stack trace: alcanza con el mensaje y un código distinto de cero.
  log.error(describirError(error))
  process.exit(1)
}

const provider = createProvider(config.PROVIDER, config, log)

if (comando === 'list-conversations') {
  let codigo = 0
  try {
    await provider.connect()
    await provider.waitUntilReady()
    for (const conversacion of await provider.listConversations()) {
      // Salida tabulada por stdout, no por el logger: está pensada para copiar y pegar o filtrar.
      console.log(`${conversacion.externalId}\t${conversacion.name ?? '(sin nombre)'}`)
    }
  } catch (error) {
    log.error('no se pudieron listar las conversaciones', { error: describirError(error) })
    codigo = 1
  }

  // Se desconecta afuera del try: un fallo al listar no justifica dejar el socket abierto.
  try {
    await provider.disconnect()
  } catch (error) {
    log.error('no se pudo cerrar la conexión', { error: describirError(error) })
  }

  // baileys deja temporizadores propios; salir explícito evita que el proceso quede colgado.
  process.exit(codigo)
}

const { db, close } = createDb(config.DATABASE_URL)

let policy: CapturePolicy
try {
  policy = await loadCapturePolicy(db, provider.id)
} catch (error) {
  log.error('no se pudo cargar la política de captura', { error: describirError(error) })
  // Sin política no hay captura: soltar el pool acá evita terminar con conexiones abiertas.
  try {
    await close()
  } catch (fallo) {
    log.error('no se pudo cerrar la base', { error: describirError(fallo) })
  }
  process.exit(1)
}
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

const shutdown = createShutdown({
  pipeline,
  provider,
  closeDb: close,
  stopRetries: () => clearInterval(reintento),
  log,
})

/**
 * Un apagado que tiró mensajes no sale con cero: un supervisor que solo mira el código
 * de salida no tiene que poder confundirlo con uno limpio. La contra —un SIGTERM
 * contado como caída— no aplica acá: el proceso termina porque se lo pidieron y no hay
 * bucle de reinicio detrás.
 */
function salir(perdidos: number): never {
  process.exit(perdidos > 0 ? 1 : 0)
}

async function apagarYSalir(): Promise<void> {
  salir(await shutdown.apagar())
}

process.on('SIGINT', () => void apagarYSalir())
process.on('SIGTERM', () => void apagarYSalir())

// Las señales se registran antes de conectar para poder cortar la espera del QR.
try {
  await provider.connect()
  await provider.waitUntilReady()
} catch (error) {
  if (shutdown.enCurso) {
    // La señal ya pidió la desconexión y el proveedor rechaza a quien lo esperaba: no es
    // un fallo de conexión sino el apagado haciendo lo suyo. Alcanza con acompañarlo.
    salir(await shutdown.apagar())
  }
  log.error('no se pudo conectar con el proveedor', { error: describirError(error) })
  await shutdown.apagar()
  process.exit(1)
}
log.info('capturando mensajes')
