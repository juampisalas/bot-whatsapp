import type { Logger } from '../../domain/logger.ts'

/**
 * La interfaz que baileys espera en su opción `logger`, con la forma de pino.
 *
 * Se declara acá en vez de importarla: baileys no la reexporta desde la raíz del paquete
 * y colgarse de una ruta interna ata el proyecto a su árbol de archivos.
 */
export interface BaileysLogger {
  level: string
  child(bindings: Record<string, unknown>): BaileysLogger
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

/**
 * Manda el log de baileys al Logger del proyecto en vez de dejarlo escribir por su cuenta.
 *
 * Sin esta opción, baileys arma su propio pino en nivel `info` sobre stdout: aunque la app
 * corra en `LOG_LEVEL=error`, siguen saliendo líneas JSON crudas, con JIDs y datos de
 * pairing adentro, en un formato que no es el del resto del log.
 *
 * La alternativa era pasarle un pino en `silent`, pero eso apaga también lo único que sirve
 * de baileys en producción: sus avisos de conexión y de descifrado, que explican caídas que
 * el adaptador ve solamente como un `connection: 'close'`. Este shim los conserva y filtra
 * el resto:
 *
 * - `trace`, `debug` e `info` se descartan enteros. Ahí vive el ruido por mensaje y también
 *   lo más sensible (el `pairing configured successfully` lleva las credenciales, y hay
 *   líneas de nivel info que vuelcan nodos completos en el propio texto).
 * - De `warn` y `error` se reenvía solo el texto, que en baileys es una constante. El objeto
 *   que lo acompaña —JIDs, nodos binarios, participantes— se descarta: es la parte que no
 *   podemos dejar salir a un log de operación.
 */
export function createBaileysLogger(log: Logger): BaileysLogger {
  /** Baileys usa las dos formas de pino: `(obj, msg)` y `(msg)`. */
  function texto(obj: unknown, msg?: string): string | null {
    if (typeof msg === 'string') return msg
    return typeof obj === 'string' ? obj : null
  }

  function emitir(nivel: 'warn' | 'error') {
    return (obj: unknown, msg?: string): void => {
      const linea = texto(obj, msg)
      // Sin texto solo queda el objeto, que es justamente lo que no se reenvía.
      if (linea !== null) log[nivel](`baileys: ${linea}`)
    }
  }

  const logger: BaileysLogger = {
    // Baileys compara este valor con 'trace' y 'debug' para decidir si serializa nodos
    // enteros antes de loguearlos: declarar el nivel que de verdad se emite evita ese
    // trabajo y esos volcados.
    level: 'warn',
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: emitir('warn'),
    error: emitir('error'),
  }

  return logger
}
