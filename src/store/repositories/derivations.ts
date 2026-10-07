import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { attachmentDerivations } from '../schema.ts'

export type DerivationKind = 'transcript' | 'description'

export async function getDerivation(
  db: Db,
  attachmentId: string,
  kind: DerivationKind,
  model: string,
): Promise<string | null> {
  const rows = await db
    .select({ text: attachmentDerivations.text })
    .from(attachmentDerivations)
    .where(
      and(
        eq(attachmentDerivations.attachmentId, attachmentId),
        eq(attachmentDerivations.kind, kind),
        eq(attachmentDerivations.model, model),
      ),
    )
    .limit(1)

  return rows[0]?.text ?? null
}

/**
 * Loads cached derivation texts for many attachments under one model.
 * One entry per attachment id (audio → transcript, image → description).
 */
export type DerivationModels = {
  transcript: string
  description: string
}

export async function listDerivationsByAttachmentIds(
  db: Db,
  attachmentIds: string[],
  models: DerivationModels,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (attachmentIds.length === 0) return result

  const rows = await db
    .select({
      attachmentId: attachmentDerivations.attachmentId,
      text: attachmentDerivations.text,
    })
    .from(attachmentDerivations)
    .where(
      and(
        inArray(attachmentDerivations.attachmentId, attachmentIds),
        inArray(attachmentDerivations.model, [models.transcript, models.description]),
      ),
    )

  for (const row of rows) {
    result.set(row.attachmentId, row.text)
  }
  return result
}

export async function upsertDerivation(
  db: Db,
  input: {
    attachmentId: string
    kind: DerivationKind
    model: string
    text: string
  },
): Promise<void> {
  await db
    .insert(attachmentDerivations)
    .values({
      attachmentId: input.attachmentId,
      kind: input.kind,
      model: input.model,
      text: input.text,
    })
    .onConflictDoUpdate({
      target: [
        attachmentDerivations.attachmentId,
        attachmentDerivations.kind,
        attachmentDerivations.model,
      ],
      set: { text: input.text },
    })
}
