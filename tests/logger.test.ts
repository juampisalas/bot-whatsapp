import { expect, test } from 'bun:test'
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
