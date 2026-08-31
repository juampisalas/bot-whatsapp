import { createIngestPipeline } from './capture/ingest.ts'
import { parseCommand, type Command } from './cli.ts'
import { loadConfig } from './config/index.ts'
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
  log.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const provider = createProvider(config.PROVIDER, config, log)

if (comando === 'list-conversations') {
  await provider.connect()
  await provider.waitUntilReady()
  for (const conversacion of await provider.listConversations()) {
    // Salida tabulada por stdout, no por el logger: está pensada para copiar y pegar o filtrar.
    console.log(`${conversacion.externalId}\t${conversacion.name ?? '(sin nombre)'}`)
  }
  await provider.disconnect()
  // El adaptador puede dejar temporizadores propios; salir explícito evita que el proceso quede colgado.
  process.exit(0)
}

const { db, close } = createDb(config.DATABASE_URL)

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

const apagar = createShutdown({
  pipeline,
  provider,
  closeDb: close,
  stopRetries: () => clearInterval(reintento),
  log,
})

async function apagarYSalir(): Promise<void> {
  await apagar()
  process.exit(0)
}

process.on('SIGINT', () => void apagarYSalir())
process.on('SIGTERM', () => void apagarYSalir())

// Las señales se registran antes de conectar para poder cortar la espera del QR.
await provider.connect()
await provider.waitUntilReady()
log.info('capturando mensajes')
