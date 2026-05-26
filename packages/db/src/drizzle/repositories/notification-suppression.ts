// =============================================================
// notification_suppression_list repo
// =============================================================
//
// Global "do not email this address" set. Populated by the SES
// feedback consumer (hard bounces + complaints) and by manual
// ops. Pre-send check is a single PK lookup.
//
// Email addresses are always normalised to lowercase before
// insert and lookup so a single key matches every casing variant.

import { eq } from "drizzle-orm";
import type { Db } from "../client";
import type { DbOrTx } from "./projects";
import {
  notificationSuppressionList,
  type NotificationSuppression,
} from "../schema";

export type SuppressionReason = "hard_bounce" | "complaint" | "manual";

export interface AddSuppressionInput {
  email: string;
  reason: SuppressionReason;
  source?: string;
}

export async function isSuppressed(
  db: Db,
  email: string,
): Promise<boolean> {
  const rows = await db
    .select({ email: notificationSuppressionList.email })
    .from(notificationSuppressionList)
    .where(eq(notificationSuppressionList.email, email.toLowerCase()))
    .limit(1);
  return rows.length > 0;
}

export async function add(
  db: DbOrTx,
  input: AddSuppressionInput,
): Promise<void> {
  await db
    .insert(notificationSuppressionList)
    .values({
      email: input.email.toLowerCase(),
      reason: input.reason,
      source: input.source,
    })
    .onConflictDoNothing({ target: notificationSuppressionList.email });
}

export async function get(
  db: Db,
  email: string,
): Promise<NotificationSuppression | null> {
  const rows = await db
    .select()
    .from(notificationSuppressionList)
    .where(eq(notificationSuppressionList.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function remove(db: DbOrTx, email: string): Promise<void> {
  await db
    .delete(notificationSuppressionList)
    .where(eq(notificationSuppressionList.email, email.toLowerCase()));
}
