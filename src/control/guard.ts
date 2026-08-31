import type { ConversationRef, ProviderId } from '../domain/types.ts'

export class ControlTargetError extends Error {
  constructor(target: ConversationRef) {
    super(`destination outside control: ${target.provider}:${target.externalId}`)
    this.name = 'ControlTargetError'
  }
}

export function isControlTarget(
  config: { CONTROL_PROVIDER: ProviderId; CONTROL_CONVERSATION_ID?: string },
  target: ConversationRef,
): boolean {
  return (
    config.CONTROL_CONVERSATION_ID !== undefined &&
    config.CONTROL_CONVERSATION_ID.length > 0 &&
    target.provider === config.CONTROL_PROVIDER &&
    target.externalId === config.CONTROL_CONVERSATION_ID
  )
}

export function assertControlTarget(
  config: { CONTROL_PROVIDER: ProviderId; CONTROL_CONVERSATION_ID?: string },
  target: ConversationRef,
): void {
  if (!isControlTarget(config, target)) throw new ControlTargetError(target)
}
