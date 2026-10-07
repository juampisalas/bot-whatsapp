import { createEmbedder, createLlm } from './agent/llm/registry.ts'
import { createMediaModel } from './agent/media/model.ts'
import { createIngestPipeline } from './capture/ingest.ts'
import { persistContactMeta, persistConversationMeta, syncDirectoryToDb } from './capture/directory.ts'
import type { CapturePolicy } from './capture/policy.ts'
import { parseCommand, type Command } from './cli.ts'
import { loadConfig } from './config/index.ts'
import {
  shouldAnswerControlMessage,
  shouldDiscardUnansweredControlMessage,
} from './control/classify.ts'
import { createControlLoop } from './control/loop.ts'
import { describeError } from './domain/logger.ts'
import { createLogger } from './logger.ts'
import { createDispatcher } from './outbox/dispatcher.ts'
import { createProvider } from './providers/registry.ts'
import { createShutdown } from './shutdown.ts'
import { createDb } from './store/client.ts'
import { loadCapturePolicy } from './store/repositories/capture-policy.ts'
import { deleteMessageByExternalId } from './store/repositories/messages.ts'

const config = loadConfig()
const log = createLogger(config.LOG_LEVEL)

let command: Command
try {
  command = parseCommand(process.argv.slice(2))
} catch (error) {
  // A usage error does not deserve a stack trace: the message and a non-zero exit suffice.
  log.error(describeError(error))
  process.exit(1)
}

const provider = createProvider(config.PROVIDER, config, log)

if (command === 'list-conversations') {
  /**
   * The QR wait below can last many minutes and is the path people watch most: listing
   * runs before credentials exist. Without a handler, the signal kills the process with
   * the socket open and credentials mid-write. There is no database or buffer here yet, so
   * the ordered capture shutdown would be overkill: releasing the provider is enough.
   */
  let shuttingDown: Promise<never> | null = null
  const shutDownOnSignal = (signal: number): void => {
    // An impatient Ctrl-C must not start a second disconnect on top of the first.
    // Use `on` (not `once`): a second signal must still hit this handler while disconnect
    // is in flight; otherwise Node's default terminates mid-credential write.
    shuttingDown ??= (async (): Promise<never> => {
      try {
        await provider.disconnect()
      } catch (error) {
        log.error('could not close the connection', { error: describeError(error) })
      }
      process.exit(128 + signal)
    })()
  }

  process.on('SIGINT', () => shutDownOnSignal(2))
  process.on('SIGTERM', () => shutDownOnSignal(15))

  let exitCode = 0
  try {
    await provider.connect()
    // Pairing can take several minutes across QR rotations; the provider resets the timer
    // on each QR. Pass an explicit budget so a slow first scan does not look like a list failure.
    await provider.waitUntilReady(600_000)
    for (const conversation of await provider.listConversations()) {
      // Tab-separated stdout, not the logger: meant to be copied or filtered.
      console.log(`${conversation.externalId}\t${conversation.name ?? '(unnamed)'}`)
    }
  } catch (error) {
    // With a signal in flight the rejection is from the disconnect it requested, not a
    // listing failure: reporting it as such would send people looking for a problem that
    // does not exist.
    if (shuttingDown === null) {
      log.error('could not list conversations', { error: describeError(error) })
      exitCode = 1
    }
  }

  // Disconnect outside the try: a listing failure is no reason to leave the socket open.
  try {
    await provider.disconnect()
  } catch (error) {
    log.error('could not close the connection', { error: describeError(error) })
  }

  // If a signal arrived, `shutDownOnSignal` exits with its own code and never returns.
  if (shuttingDown) await shuttingDown

  // Baileys leaves its own timers; an explicit exit avoids a hung process.
  process.exit(exitCode)
}

const { db, close } = createDb(config.DATABASE_URL)

let policy: CapturePolicy
try {
  policy = await loadCapturePolicy(db, provider.id)
} catch (error) {
  log.error('could not load capture policy', { error: describeError(error) })
  // Without a policy there is no capture: release the pool so we do not exit with open connections.
  try {
    await close()
  } catch (failure) {
    log.error('could not close the database', { error: describeError(failure) })
  }
  process.exit(1)
}
log.info('capture policy loaded', { mode: policy.mode, rules: policy.rules.size })

const pipeline = createIngestPipeline({
  db,
  policy,
  provider,
  bufferMax: config.CAPTURE_BUFFER_MAX,
  log,
})

const controlConfig = {
  CONTROL_PROVIDER: config.CONTROL_PROVIDER,
  CONTROL_CONVERSATION_ID: config.CONTROL_CONVERSATION_ID,
}

let control: ReturnType<typeof createControlLoop> | null = null
let stopDispatch: (() => void) | null = null

if (config.CONTROL_CONVERSATION_ID) {
  control = createControlLoop({
    db,
    config: controlConfig,
    log,
    llm: createLlm(config),
    embedder: createEmbedder(config),
    media: createMediaModel(config, log),
    provider,
  })
  const dispatcher = createDispatcher({ db, provider, config: controlConfig, log })
  stopDispatch = dispatcher.start(1_000)
} else {
  log.info('control disabled: CONTROL_CONVERSATION_ID is missing')
}

provider.onMessage(async (message) => {
  if (
    shouldDiscardUnansweredControlMessage({
      message,
      controlConversationId: config.CONTROL_CONVERSATION_ID,
    })
  ) {
    try {
      await deleteMessageByExternalId(db, message.provider, message.externalId)
    } catch (error) {
      log.warn('could not drop unanswered control message', {
        externalId: message.externalId,
        error: describeError(error),
      })
    }
    return
  }

  let stored: { inserted: boolean } | undefined
  try {
    stored = await pipeline.handle(message)
  } catch (error) {
    log.error('ingest crashed', { error: describeError(error) })
  }
  if (
    control &&
    shouldAnswerControlMessage({
      historical: message.historical === true,
      newlyCaptured: stored?.inserted === true,
    })
  ) {
    try {
      await control.handle(message)
    } catch (error) {
      log.warn('control crashed', { error: describeError(error) })
    }
  }
})

provider.onConversationMeta?.(async (conversation) => {
  try {
    await persistConversationMeta(db, provider.id, conversation)
  } catch (error) {
    log.warn('could not upsert conversation metadata', {
      externalId: conversation.externalId,
      error: describeError(error),
    })
  }
})

provider.onContactMeta?.(async (contact) => {
  try {
    await persistContactMeta(db, provider.id, contact)
  } catch (error) {
    log.warn('could not sync contact metadata', {
      externalIds: contact.externalIds,
      error: describeError(error),
    })
  }
})

// Retry whatever stayed in the buffer while the database was down.
const retryTimer = setInterval(() => {
  void pipeline.flushBuffer()
}, 30_000)

const shutdown = createShutdown({
  pipeline,
  provider,
  closeDb: close,
  stopRetries: () => {
    clearInterval(retryTimer)
    stopDispatch?.()
  },
  log,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
})

/**
 * A shutdown that dropped messages must not exit zero: a supervisor that only watches the
 * exit code must not mistake it for a clean one. Assumes there is no restart loop behind
 * us; with one, signal and crash would need to be distinguished.
 */
function exit(lost: number): never {
  process.exit(lost > 0 ? 1 : 0)
}

async function shutDownAndExit(): Promise<void> {
  exit(await shutdown.shutDown())
}

/**
 * A terminal provider failure exits one even with no lost messages: the process stopped
 * capturing, and without a non-zero code a supervisor would see it as healthy forever.
 */
async function shutDownOnTerminalFailure(error: Error): Promise<never> {
  log.error('provider can no longer capture', { error: describeError(error) })
  await shutdown.shutDown()
  process.exit(1)
}

process.on('SIGINT', () => void shutDownAndExit())
process.on('SIGTERM', () => void shutDownAndExit())
provider.onFatal((error) => void shutDownOnTerminalFailure(error))

// Signals are registered before connect so the QR wait can be interrupted.
try {
  await provider.connect()
  await provider.waitUntilReady(600_000)
} catch (error) {
  if (shutdown.inProgress) {
    // The signal already requested disconnect and the provider rejects whoever was waiting:
    // not a connect failure but shutdown doing its job. Just accompany it.
    exit(await shutdown.shutDown())
  }
  log.error('could not connect to the provider', { error: describeError(error) })
  await shutdown.shutDown()
  process.exit(1)
}
log.info('capturing messages')
void syncDirectoryToDb(db, provider)
  .then(() => {
    log.info('initial directory sync finished')
  })
  .catch((error) => {
    log.warn('initial directory sync failed', { error: describeError(error) })
  })
