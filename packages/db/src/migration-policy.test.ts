import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @rovenue/db is "type": "module", so __dirname does not exist here.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "drizzle", "migrations");

/**
 * Destructive DDL breaks the old image mid-rollout: `pre-upgrade`
 * migrations run before the new pods, so during a rolling update the
 * OLD code is serving against the NEW schema. See CONTRIBUTING.md
 * "Expand/contract schema changes".
 */
const DESTRUCTIVE_DDL = /\bDROP\s+COLUMN\b|\bDROP\s+TABLE\b|\bRENAME\s+COLUMN\b|\bSET\s+NOT\s+NULL\b/i;

/** Opt-out marker an author writes when the drop IS the contract step. */
const CONTRACT_MARKER = "-- rovenue:contract-phase";

/**
 * Migrations that predate the policy. This list is FROZEN — never add to
 * it. A new migration needing destructive DDL carries CONTRACT_MARKER
 * instead, which is a reviewable decision rather than a silent append.
 *
 * Enforced below, not just asserted here: GRANDFATHERED_COUNT pins the
 * size so an append shows up as a loud, reviewer-visible diff instead of
 * a one-line addition, and the "list stays honest" test below checks
 * every entry still exists and still matches DESTRUCTIVE_DDL.
 */
const GRANDFATHERED = new Set<string>([
  "0012_drop_exposure_events.sql",
  "0015a_drop_revenue_events_legacy.sql",
  "0016a_drop_credit_ledger_legacy.sql",
  "0017a_drop_outgoing_webhooks_legacy.sql",
  "0030_drop_projects_slug.sql",
  "0051_funnel_partitions.sql",
  "0055_subscriber_access_accessid.sql",
  "0056_products_accessids.sql",
  "0069_damp_kingpin.sql",
  "0074_offerings_decouple_packages.sql",
  "0087_drop_stripe_credentials.sql",
  "0098_font_face_content_hash.sql",
]);

/** The frozen size of GRANDFATHERED. See the comment on GRANDFATHERED. */
const GRANDFATHERED_COUNT = 12;

describe("migration policy", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  it("finds migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("GRANDFATHERED is frozen at its original size", () => {
    expect(
      GRANDFATHERED.size,
      `GRANDFATHERED has ${GRANDFATHERED.size} entries but is frozen at ` +
        `${GRANDFATHERED_COUNT}. A new migration needing destructive DDL ` +
        `takes the ${CONTRACT_MARKER} marker instead of an allowlist entry. ` +
        `Bumping GRANDFATHERED_COUNT is only correct if a grandfathered ` +
        `migration file was deleted from the repo.`,
    ).toBe(GRANDFATHERED_COUNT);
  });

  it.each(Array.from(GRANDFATHERED))("GRANDFATHERED entry %s is still real and still destructive", (file) => {
    expect(files.includes(file), `${file} is in GRANDFATHERED but no longer exists in ${MIGRATIONS_DIR}.`).toBe(
      true,
    );
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    expect(
      DESTRUCTIVE_DDL.test(sql),
      `${file} is in GRANDFATHERED but no longer matches DESTRUCTIVE_DDL. It is stale ` +
        `and should be removed from the list, or it was added to silence something ` +
        `the policy should have caught.`,
    ).toBe(true);
  });

  it.each(files)("%s has no unmarked destructive DDL", (file) => {
    if (GRANDFATHERED.has(file)) return;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (!DESTRUCTIVE_DDL.test(sql)) return;
    expect(
      sql.includes(CONTRACT_MARKER),
      `${file} contains destructive DDL. Schema changes are expand/contract ` +
        `(see .github/CONTRIBUTING.md). If this migration IS the contract ` +
        `step and no running version reads the dropped shape, add:\n` +
        `  ${CONTRACT_MARKER} <reason>`,
    ).toBe(true);
  });
});
