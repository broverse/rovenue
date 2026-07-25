// =============================================================
// Migration 0095 — coerce stored numeric clause operands.
// Real Postgres. The test EXECUTES THE MIGRATION FILE ITSELF so the
// assertion and the shipped SQL cannot drift apart.
// =============================================================

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, funnels, funnelVersions } from "../schema";
import { pagesArraySchema } from "@rovenue/shared/funnel";

const RUN_ID = Date.now();
const db = getDb();

const MIGRATION = readFileSync(
  join(__dirname, "../../../drizzle/migrations/0095_coerce_funnel_numeric_operands.sql"),
  "utf8",
);

/** One page carrying four clauses, each a distinct case the migration must handle. */
function pagesFixture() {
  return [
    {
      id: "pg_1",
      type: "number_input",
      question_id: "q_num",
      next_rules: [
        {
          id: "r_1",
          condition: {
            op: "all",
            clauses: [
              // 1. the regression case: numeric operand stored as a string
              { question_id: "q_num", op: "gt", value: "5" },
              // 2. between with string bounds
              { question_id: "q_num", op: "between", value: ["1", "10"] },
              // 3. NOT coercible — must be left exactly as-is, never dropped
              { question_id: "q_num", op: "lt", value: "abc" },
              // 4. already correct — must come back byte-identical
              { question_id: "q_num", op: "gte", value: 3 },
            ],
          },
          goto: "pg_2",
        },
      ],
    },
    // pageSchema.title is z.string().optional() (not a localized object) —
    // a plain string here, unlike the {en: ...} shape used for e.g.
    // multi_choice options, keeps this page independently valid so the
    // fixture's only invalid clause is the "abc" one under test.
    { id: "pg_2", type: "info", title: "Done" },
  ];
}

let projectId: string;
let funnelId: string;

beforeAll(async () => {
  const [project] = await db.insert(projects).values({ name: `sp7-${RUN_ID}` }).returning();
  projectId = project!.id;

  const [funnel] = await db
    .insert(funnels)
    .values({
      projectId,
      slug: `sp7-${RUN_ID}`,
      name: "SP7 operand coercion",
      draftPagesJson: pagesFixture(),
    })
    .returning();
  funnelId = funnel!.id;

  await db.insert(funnelVersions).values({
    funnelId,
    versionNo: 1,
    pagesJson: pagesFixture(),
    themeJson: {},
    settingsJson: {},
  });
});

afterAll(async () => {
  await db.delete(funnelVersions).where(eq(funnelVersions.funnelId, funnelId));
  await db.delete(funnels).where(eq(funnels.id, funnelId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

function clausesOf(pages: unknown) {
  const page = (pages as Array<Record<string, never>>)[0]!;
  return (page as never as { next_rules: Array<{ condition: { clauses: Array<{ op: string; value: unknown }> } }> })
    .next_rules[0]!.condition.clauses;
}

describe("migration 0095 — numeric operand coercion", () => {
  it("the pre-migration draft FAILS pagesArraySchema — the reason this migration exists", async () => {
    const [row] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    expect(pagesArraySchema.safeParse(row!.draftPagesJson).success).toBe(false);
  });

  it("coerces numeric strings, leaves non-numeric alone, and makes the draft publishable", async () => {
    await db.execute(sql.raw(MIGRATION));

    const [row] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    const clauses = clausesOf(row!.draftPagesJson);

    expect(clauses[0]!.value, "gt string was not coerced").toBe(5);
    expect(clauses[1]!.value, "between bounds were not coerced").toEqual([1, 10]);
    // Guessing at intent is worse than leaving it: untouched, and NOT dropped.
    expect(clauses[2]!.value, "non-numeric operand must be left as-is").toBe("abc");
    expect(clauses[3]!.value, "already-numeric operand must be untouched").toBe(3);
    expect(clauses, "a clause was dropped").toHaveLength(4);

    // The whole point of the item: publish is unblocked for the coercible part.
    // Clause 3 is still invalid, which is correct — nobody can know what "abc" meant.
    const stillInvalid = pagesArraySchema.safeParse(row!.draftPagesJson);
    expect(stillInvalid.success).toBe(false);

    // Remove only the un-guessable clause; now it must parse.
    const repaired = structuredClone(row!.draftPagesJson) as never as ReturnType<typeof pagesFixture>;
    const rules = (repaired[0] as never as { next_rules: Array<{ condition: { clauses: unknown[] } }> }).next_rules;
    rules[0]!.condition.clauses.splice(2, 1);
    expect(pagesArraySchema.safeParse(repaired).success, "coerced clauses still fail").toBe(true);
  });

  it("also coerces the PUBLISHED store, not just the draft", async () => {
    const [ver] = await db
      .select()
      .from(funnelVersions)
      .where(eq(funnelVersions.funnelId, funnelId));
    const clauses = clausesOf(ver!.pagesJson);
    expect(clauses[0]!.value).toBe(5);
    expect(clauses[1]!.value).toEqual([1, 10]);
  });

  it("is idempotent — running it twice changes nothing", async () => {
    const [before] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    await db.execute(sql.raw(MIGRATION));
    const [after] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    expect(after!.draftPagesJson).toEqual(before!.draftPagesJson);
  });
});
