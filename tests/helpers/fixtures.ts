import type { InboundMessage } from '../../src/domain/types.ts'

/**
 * Mensaje de referencia para los tests. Los campos que importan en cada
 * caso se pasan por `overrides`; el resto queda en valores válidos.
 */
export function mensaje(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    provider: 'fake',
    externalId: 'm1',
    conversation: { externalId: 'c1', kind: 'group', name: 'Grupo Facu' },
    sender: { externalId: 'p1', displayName: 'Ana' },
    sentAt: new Date('2026-08-30T12:00:00Z'),
    fromSelf: false,
    text: 'hola',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    attachments: [],
    raw: { fake: true },
    ...overrides,
  }
}
