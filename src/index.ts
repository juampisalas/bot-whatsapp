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
  /**
   * La espera del QR de acá abajo puede durar minutos y es la que más se mira: el listado se
   * corre antes de tener credenciales. Sin manejador propio, la señal mata el proceso con el
   * socket abierto y las credenciales a medio escribir. Acá todavía no hay base ni buffer, así
   * que el apagado ordenado del modo captura sería de más: alcanza con soltar el proveedor.
   */
  let cortando: Promise<never> | null = null
  const cortar = (senal: number): void => {
    // Un Ctrl-C impaciente no arranca una segunda desconexión sobre la primera.
    cortando ??= (async (): Promise<never> => {
      try {
        await provider.disconnect()
      } catch (error) {
        log.error('no se pudo cerrar la conexión', { error: describirError(error) })
      }
      process.exit(128 + senal)
    })()
  }

  process.once('SIGINT', () => cortar(2))
  process.once('SIGTERM', () => cortar(15))

  let codigo = 0
  try {
    await provider.connect()
    await provider.waitUntilReady()
    for (const conversacion of await provider.listConversations()) {
      // Salida tabulada por stdout, no por el logger: está pensada para copiar y pegar o filtrar.
      console.log(`${conversacion.externalId}\t${conversacion.name ?? '(sin nombre)'}`)
    }
  } catch (error) {
    // Con una señal en curso el rechazo es de la desconexión que ella pidió, no un fallo de
    // listado: anunciarlo como tal mandaría a buscar un problema que no existe.
    if (cortando === null) {
      log.error('no se pudieron listar las conversaciones', { error: describirError(error) })
      codigo = 1
    }
  }

  // Se desconecta afuera del try: un fallo al listar no justifica dejar el socket abierto.
  try {
    await provider.disconnect()
  } catch (error) {
    log.error('no se pudo cerrar la conexión', { error: describirError(error) })
  }

  // El final lo decide la señal si llegó: `cortar` sale con su propio código y no devuelve.
  if (cortando) await cortando

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
 * de salida no tiene que poder confundirlo con uno limpio. Depende de que no haya un
 * bucle de reinicio detrás; con uno, habría que distinguir la señal de la caída.
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
