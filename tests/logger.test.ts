import { expect, test } from 'bun:test'
import { describirError } from '../src/domain/logger.ts'
import { createLogger } from '../src/logger.ts'

function capturarLineas(escribir: () => void): string[] {
  const lineas: string[] = []
  const original = console.log
  console.log = (linea: string) => lineas.push(linea)
  try {
    escribir()
  } finally {
    console.log = original
  }
  return lineas
}

test('filtra por nivel', () => {
  const lineas = capturarLineas(() => {
    const log = createLogger('warn')
    log.info('esto no se ve')
    log.warn('esto sí')
  })

  expect(lineas).toHaveLength(1)
  expect(lineas[0]).toContain('esto sí')
})

test('error se emite en el nivel más alto', () => {
  const lineas = capturarLineas(() => {
    const log = createLogger('error')
    log.warn('esto no se ve')
    log.error('se cayó')
  })

  expect(lineas).toHaveLength(1)
  expect(lineas[0]).toContain('ERROR')
  expect(lineas[0]).toContain('se cayó')
})

test('incluye los metadatos como JSON', () => {
  const lineas = capturarLineas(() => {
    createLogger('info').info('hola', { a: 1 })
  })

  expect(lineas[0]).toContain('{"a":1}')
})

test('omite los metadatos cuando no hay', () => {
  const lineas = capturarLineas(() => {
    createLogger('info').info('sin metadatos')
  })

  expect(lineas[0]).toEndWith('sin metadatos')
})

test('describirError encadena la causa que el error de arriba no nombra', () => {
  const causa = new Error('conexión rechazada')
  const envoltorio = new Error('Failed query: select 1', { cause: causa })

  expect(describirError(envoltorio)).toBe('Failed query: select 1: conexión rechazada')
})

test('describirError nombra por el código a la causa sin mensaje', () => {
  // Los errores de red de node llegan con `message` vacío: sin el código no queda nada útil.
  const causa = Object.assign(new Error(''), { code: 'ECONNREFUSED' })

  expect(describirError(new Error('Failed query', { cause: causa }))).toBe(
    'Failed query: ECONNREFUSED',
  )
})

test('describirError no rompe con algo que no es un Error', () => {
  expect(describirError('se cayó todo')).toBe('se cayó todo')
})
