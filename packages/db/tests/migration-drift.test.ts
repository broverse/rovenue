import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMigrationDrift, type MigrationClient } from "../src/fresh-install";

// =============================================================
// Template-staleness detector
// =============================================================
//
// `findMigrationDrift` is what stops `apps/api/tests/global-setup.ts` from
// cloning a template database that predates the migration chain. Measured on
// 2026-09-06, a developer template held 130 of the journal's 131 entries and
// silently turned a red suite green — so this function is now the only thing
// standing between that class of false green and every integration suite in
// apps/api.
//
// A guard is worth exactly as much as the proof that it fires, so each
// branch below is asserted in BOTH directions: the stale shape must be
// flagged and the in-sync shape must be quiet. The journal and the migration
// files are the real ones on disk; only the database side is a stub, because
// the whole point is to drive catalog states (no bookkeeping, no marker,
// wrong count) that a live database cannot be put into without destroying
// something.

const JOURNAL_PATH = new URL(
  "../drizzle/migrations/meta/_journal.json",
  import.meta.url,
);
const MIGRATIONS_DIR = new URL("../drizzle/migrations/", import.meta.url);

type JournalEntry = { idx: number; tag: string; when: number };

function journalEntries(): JournalEntry[] {
  const parsed = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return [...parsed.entries].sort((a, b) => a.idx - b.idx);
}

/** The same digest the two runners record: sha256 over the raw .sql file. */
function hashOf(tag: string): string {
  const sql = readFileSync(new URL(`${tag}.sql`, MIGRATIONS_DIR), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

const BOOKKEEPING_TABLE = "__drizzle_migrations";
const MARKER_TABLE = "__rovenue_install";
const EXISTENCE_PROBE = "to_regclass";
const FRESH_MODE = "fresh";
const UPGRADE_MODE = "upgrade";
/** A digest that belongs to no migration file, used to stand in for a
 *  migration edited after it was applied. */
const FOREIGN_HASH = createHash("sha256").update("not-a-migration").digest("hex");

type StubState = {
  /** `undefined` = the bookkeeping table does not exist. */
  hashes?: string[];
  /** `undefined` = the install-marker table does not exist. */
  markerMode?: string;
};

/** Minimal `pg` stand-in: answers only the four statements the detector
 *  issues, and throws on anything else so a query added later cannot pass
 *  unnoticed. */
function stubClient(state: StubState): MigrationClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (async (text: string): Promise<any> => {
      if (text.includes(EXISTENCE_PROBE) && text.includes(BOOKKEEPING_TABLE)) {
        return { rows: [{ present: state.hashes !== undefined }], rowCount: 1 };
      }
      if (text.includes(EXISTENCE_PROBE) && text.includes(MARKER_TABLE)) {
        return {
          rows: [{ present: state.markerMode !== undefined }],
          rowCount: 1,
        };
      }
      if (text.includes(MARKER_TABLE)) {
        return { rows: [{ mode: state.markerMode }], rowCount: 1 };
      }
      if (text.includes("count(*)")) {
        const count = String(state.hashes?.length ?? 0);
        return { rows: [{ count }], rowCount: 1 };
      }
      if (text.includes("SELECT hash")) {
        const rows = (state.hashes ?? []).map((hash) => ({ hash }));
        return { rows, rowCount: rows.length };
      }
      throw new Error(`stub client got an unexpected query: ${text}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
}

describe("findMigrationDrift", () => {
  const entries = journalEntries();
  const allHashes = entries.map((e) => hashOf(e.tag));

  it("the journal on disk is readable and non-trivial", () => {
    expect(entries.length).toBeGreaterThan(50);
    expect(allHashes.length).toBe(entries.length);
  });

  it("is quiet when a fresh-install database holds the whole journal", async () => {
    const drift = await findMigrationDrift(
      stubClient({ hashes: allHashes, markerMode: FRESH_MODE }),
    );
    expect(drift.isStale).toBe(false);
    expect(drift.appliedRows).toBe(entries.length);
    expect(drift.journalEntries).toBe(entries.length);
    expect(drift.missingTags).toEqual([]);
  });

  it("names the missing tag when a fresh-install database lags by one", async () => {
    const newest = entries[entries.length - 1]!;
    const drift = await findMigrationDrift(
      stubClient({ hashes: allHashes.slice(0, -1), markerMode: FRESH_MODE }),
    );
    expect(drift.isStale).toBe(true);
    expect(drift.appliedRows).toBe(entries.length - 1);
    expect(drift.missingTags).toEqual([newest.tag]);
  });

  it("catches an edited-in-place migration on a fresh-install database", async () => {
    // Same row COUNT, one row whose digest no longer matches its file — the
    // case the count signal alone cannot see.
    const edited = entries[0]!;
    const hashes = [FOREIGN_HASH, ...allHashes.slice(1)];
    const drift = await findMigrationDrift(
      stubClient({ hashes, markerMode: FRESH_MODE }),
    );
    expect(drift.appliedRows).toBe(entries.length);
    expect(drift.missingTags).toEqual([edited.tag]);
    expect(drift.isStale).toBe(true);
  });

  it.each([
    ["no marker table at all", undefined],
    ["a marker that says upgrade", UPGRADE_MODE],
  ])(
    "falls back to the count signal with %s",
    async (_label, markerMode) => {
      // Upgrade-path databases legitimately carry digests that differ from
      // disk (0070, 0081, 0093 and 0099 were edited after they were
      // applied), so hashes must NOT be consulted: right count, wrong
      // digests, still quiet.
      const wrongDigests = allHashes.map(() => FOREIGN_HASH);
      const inSync = await findMigrationDrift(
        stubClient({ hashes: wrongDigests, markerMode }),
      );
      expect(inSync.missingTags).toEqual([]);
      expect(inSync.isStale).toBe(false);

      // …and the count alone still catches a lagging one.
      const lagging = await findMigrationDrift(
        stubClient({ hashes: wrongDigests.slice(0, -1), markerMode }),
      );
      expect(lagging.appliedRows).toBe(entries.length - 1);
      expect(lagging.isStale).toBe(true);
    },
  );

  it("treats a database with no bookkeeping as maximally stale", async () => {
    const drift = await findMigrationDrift(stubClient({}));
    expect(drift.isStale).toBe(true);
    expect(drift.appliedRows).toBe(0);
    expect(drift.missingTags).toEqual(entries.map((e) => e.tag));
  });

  it("reports migration files the journal does not list", async () => {
    // Not a stub-able condition: this reads the migrations directory
    // directly. On a healthy tree it is empty, and that emptiness is the
    // assertion — a file added without a journal entry is applied by no
    // runner, so rebuilding the template would not fix it.
    const drift = await findMigrationDrift(
      stubClient({ hashes: allHashes, markerMode: FRESH_MODE }),
    );
    expect(drift.unjournaledTags).toEqual([]);
  });
});
