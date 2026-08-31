import { expect, test } from 'bun:test'
import type { Logger } from '../src/domain/logger.ts'
import { createShutdown } from '../src/shutdown.ts'

interface OpcionesEntorno {
  /** Cuántos mensajes logra persistir el vaciado. */
  persistidos?: number
  /** Cuántos quedan en el buffer después de intentar vaciarlo. */
  restantes?: number
  fallaVaciado?: Error
  fallaDesconexion?: Error
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
    info: (message, meta) => infos.push({ message, meta }),
    warn: () => {},
    error: (message, meta) => errores.push({ message, meta }),
  }

  const apagar = createShutdown({
    pipeline: {
      flushBuffer: async () => {
        orden.push('vaciar')
        if (opciones.fallaVaciado) throw opciones.fallaVaciado
        return opciones.persistidos ?? 2
      },
      get bufferSize() {
        return opciones.restantes ?? 0
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
    },
    stopRetries: () => orden.push('cortarReintento'),
    log,
  })

  return { apagar, orden, infos, errores }
}

test('vacía el buffer antes de desconectar y cerrar la base', async () => {
  const entorno = crearEntorno({ persistidos: 3 })

  await entorno.apagar()

  expect(entorno.orden).toEqual(['cortarReintento', 'vaciar', 'desconectar', 'cerrarBase'])
  expect(entorno.infos.find((linea) => linea.meta?.persistidos !== undefined)?.meta?.persistidos)
    .toBe(3)
  expect(entorno.errores).toHaveLength(0)
})

test('avisa cuántos mensajes se pierden si el buffer no se vacía del todo', async () => {
  const entorno = crearEntorno({ persistidos: 1, restantes: 4 })

  await entorno.apagar()

  expect(entorno.errores).toHaveLength(1)
  expect(entorno.errores[0]?.meta?.perdidos).toBe(4)
  expect(entorno.orden).toContain('cerrarBase')
})

test('avisa cuántos mensajes se pierden si el vaciado falla', async () => {
  const entorno = crearEntorno({ fallaVaciado: new Error('base caída'), restantes: 2 })

  await entorno.apagar()

  expect(entorno.errores).toHaveLength(1)
  expect(entorno.errores[0]?.meta?.perdidos).toBe(2)
  expect(entorno.errores[0]?.meta?.error).toBe('base caída')
  expect(entorno.orden).toEqual(['cortarReintento', 'vaciar', 'desconectar', 'cerrarBase'])
})

test('dos señales seguidas apagan una sola vez', async () => {
  const entorno = crearEntorno()

  await Promise.all([entorno.apagar(), entorno.apagar()])
  await entorno.apagar()

  expect(entorno.orden.filter((paso) => paso === 'vaciar')).toHaveLength(1)
  expect(entorno.orden.filter((paso) => paso === 'desconectar')).toHaveLength(1)
  expect(entorno.orden.filter((paso) => paso === 'cerrarBase')).toHaveLength(1)
})

test('cierra la base aunque falle la desconexión del proveedor', async () => {
  const entorno = crearEntorno({ fallaDesconexion: new Error('socket colgado') })

  await entorno.apagar()

  expect(entorno.orden).toContain('cerrarBase')
  expect(entorno.errores.some((linea) => linea.meta?.error === 'socket colgado')).toBe(true)
})
