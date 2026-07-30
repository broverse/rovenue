import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================
// Fresh-install skip-list drift guard
// =============================================================
//
// `runFreshInstall` decides what to do with each journal entry by matching
// its tag against three hard-coded lists (packages/db/src/fresh-install.ts).
// A tag that no longer exists in the journal is silently inert: the entry it
// used to name gets treated as an ordinary migration and EXECUTED. For the
// timescale list that means `CREATE EXTENSION timescaledb` running on an
// image that has none, and a fresh install failing exactly the way it did
// before the runner existed — only now with a misleading skip-list that
// looks correct.
//
// Renaming or renumbering a migration is the realistic way this breaks, and
// nothing else would catch it: every existing database already has these
// entries recorded, so only a from-scratch install ever exercises the lists.

const JOURNAL_PATH = new URL(
  "../drizzle/migrations/meta/_journal.json",
  import.meta.url,
);
const SOURCE_PATH = new URL("../src/fresh-install.ts", import.meta.url);

type JournalEntry = { idx: number; tag: string; when: number };

function journalTags(): Set<string> {
  const raw = readFileSync(JOURNAL_PATH, "utf8");
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return new Set(parsed.entries.map((e) => e.tag));
}

/** Pull the tag literals out of one `const NAME … = new Set([...])` or
 *  `new Map([...])` block. Reading the source rather than importing the
 *  module keeps the lists private to the runner — they are implementation
 *  detail, and exporting them purely to satisfy a test would be the tail
 *  wagging the dog. */
function tagsInConstant(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`);
  expect(start, `${name} not found in fresh-install.ts`).toBeGreaterThan(-1);
  const end = source.indexOf("]);", start);
  expect(end, `${name} block is not terminated`).toBeGreaterThan(start);
  const block = source.slice(start, end);
  // Migration tags only: 4 digits, optional letter suffix, then a name.
  return [...block.matchAll(/"(\d{4}[a-z]?_[a-z0-9_]+)"/g)].map((m) => m[1]!);
}

describe("fresh-install skip lists", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const tags = journalTags();

  it("the journal itself is readable and non-trivial", () => {
    expect(existsSync(JOURNAL_PATH)).toBe(true);
    expect(tags.size).toBeGreaterThan(50);
  });

  it.each([
    ["TIMESCALE_LEGACY_TAGS", 11],
    ["PARTITION_RENAME_TAGS", 3],
    ["LEGACY_HYPERTABLE_DROP_TAGS", 3],
  ])("every tag in %s names a real journal entry", (name, expectedCount) => {
    const listed = tagsInConstant(source, name);
    // Guards the extractor as much as the list: a regex that silently
    // matched nothing would make the membership assertion below vacuous.
    expect(listed).toHaveLength(expectedCount);
    const missing = listed.filter((t) => !tags.has(t));
    expect(missing, `not in _journal.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("no tag is claimed by two different lists", () => {
    const all = [
      ...tagsInConstant(source, "TIMESCALE_LEGACY_TAGS"),
      ...tagsInConstant(source, "PARTITION_RENAME_TAGS"),
      ...tagsInConstant(source, "LEGACY_HYPERTABLE_DROP_TAGS"),
    ];
    expect(all).toHaveLength(new Set(all).size);
  });
});
