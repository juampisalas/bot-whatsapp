import { expect, test } from 'bun:test'
import type { Logger } from '../src/domain/logger.ts'
import { createShutdown } from '../src/shutdown.ts'

interface OpcionesEntorno {
  /** Cuántos mensajes hay encolados cuando llega la señal. */
  pendientes?: number
  /** Cuántos de esos logra persistir el vaciado; por defecto, todos. */
  persistidos?: number
  fallaVaciado?: Error
  fallaDesconexion?: Error
  fallaCierreBase?: Error
  /** Rompe el aviso de vaciado, el único paso que corre con el buffer ya persistido. */
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

  const shutdown = createShutdown({
    pipeline: {
      flushBuffer: async () => {
        orden.push('vaciar')
        if (opciones.fallaVaciado) throw opciones.fallaVaciado
        const persistidos = Math.min(opciones.persistidos ?? pendientes, pendientes)
        pendientes -= persistidos
        return persistidos
      },
      get bufferSize() {
        return pendientes
      },
    },
    provider: {
      disconnect: async () => {
        orden.push('desconectar')
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

  return { shutdown, orden, infos, errores }
}

test('vacía el buffer antes de desconectar y cerrar la base', async () => {
  const entorno = crearEntorno({ pendientes: 3 })

  expect(await entorno.shutdown.apagar()).toBe(0)

  expect(entorno.orden).toEqual(['cortarReintento', 'vaciar', 'desconectar', 'cerrarBase'])
  expect(entorno.infos.find((linea) => linea.meta?.persistidos !== undefined)?.meta?.persistidos)
    .toBe(3)
  expect(entorno.errores).toHaveLength(0)
})

test('avisa cuántos mensajes se pierden si el buffer no se vacía del todo', async () => {
  const entorno = crearEntorno({ pendientes: 5, persistidos: 1 })

  expect(await entorno.shutdown.apagar()).toBe(4)

  expect(entorno.errores).toHaveLength(1)
  expect(entorno.errores[0]?.meta?.perdidos).toBe(4)
  expect(entorno.orden).toContain('cerrarBase')
})

test('avisa cuántos mensajes se pierden si el vaciado falla', async () => {
  const entorno = crearEntorno({ pendientes: 2, fallaVaciado: new Error('base caída') })

  expect(await entorno.shutdown.apagar()).toBe(2)

  expect(entorno.errores).toHaveLength(1)
  expect(entorno.errores[0]?.meta?.perdidos).toBe(2)
  expect(entorno.errores[0]?.meta?.error).toBe('base caída')
  expect(entorno.orden).toEqual(['cortarReintento', 'vaciar', 'desconectar', 'cerrarBase'])
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
  const entorno = crearEntorno({ pendientes: 2, fallaAviso: new Error('stdout cerrado') })

  expect(await entorno.shutdown.apagar()).toBe(0)

  expect(entorno.errores.some((linea) => linea.message.includes('falló el vaciado'))).toBe(false)
  expect(entorno.errores.some((linea) => linea.meta?.error === 'stdout cerrado')).toBe(true)
  expect(entorno.orden).toEqual(['cortarReintento', 'vaciar', 'desconectar', 'cerrarBase'])
})
