import { and, eq } from 'drizzle-orm'
import type { ProviderId } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { botMessages } from '../schema.ts'

export interface RecordBotMessageInput {
  provider: ProviderId
  externalId: string
  outboundId: string | null
}

export async function recordBotMessage(db: Db, input: RecordBotMessageInput): Promise<void> {
  await db
    .insert(botMessages)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      outboundId: input.outboundId,
    })
    .onConflictDoNothing({ target: [botMessages.provider, botMessages.externalId] })
}

export async function isBotMessage(
  db: Db,
  provider: ProviderId,
  externalId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: botMessages.id })
    .from(botMessages)
    .where(and(eq(botMessages.provider, provider), eq(botMessages.externalId, externalId)))
    .limit(1)
  return rows.length > 0
}
