// =============================================================
// suppression service — integration test (real Postgres)
// =============================================================

import { describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { getDb } from "@rovenue/db";
import {
  checkSuppression,
  isEmailSuppressed,
  suppressEmail,
  unsuppressEmail,
} from "./suppression";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

const db = getDb();
const uniq = () => `${createId()}@example.test`;

describe("suppression service", () => {
  it("round-trips suppressEmail → isEmailSuppressed", async () => {
    const email = uniq();
    expect(await isEmailSuppressed(db, email)).toBe(false);
    await suppressEmail(db, { email, reason: "hard_bounce", source: "ses" });
    expect(await isEmailSuppressed(db, email)).toBe(true);
  });

  it("checkSuppression returns the reason", async () => {
    const email = uniq();
    await suppressEmail(db, { email, reason: "complaint" });
    const r = await checkSuppression(db, email);
    expect(r).toEqual({ suppressed: true, reason: "complaint" });
  });

  it("checkSuppression returns suppressed=false for unknown addresses", async () => {
    const r = await checkSuppression(db, uniq());
    expect(r).toEqual({ suppressed: false });
  });

  it("unsuppressEmail clears the row", async () => {
    const email = uniq();
    await suppressEmail(db, { email, reason: "manual" });
    expect(await isEmailSuppressed(db, email)).toBe(true);
    await unsuppressEmail(db, email);
    expect(await isEmailSuppressed(db, email)).toBe(false);
  });
});
