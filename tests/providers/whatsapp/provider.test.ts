import { expect, test } from 'bun:test'
import { WhatsAppProvider } from '../../../src/providers/whatsapp/index.ts'

function provider(): WhatsAppProvider {
  return new WhatsAppProvider({
    authDir: './data/test-wa-auth',
    mediaDir: './data/test-media',
  })
}

test('waitUntilReady rechaza cuando vence el tiempo', async () => {
  await expect(provider().waitUntilReady(5)).rejects.toThrow(
    'La conexión no estuvo lista en 5 ms',
  )
})

test('disconnect rechaza una espera pendiente', async () => {
  const adapter = provider()
  const pending = adapter.waitUntilReady(10_000)

  await adapter.disconnect()

  await expect(pending).rejects.toThrow('Se cerró la conexión antes de estar lista')
})

test('send falla claramente si no hay conexión', async () => {
  await expect(
    provider().send(
      { provider: 'whatsapp', externalId: '5491111111111@s.whatsapp.net' },
      { text: 'hola' },
      'message-id',
    ),
  ).rejects.toThrow('WhatsAppProvider sin conectar')
})

test('listConversations falla claramente si no hay conexión', async () => {
  await expect(provider().listConversations()).rejects.toThrow('WhatsAppProvider sin conectar')
})

test('disconnect permite que el proceso termine sin esperar el timeout pendiente', async () => {
  const source = `
    import { WhatsAppProvider } from './src/providers/whatsapp/index.ts'
    const provider = new WhatsAppProvider({ authDir: './unused', mediaDir: './unused' })
    const pending = provider.waitUntilReady(10_000)
    await provider.disconnect()
    await pending.catch(() => {})
  `
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const result = await Promise.race([
    child.exited.then((exitCode) => ({ kind: 'exited' as const, exitCode })),
    Bun.sleep(500).then(() => ({ kind: 'timed-out' as const })),
  ])

  if (result.kind === 'timed-out') child.kill()
  expect(result).toEqual({ kind: 'exited', exitCode: 0 })
})
