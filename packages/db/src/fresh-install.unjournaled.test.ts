import { unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { findUnjournaledMigrations } from "./fresh-install";

// A migration file the journal does not list is invisible to BOTH runners:
// the fresh one iterates the journal, and drizzle's migrator reads the same
// file. The file sits in the migrations directory looking applied-by-
// inspection while the schema change never lands, and the first symptom is a
// column that does not exist.
//
// This is not hypothetical. Migration 0122 was written, committed, and
// silently never applied during the Web SDK work; it surfaced only when a
// test harness rebuilt a database from the journal and the seed failed on the
// missing column. Every green test until then had run against a database
// patched by hand.

const PROBE = new URL(
  "../drizzle/migrations/9999_unjournaled_probe.sql",
  import.meta.url,
);

afterEach(async () => {
  await unlink(PROBE).catch(() => undefined);
});

describe("findUnjournaledMigrations", () => {
  it("reports nothing when every file is journaled", async () => {
    // The repository's own state is the fixture here: if this fails, a real
    // migration is currently unreachable and the build should say so.
    await expect(findUnjournaledMigrations()).resolves.toEqual([]);
  });

  it("names a file that is missing from the journal", async () => {
    await writeFile(PROBE, "SELECT 1;\n", "utf8");
    await expect(findUnjournaledMigrations()).resolves.toEqual([
      "9999_unjournaled_probe",
    ]);
  });

  it("ignores non-SQL files in the migrations directory", async () => {
    // meta/ and any stray notes must not be reported as missing migrations.
    const files = await findUnjournaledMigrations();
    expect(files.every((f) => !f.includes("."))).toBe(true);
  });
});
