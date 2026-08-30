import { test, expect } from 'bun:test'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import type { InboundMessage } from '../../src/domain/types.ts'
import { mensaje } from '../helpers/fixtures.ts'

test('entrega los mensajes inyectados al manejador', async () => {
  const provider = new FakeProvider()
  const recibidos: InboundMessage[] = []
  provider.onMessage(async (m) => {
    recibidos.push(m)
  })
  await provider.connect()
  await provider.inject(mensaje())

  expect(recibidos).toHaveLength(1)
  expect(recibidos[0]?.text).toBe('hola')
})

test('registra los mensajes enviados con su clave de idempotencia', async () => {
  const provider = new FakeProvider()
  await provider.connect()
  const enviado = await provider.send(
    { provider: 'fake', externalId: 'c1' },
    { text: 'respuesta' },
    'clave-1',
  )

  expect(enviado.externalId).toBe('clave-1')
  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.content.text).toBe('respuesta')
})

test('puede simular un fallo de envío una sola vez', async () => {
  const provider = new FakeProvider()
  await provider.connect()
  provider.failNextSend(new Error('socket caído'))

  await expect(
    provider.send({ provider: 'fake', externalId: 'c1' }, { text: 'x' }, 'k1'),
  ).rejects.toThrow('socket caído')

  const enviado = await provider.send({ provider: 'fake', externalId: 'c1' }, { text: 'x' }, 'k1')
  expect(enviado.externalId).toBe('k1')
})

test('rechaza inyectar antes de conectar', async () => {
  const provider = new FakeProvider()
  await expect(provider.inject(mensaje())).rejects.toThrow(/sin conectar/)
})

test('waitUntilReady resuelve una vez conectado y falla si no', async () => {
  const provider = new FakeProvider()
  await expect(provider.waitUntilReady()).rejects.toThrow(/sin conectar/)
  await provider.connect()
  await expect(provider.waitUntilReady()).resolves.toBeUndefined()
})
