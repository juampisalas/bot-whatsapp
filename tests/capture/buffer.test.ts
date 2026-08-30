import { expect, test } from 'bun:test'
import { BoundedBuffer } from '../../src/capture/buffer.ts'

test('acumula y vacía en orden de llegada', () => {
  const buffer = new BoundedBuffer<number>(5)
  buffer.push(1)
  buffer.push(2)

  expect(buffer.size).toBe(2)
  expect(buffer.drain()).toEqual([1, 2])
  expect(buffer.size).toBe(0)
})

test('descarta los más antiguos al superar el límite y los cuenta', () => {
  const buffer = new BoundedBuffer<number>(2)
  buffer.push(1)
  buffer.push(2)
  buffer.push(3)

  expect(buffer.drain()).toEqual([2, 3])
  expect(buffer.dropped).toBe(1)
})

test.each([0, -1, 1.5])('rechaza el límite inválido %p', (limit) => {
  expect(() => new BoundedBuffer<number>(limit)).toThrow(/entero positivo/)
})

test('mantiene el total acumulado de descartes después de vaciarse', () => {
  const buffer = new BoundedBuffer<number>(1)
  buffer.push(1)
  buffer.push(2)
  expect(buffer.dropped).toBe(1)

  buffer.drain()
  buffer.push(3)
  buffer.push(4)

  expect(buffer.dropped).toBe(2)
})

test('vaciar un buffer vacío devuelve una lista vacía y permite reutilizarlo', () => {
  const buffer = new BoundedBuffer<number>(2)

  expect(buffer.drain()).toEqual([])
  expect(buffer.size).toBe(0)

  buffer.push(1)
  expect(buffer.drain()).toEqual([1])
})
