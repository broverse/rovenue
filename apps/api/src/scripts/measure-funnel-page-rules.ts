// =============================================================
// measure-funnel-page-rules — report-only blast-radius measurement
// =============================================================
//
// Task 6 added `validatePageFields(pages)` to @rovenue/shared: per-type
// required-field rules for funnel pages (currently just
// single_choice/multi_choice/picture_choice -> "options", the only page
// types the production renderer has no fallback for). Task 8 will run
// that validator at publish time, blocking a republish that fails it.
//
// Before that ships, this script measures how many ALREADY-PUBLISHED
// funnels would newly fail: an owner who republishes an existing funnel
// unchanged would otherwise be blocked with no warning.
//
// Reads every funnel's PUBLISHED pages (funnels.currentVersionId ->
// funnel_versions.pagesJson) — never funnels.draftPagesJson, since
// republishing validates the draft and the question here is about
// funnels that are already live. Writes nothing: no migrations, no
// updates, read-only SELECT + console.log.
//
// Usage:
//   cd apps/api && npx tsx src/scripts/measure-funnel-page-rules.ts
import { eq } from "drizzle-orm";
// `funnels` is named-exported from @rovenue/db but `funnelVersions` is
// NOT — reach both through the `drizzle.schema.*` namespace rather than
// widening the barrel for a one-off script.
import { drizzle, getDb } from "@rovenue/db";
import { pagesArraySchema, validatePageFields } from "@rovenue/shared/funnel";

const { funnels, funnelVersions } = drizzle.schema;

const EXIT_OK = 0;

async function main(): Promise<void> {
  const db = getDb();
  // Published pages do NOT live on `funnels`. `funnels.currentVersionId`
  // points at a `funnel_versions` row and the published pages are that
  // row's `pagesJson`. The draft (`funnels.draftPagesJson`) is not what
  // republishing will validate, so it is deliberately not read here.
  const rows = await db
    .select({
      funnelId: funnels.id,
      projectId: funnels.projectId,
      pagesJson: funnelVersions.pagesJson,
    })
    .from(funnels)
    .innerJoin(funnelVersions, eq(funnels.currentVersionId, funnelVersions.id));

  let failing = 0;
  const byCode = new Map<string, number>();

  for (const funnel of rows) {
    const parsed = pagesArraySchema.safeParse(funnel.pagesJson);
    if (!parsed.success) continue; // already unpublishable; not our rules
    const result = validatePageFields(parsed.data);
    if (result.ok) continue;

    failing += 1;
    for (const issue of result.issues) {
      byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
    }
    console.log(
      `FAIL ${funnel.projectId}/${funnel.funnelId}: ${result.issues.map((i) => i.message).join("; ")}`,
    );
  }

  console.log("---");
  console.log(`published funnels scanned: ${rows.length}`);
  console.log(`would now fail republish:  ${failing}`);
  for (const [code, n] of byCode) console.log(`  ${code}: ${n}`);

  if (rows.length === 0) {
    console.log(
      "\nNo published funnels found in this database. A 0-of-0 result is " +
        "NOT a measurement of blast radius — it says nothing about whether " +
        "any production funnel would fail the new rules. Record this run " +
        "as inconclusive and re-run against an environment that holds " +
        "published funnels before treating the rules as safe to enforce.",
    );
  }

  process.exit(EXIT_OK);
}

void main();
