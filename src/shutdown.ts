import type { Logger } from './domain/logger.ts'
import type { MessagingProvider } from './domain/provider.ts'

export interface ShutdownDeps {
  /** Lo mínimo del pipeline de ingesta: vaciar lo encolado y saber qué queda. */
  pipeline: {
    flushBuffer(): Promise<number>
    readonly bufferSize: number
  }
  provider: Pick<MessagingProvider, 'disconnect'>
  closeDb: () => Promise<void>
  /** Corta el reintento periódico del buffer. */
  stopRetries: () => void
  log: Logger
}

function describir(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Apagado ordenado: primero vacía el buffer, después suelta los recursos.
 *
 * El orden importa. Si desconectáramos antes de vaciar, un Ctrl-C entre dos
 * reintentos periódicos tiraría mensajes que la base ya podía aceptar, que es
 * justo lo que el buffer existe para evitar.
 *
 * La función devuelta nunca rechaza: la invocan manejadores de señales, donde
 * un rechazo sin capturar mata el proceso a mitad del apagado.
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  async function vaciar(): Promise<void> {
    try {
      const persistidos = await deps.pipeline.flushBuffer()
      deps.log.info('apagado: buffer vaciado', { persistidos })
    } catch (error) {
      deps.log.error('apagado: falló el vaciado del buffer', {
        perdidos: deps.pipeline.bufferSize,
        error: describir(error),
      })
      return
    }

    // `flushBuffer` no propaga el fallo por mensaje: reencola lo que no entró.
    // Lo que sobrevive al último intento se pierde, y eso se dice en voz alta.
    const perdidos = deps.pipeline.bufferSize
    if (perdidos > 0) {
      deps.log.error('apagado: se pierden mensajes que no se pudieron persistir', { perdidos })
    }
  }

  async function soltar(recurso: string, cerrar: () => Promise<void>): Promise<void> {
    try {
      await cerrar()
    } catch (error) {
      deps.log.error(`apagado: no se pudo cerrar ${recurso}`, { error: describir(error) })
    }
  }

  async function apagar(): Promise<void> {
    deps.stopRetries()
    await vaciar()
    await soltar('el proveedor', () => deps.provider.disconnect())
    await soltar('la base', deps.closeDb)
    deps.log.info('apagado completo')
  }

  // Un Ctrl-C impaciente manda dos señales: la segunda espera el mismo apagado.
  let enCurso: Promise<void> | null = null
  return () => (enCurso ??= apagar())
}
