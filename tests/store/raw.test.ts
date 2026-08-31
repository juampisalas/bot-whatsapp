import { expect, test } from 'bun:test'
import { decodeRaw, encodeRaw } from '../../src/store/raw.ts'

test('encodeRaw marks bytes and decodeRaw restores them', () => {
  const raw = { mediaKey: new Uint8Array([1, 2, 3]), caption: 'hola' }
  const encoded = encodeRaw(raw)
  expect(encoded).toEqual({
    mediaKey: { $bin: 'b64', data: Buffer.from([1, 2, 3]).toString('base64') },
    caption: 'hola',
  })
  const decoded = decodeRaw(encoded)
  expect(decoded).toEqual({ mediaKey: new Uint8Array([1, 2, 3]), caption: 'hola' })
})

test('encodeRaw does not mutate the original', () => {
  const raw = { mediaKey: new Uint8Array([9]) }
  encodeRaw(raw)
  expect(raw.mediaKey).toBeInstanceOf(Uint8Array)
})

test('decodeRaw leaves unmarked values intact', () => {
  expect(decodeRaw({ a: 1 })).toEqual({ a: 1 })
})

test('encodeRaw and decodeRaw walk nested arrays and objects', () => {
  const raw = {
    keys: [new Uint8Array([4, 5]), { nested: new Uint8Array([6]) }],
  }
  const encoded = encodeRaw(raw)
  expect(encoded).toEqual({
    keys: [
      { $bin: 'b64', data: Buffer.from([4, 5]).toString('base64') },
      { nested: { $bin: 'b64', data: Buffer.from([6]).toString('base64') } },
    ],
  })
  expect(decodeRaw(encoded)).toEqual({
    keys: [new Uint8Array([4, 5]), { nested: new Uint8Array([6]) }],
  })
})

test('encodeRaw encodes ArrayBuffer and Buffer', () => {
  const raw = {
    fromArrayBuffer: new Uint8Array([7, 8]).buffer,
    fromBuffer: Buffer.from([9, 10]),
  }
  const encoded = encodeRaw(raw)
  expect(encoded).toEqual({
    fromArrayBuffer: { $bin: 'b64', data: Buffer.from([7, 8]).toString('base64') },
    fromBuffer: { $bin: 'b64', data: Buffer.from([9, 10]).toString('base64') },
  })
})
