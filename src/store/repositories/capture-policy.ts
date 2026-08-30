import { eq } from 'drizzle-orm'
import type { CapturePolicy } from '../../capture/policy.ts'
import type { ProviderId } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { capturePolicy, captureRules } from '../schema.ts'

export async function loadCapturePolicy(db: Db, provider: ProviderId): Promise<CapturePolicy> {
  const rows = await db.select({ mode: capturePolicy.mode }).from(capturePolicy).limit(1)
  const mode = rows[0]?.mode ?? 'all'

  const rules = await db
    .select({ conversationExternalId: captureRules.conversationExternalId })
    .from(captureRules)
    .where(eq(captureRules.provider, provider))

  return {
    mode,
    rules: new Set(rules.map((rule) => rule.conversationExternalId)),
  }
}
