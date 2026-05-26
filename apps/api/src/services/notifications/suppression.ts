// =============================================================
// Suppression pre-send service
// =============================================================
//
// Thin wrapper around the notification_suppression_list repo so
// callers in the notifier worker / send-email worker depend on a
// stable service module (and so this surface can grow — e.g. add
// metric increments — without touching every caller).
//
// All addresses are normalised to lowercase before lookup.

import { drizzle, type Db } from "@rovenue/db";

export interface SuppressionCheckResult {
  suppressed: boolean;
  reason?: "hard_bounce" | "complaint" | "manual";
}

export async function isEmailSuppressed(
  db: Db,
  email: string,
): Promise<boolean> {
  return drizzle.notificationSuppressionRepo.isSuppressed(db, email);
}

export async function checkSuppression(
  db: Db,
  email: string,
): Promise<SuppressionCheckResult> {
  const row = await drizzle.notificationSuppressionRepo.get(db, email);
  if (!row) return { suppressed: false };
  return { suppressed: true, reason: row.reason };
}

export async function suppressEmail(
  db: Db,
  input: {
    email: string;
    reason: "hard_bounce" | "complaint" | "manual";
    source?: string;
  },
): Promise<void> {
  await drizzle.notificationSuppressionRepo.add(db, input);
}

export async function unsuppressEmail(db: Db, email: string): Promise<void> {
  await drizzle.notificationSuppressionRepo.remove(db, email);
}
