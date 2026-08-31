import { describirError, type Logger } from './domain/logger.ts'
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

export interface Shutdown {
  /**
   * Apaga una sola vez y devuelve cuántos mensajes quedaron sin persistir.
   *
   * Nunca rechaza: la invocan manejadores de señales, donde un rechazo sin capturar
   * mata el proceso a mitad del apagado, y como la promesa queda cacheada ese rechazo
   * se repetiría en cada señal posterior.
   */
  apagar(): Promise<number>
  /**
   * Hay un apagado en marcha o terminado. Quien esperaba al proveedor lo consulta para
   * distinguir un fallo de conexión de la desconexión que pidió la señal.
   */
  readonly enCurso: boolean
}

/**
 * Apagado ordenado: primero vacía el buffer, después suelta los recursos.
 *
 * El orden importa. Si desconectáramos antes de vaciar, un Ctrl-C entre dos
 * reintentos periódicos tiraría mensajes que la base ya podía aceptar, que es
 * justo lo que el buffer existe para evitar.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  /** Último recurso: si el canal de avisos es lo que falla, el apagado igual sigue. */
  function reportar(falla: string, error: unknown): void {
    try {
      deps.log.error(`apagado: ${falla}`, { error: describirError(error) })
    } catch {
      // Sin dónde avisar. Cortar el apagado acá cuesta más que perder el aviso.
    }
  }

  /** Aísla un paso: ninguno puede saltearse los que siguen ni hacer rechazar el apagado. */
  async function paso(falla: string, accion: () => void | Promise<void>): Promise<boolean> {
    try {
      await accion()
      return true
    } catch (error) {
      reportar(falla, error)
      return false
    }
  }

  /**
   * Devuelve los mensajes que se pierden: los que sobreviven al último intento.
   *
   * Reintenta si queda algo encolado. `flushBuffer` coalesce, así que el primer llamado
   * puede devolver el resultado de un vaciado en vuelo que ya había drenado, y lo que
   * entró al buffer en el medio nunca tuvo su intento. Para el segundo llamado
   * `stopRetries` ya corrió y el vaciado anterior terminó: arranca sin competencia.
   */
  async function vaciar(): Promise<number> {
    let persistidos = 0
    try {
      persistidos = await deps.pipeline.flushBuffer()
      if (deps.pipeline.bufferSize > 0) persistidos += await deps.pipeline.flushBuffer()
    } catch (error) {
      const perdidos = deps.pipeline.bufferSize
      deps.log.error('apagado: falló el vaciado del buffer', {
        perdidos,
        error: describirError(error),
      })
      return perdidos
    }

    deps.log.info('apagado: buffer vaciado', { persistidos })

    // `flushBuffer` no propaga el fallo por mensaje: reencola lo que no entró.
    const perdidos = deps.pipeline.bufferSize
    if (perdidos > 0) {
      deps.log.error('apagado: se pierden mensajes que no se pudieron persistir', { perdidos })
    }
    return perdidos
  }

  async function correr(): Promise<number> {
    let perdidos = 0
    await paso('no se pudo cortar el reintento del buffer', () => deps.stopRetries())
    const vaciado = await paso('quedó a medias el vaciado del buffer', async () => {
      perdidos = await vaciar()
    })
    // Si `vaciar` no llegó a devolver, la cuenta se lee del buffer. Un aviso roto rompe el
    // paso después de que la pérdida ya ocurrió, y ese es el número que decide si el proceso
    // sale con cero: perderlo acá es anunciar un apagado limpio que tiró mensajes.
    if (!vaciado) perdidos = deps.pipeline.bufferSize
    await paso('no se pudo cerrar el proveedor', () => deps.provider.disconnect())
    await paso('no se pudo cerrar la base', () => deps.closeDb())
    await paso('no se pudo anunciar el final', () => deps.log.info('apagado completo'))
    return perdidos
  }

  let enCurso: Promise<number> | null = null

  return {
    // Un Ctrl-C impaciente manda dos señales: la segunda espera el mismo apagado.
    apagar: () => (enCurso ??= correr()),
    get enCurso(): boolean {
      return enCurso !== null
    },
  }
}
