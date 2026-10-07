import type { Config } from '../config/index.ts'
import type { Logger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import { FakeProvider } from './fake/index.ts'
import { WhatsAppProvider } from './whatsapp/index.ts'

export function createProvider(
  id: ProviderId,
  config: Config,
  log?: Logger,
): MessagingProvider {
  switch (id) {
    case 'fake':
      return new FakeProvider()
    case 'whatsapp':
      return new WhatsAppProvider({
        authDir: config.WHATSAPP_AUTH_DIR,
        mediaDir: config.MEDIA_DIR,
        phoneNumber: config.WHATSAPP_PHONE_NUMBER,
        log,
      })
    default:
      throw new Error(`Proveedor no implementado: ${id}`)
  }
}
