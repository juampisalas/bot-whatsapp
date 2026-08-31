import { and, eq } from 'drizzle-orm'
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
