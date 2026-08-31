import type { CaptureMode } from '../domain/types.ts'

export interface CapturePolicy {
  mode: CaptureMode
  rules: ReadonlySet<string>
}

export function shouldCapture(policy: CapturePolicy, conversationExternalId: string): boolean {
  switch (policy.mode) {
    case 'all':
      return true
    case 'whitelist':
      return policy.rules.has(conversationExternalId)
    case 'blacklist':
      return !policy.rules.has(conversationExternalId)
  }
}
