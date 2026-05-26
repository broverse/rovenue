import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnelAnswers, type FunnelAnswer, type NewFunnelAnswer } from "../schema";

/**
 * Upsert a funnel answer keyed by (session_id, question_id).
 *
 * Dedup is enforced at the repository layer (UPDATE-then-INSERT inside a
 * transaction) rather than via `ON CONFLICT ... DO UPDATE` because the
 * underlying `funnel_answers` table is range-partitioned on `answered_at`,
 * and Postgres forbids UNIQUE constraints that omit the partition key.
 * The 0045 partition migration demoted the original UNIQUE on
 * (session_id, question_id) to a plain index for that reason.
 *
 * Race-condition trade-off: without a UNIQUE constraint, two simultaneous
 * upserts for the same (session, question) tuple could both miss the
 * UPDATE branch and both INSERT, producing duplicate rows. For the funnel
 * use-case (single anonymous browser, single tab, sequential page flow)
 * this is extremely unlikely. If stronger guarantees are ever required,
 * the call site can take a row-level advisory lock or we can add a CHECK-
 * style guard at a later phase.
 */
export async function upsert(
  db: Db,
  row: NewFunnelAnswer,
): Promise<FunnelAnswer> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(funnelAnswers)
      .set({
        answerJson: row.answerJson,
        pageId: row.pageId,
        answeredAt: new Date(),
      })
      .where(
        and(
          eq(funnelAnswers.sessionId, row.sessionId),
          eq(funnelAnswers.questionId, row.questionId),
        ),
      )
      .returning();
    if (updated.length > 0) return updated[0];
    const [inserted] = await tx.insert(funnelAnswers).values(row).returning();
    return inserted;
  });
}

export async function listBySession(
  db: Db,
  sessionId: string,
): Promise<FunnelAnswer[]> {
  return db.select().from(funnelAnswers).where(eq(funnelAnswers.sessionId, sessionId));
}
