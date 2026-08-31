import { expect, test } from 'bun:test'
import type { Logger } from '../src/domain/logger.ts'
import { createShutdown } from '../src/shutdown.ts'

interface OpcionesEntorno {
  /** Cuántos mensajes hay encolados cuando llega la señal. */
  pendientes?: number
  /** Cuántos de esos rechaza la base en todo intento; por defecto, ninguno. */
  irrecuperables?: number
  /**
   * Cuántos entran al buffer mientras corre el primer vaciado. Emula el coalescing de
   * `flushBuffer`: el número que recibe el apagado viene de un vaciado que ya había
   * drenado, así que estos quedan encolados sin haber tenido su intento.
   */
  tardios?: number
  /**
   * Cuántos entran al buffer durante la desconexión. Emula el mensaje que estaba en vuelo
   * cuando llegó la señal: el proveedor lo espera antes de soltar el socket y ese intento
   * falla contra una base que ya no responde, así que termina encolado.
   */
  enVuelo?: number
  fallaVaciado?: Error
  fallaDesconexion?: Error
  fallaCierreBase?: Error
  /** Rompe el aviso de vaciado, que corre cuando la pérdida ya está medida. */
  fallaAviso?: Error
}

interface Linea {
  message: string
  meta?: Record<string, unknown>
}

function crearEntorno(opciones: OpcionesEntorno = {}) {
  const orden: string[] = []
  const infos: Linea[] = []
  const errores: Linea[] = []
  const log: Logger = {
    info: (message, meta) => {
      infos.push({ message, meta })
      if (opciones.fallaAviso && message === 'apagado: buffer vaciado') throw opciones.fallaAviso
    },
    warn: () => {},
    error: (message, meta) => errores.push({ message, meta }),
  }

  // El buffer lleva la cuenta en vez de devolver un fijo: el vaciado lo baja en lo que dice
  // haber persistido, así que los `perdidos` esperados solo salen si el apagado los mide
  // después del último intento y no antes.
  let pendientes = opciones.pendientes ?? 0
  let tardios = opciones.tardios ?? 0

  const shutdown = createShutdown({
    pipeline: {
      flushBuffer: async () => {
        orden.push('vaciar')
        if (opciones.fallaVaciado) throw opciones.fallaVaciado
        const persistidos = Math.max(0, pendientes - (opciones.irrecuperables ?? 0))
        pendientes -= persistidos
        pendientes += tardios
        tardios = 0
        return persistidos
      },
      get bufferSize() {
        return pendientes
      },
    },
    provider: {
      disconnect: async () => {
        orden.push('desconectar')
        pendientes += opciones.enVuelo ?? 0
        if (opciones.fallaDesconexion) throw opciones.fallaDesconexion
      },
    },
    closeDb: async () => {
      orden.push('cerrarBase')
      if (opciones.fallaCierreBase) throw opciones.fallaCierreBase
    },
    stopRetries: () => orden.push('cortarReintento'),
    log,
  })

  return {
    shutdown,
    orden,
    infos,
    errores,
    get pendientes(): number {
      return pendientes
    },
  }
}

test('desconecta antes de vaciar el buffer y cierra la base al final', async () => {
  const entorno = crearEntorno({ pendientes: 3 })

  expect(await entorno.shutdown.apagar()).toBe(0)

  expect(entorno.orden).toEqual(['cortarReintento', 'desconectar', 'vaciar', 'cerrarBase'])
  expect(entorno.infos.find((linea) => linea.meta?.persistidos !== undefined)?.meta?.persistidos)
    .toBe(3)
  expect(entorno.errores).toHaveLength(0)
})

test('persiste el mensaje que estaba en vuelo cuando llegó la señal', async () => {
  const entorno = crearEntorno({ enVuelo: 1 })

  // Vaciar antes de desconectar deja este mensaje encolado después del último intento:
  // el apagado devolvería cero perdidos y nadie volvería a leer ese buffer.
  expect(await entorno.shutdown.apagar()).toBe(0)

  expect(entorno.pendientes).toBe(0)
  expect(entorno.infos.find((linea) => linea.meta?.persistidos !== undefined)?.meta?.persistidos)
    .toBe(1)
})

test('avisa cuántos mensajes se pierden si el buffer no se vacía del todo', async () => {
  const entorno = crearEntorno({ pendientes: 5, irrecuperables: 4 })

  expect(await entorno.shutdown.apagar()).toBe(4)

  expect(entorno.errores).toHaveLength(1)
  expect(entorno.errores[0]?.meta?.perdidos).toBe(4)
  expect(entorno.orden).toContain('cerrarBase')
})

test('reintenta el vaciado por lo que entró al buffer durante el anterior', async () => {
  const entorno = crearEntorno({ pendientes: 2, tardios: 1 })

  expect(await entorno.shutdown.apagar()).toBe(0)

  expect(entorno.orden).toEqual([
    'cortarReintento',
    'desconectar',
    'vaciar',
    'vaciar',
    'cerrarBase',
  ])
  expect(
    entorno.infos.find((linea) => linea.meta?.persistidos !== undefined)?.meta?.persistidos,
  ).toBe(3)
  expect(entorno.errores).toHaveLength(0)
})

test('avisa cuántos mensajes se pierden si el vaciado falla', async () => {
  const entorno = crearEntorno({ pendientes: 2, fallaVaciado: new Error('base caída') })

  expect(await entorno.shutdown.apagar()).toBe(2)

  expect(entorno.errores).toHaveLength(1)
  expect(entorno.errores[0]?.meta?.perdidos).toBe(2)
  expect(entorno.errores[0]?.meta?.error).toBe('base caída')
  expect(entorno.orden).toEqual(['cortarReintento', 'desconectar', 'vaciar', 'cerrarBase'])
})

test('dos señales seguidas apagan una sola vez', async () => {
  const entorno = crearEntorno()

  await Promise.all([entorno.shutdown.apagar(), entorno.shutdown.apagar()])
  await entorno.shutdown.apagar()

  expect(entorno.orden.filter((paso) => paso === 'vaciar')).toHaveLength(1)
  expect(entorno.orden.filter((paso) => paso === 'desconectar')).toHaveLength(1)
  expect(entorno.orden.filter((paso) => paso === 'cerrarBase')).toHaveLength(1)
})

test('enCurso queda en alto desde que arranca el apagado', async () => {
  const entorno = crearEntorno()

  expect(entorno.shutdown.enCurso).toBe(false)
  const apagado = entorno.shutdown.apagar()
  expect(entorno.shutdown.enCurso).toBe(true)

  await apagado

  // Sigue en alto después de terminar: un rechazo que llega tarde también es consecuencia suya.
  expect(entorno.shutdown.enCurso).toBe(true)
})

test('cierra la base aunque falle la desconexión del proveedor', async () => {
  const entorno = crearEntorno({ fallaDesconexion: new Error('socket colgado') })

  await entorno.shutdown.apagar()

  expect(entorno.orden).toContain('cerrarBase')
  expect(entorno.errores.some((linea) => linea.meta?.error === 'socket colgado')).toBe(true)
})

test('termina el apagado aunque falle el cierre de la base', async () => {
  const entorno = crearEntorno({ fallaCierreBase: new Error('pool ocupado') })

  await entorno.shutdown.apagar()

  expect(entorno.errores.some((linea) => linea.meta?.error === 'pool ocupado')).toBe(true)
  expect(entorno.infos.some((linea) => linea.message === 'apagado completo')).toBe(true)
})

test('un aviso roto no se reporta como pérdida ni interrumpe el apagado', async () => {
  const entorno = crearEntorno({
    pendientes: 5,
    irrecuperables: 4,
    fallaAviso: new Error('stdout cerrado'),
  })

  // El aviso rompe entre medir la pérdida y devolverla: si el apagado la soltara ahí, saldría
  // con cero después de tirar cuatro mensajes.
  expect(await entorno.shutdown.apagar()).toBe(4)

  expect(entorno.errores.some((linea) => linea.message.includes('falló el vaciado'))).toBe(false)
  expect(entorno.errores.some((linea) => linea.meta?.error === 'stdout cerrado')).toBe(true)
  expect(entorno.orden).toEqual([
    'cortarReintento',
    'desconectar',
    'vaciar',
    'vaciar',
    'cerrarBase',
  ])
})

test('una causa circular no borra la cuenta de mensajes perdidos', async () => {
  // `describirError` recorre la cadena de causas para armar la línea de log: si desborda la
  // pila, el fallo se lleva puesto el número que decide el código de salida.
  const arriba = new Error('base caída')
  arriba.cause = new Error('socket roto', { cause: arriba })
  const entorno = crearEntorno({ pendientes: 4, fallaVaciado: arriba })

  expect(await entorno.shutdown.apagar()).toBe(4)

  expect(entorno.orden).toContain('cerrarBase')
})
