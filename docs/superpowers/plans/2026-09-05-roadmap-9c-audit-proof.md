# §9.3 Externally verifiable audit proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an auditor verify Rovenue's per-project audit hash chain offline,
without trusting Rovenue's API or code, by exporting a self-contained proof
bundle and recomputing every hash with a standalone verifier.

**Architecture:** The chain already does the hard part correctly — a per-project
SHA-256 chain over a canonical JSON encoding with sorted keys. This plan extracts
that encoder into `@rovenue/shared` unchanged, adds an export endpoint that emits
exactly the fields the hash covers, and ships a dependency-free verifier that
imports nothing from `apps/api`.

**Tech Stack:** TypeScript, `node:crypto`, Hono, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-roadmap-9-gdpr-kvkk-design.md`
(Sub-project 9.3)

## Global Constraints

- TDD: a failing test precedes every behaviour change.
- No magic values. The format version is a named exported constant.
- **The extraction must not change a single output byte.** `lib/audit.ts` writes a
  compliance chain; a subtle encoding difference would invalidate every hash
  written afterwards while all existing tests stayed green. Task 1's byte-equality
  test is what makes the refactor safe — it is the deliverable, not a formality.
- The verifier must NOT import from `apps/api`. An auditor running it is
  explicitly not trusting the API.
- Postgres access through Drizzle repositories only; raw `sql` with qualified
  columns.
- Verify every column and field name against the producing code before trusting a
  fixture. §12 shipped three defects of exactly this kind.
- Throttled runs: `nice -n 19 npx vitest run <paths> --maxWorkers=2`, from inside
  the app or package directory, never the repo root.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/audit-chain.ts` | The canonical encoder, the format version, and the row-hash function. Verification lives in the standalone script, not here — an auditor should not have to install this package to check a bundle. |
| `packages/shared/package.json` | An `./audit-chain` export entry, matching the existing `./crypto` pattern |
| `apps/api/src/lib/audit.ts` | Imports the encoder instead of defining it |
| `packages/db/src/drizzle/repositories/audit-logs.ts` | A read returning the exact hashed fields, ordered for chain walking |
| `apps/api/src/routes/dashboard/audit-logs.ts` | The proof export endpoint |
| `scripts/verify-audit-bundle.ts` | The standalone offline verifier |

---

### Task 1: Extract the canonical encoder without changing its output

**Files:**
- Create: `packages/shared/src/audit-chain.ts`
- Create: `packages/shared/src/audit-chain.test.ts`
- Modify: `packages/shared/package.json` (add the `./audit-chain` export)
- Modify: `packages/shared/src/index.ts` (re-export)
- Modify: `apps/api/src/lib/audit.ts` (import instead of define)

**Interfaces:**
- Produces: `export const AUDIT_CHAIN_FORMAT_V1 = "rovenue.audit-chain.v1"`.
- Produces: `export interface AuditChainPayload { projectId: string; userId: string | null; action: string; resource: string; resourceId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; ipAddress: string | null; userAgent: string | null; createdAt: string; prevHash: string | null }` — the EXACT shape currently built by `buildCanonicalPayload` in `apps/api/src/lib/audit.ts`, field for field and in that order.
- Produces: `export function canonicalJSON(value: unknown): string`.
- Produces: `export function hashAuditRow(payload: AuditChainPayload): string` — canonicalises then SHA-256 hex digests.

**Background the implementer needs:**

Read `apps/api/src/lib/audit.ts` first. The functions to move are `canonicalJSON`
(around line 265) and `hashRow` (around line 279), plus the `CanonicalPayload`
interface (around line 282) and `buildCanonicalPayload` (around line 297).
`createdAt` is already stringified with `.toISOString()` by the caller — keep that
boundary exactly where it is; the encoder receives a string, never a Date.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/audit-chain.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  AUDIT_CHAIN_FORMAT_V1,
  canonicalJSON,
  hashAuditRow,
  type AuditChainPayload,
} from "./audit-chain";

// A local copy of the ORIGINAL implementation, kept verbatim from
// apps/api/src/lib/audit.ts as it stood before extraction. This exists
// so the test compares the new encoder against the real previous
// behaviour rather than against itself.
function originalCanonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(originalCanonicalJSON).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${originalCanonicalJSON(obj[k])}`)
    .join(",")}}`;
}

const SAMPLES: unknown[] = [
  null,
  undefined,
  0,
  -0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "quotes \" and \\ backslashes",
  "unicode ✓ ü",
  true,
  [],
  [1, "two", null, { b: 1, a: 2 }],
  { z: 1, a: 2, m: 3 },
  { nested: { deep: { deeper: [1, { k: null }] } } },
  { "key with spaces": 1, "": 2 },
];

describe("canonicalJSON", () => {
  test.each(SAMPLES.map((s, i) => [i, s]))(
    "sample %i encodes byte-identically to the original implementation",
    (_i, sample) => {
      expect(canonicalJSON(sample)).toBe(originalCanonicalJSON(sample));
    },
  );

  test("object key order does not affect the encoding", () => {
    // The whole chain rests on this: two engines building the same
    // object in different orders must hash identically.
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
  });
});

describe("hashAuditRow", () => {
  const payload: AuditChainPayload = {
    projectId: "prj_1",
    userId: "usr_1",
    action: "update",
    resource: "product",
    resourceId: "prd_1",
    before: { price: 1 },
    after: { price: 2 },
    ipAddress: "1.2.3.4",
    userAgent: "test",
    createdAt: "2026-09-05T00:00:00.000Z",
    prevHash: null,
  };

  test("is the sha256 hex digest of the canonical form", () => {
    const expected = createHash("sha256")
      .update(originalCanonicalJSON(payload))
      .digest("hex");
    expect(hashAuditRow(payload)).toBe(expected);
  });

  test("changing any single field changes the hash", () => {
    const base = hashAuditRow(payload);
    const mutations: Array<Partial<AuditChainPayload>> = [
      { projectId: "prj_2" },
      { userId: null },
      { action: "delete" },
      { resource: "offering" },
      { resourceId: "prd_2" },
      { before: { price: 99 } },
      { after: null },
      { ipAddress: null },
      { userAgent: "other" },
      { createdAt: "2026-09-05T00:00:01.000Z" },
      { prevHash: "abc" },
    ];
    for (const m of mutations) {
      expect(hashAuditRow({ ...payload, ...m })).not.toBe(base);
    }
  });
});

describe("AUDIT_CHAIN_FORMAT_V1", () => {
  test("is a stable identifier", () => {
    // Written into every bundle. Changing it silently would make old
    // bundles unverifiable, so pin the literal.
    expect(AUDIT_CHAIN_FORMAT_V1).toBe("rovenue.audit-chain.v1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/shared && nice -n 19 npx vitest run src/audit-chain.test.ts --maxWorkers=2
```

Expected: FAIL — module `./audit-chain` not found.

- [ ] **Step 3: Create the shared module**

Create `packages/shared/src/audit-chain.ts`. Move `canonicalJSON` and the hash
function VERBATIM from `apps/api/src/lib/audit.ts` — do not "improve" them:

```ts
import { createHash } from "node:crypto";

// =============================================================
// Audit chain canonical form
// =============================================================
//
// The per-project audit hash chain (apps/api/src/lib/audit.ts) hashes
// each row over this canonical encoding. It lives here, rather than in
// the API, so an external verifier can recompute a hash without
// importing anything from the server it is auditing.
//
// `JSON.stringify` does not guarantee key order across engines. A
// compliance-grade chain must be byte-identical on re-hash, so keys are
// emitted in sorted order and arrays/objects are recursed explicitly.

/** Identifies which canonical encoding a proof bundle's hashes used.
 *  Written into every bundle; a verifier refuses a version it does not
 *  implement rather than guessing. */
export const AUDIT_CHAIN_FORMAT_V1 = "rovenue.audit-chain.v1";

/** Exactly the fields the row hash covers, in the order audit.ts builds
 *  them. Adding or reordering a field changes every subsequent hash. */
export interface AuditChainPayload {
  projectId: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** ISO-8601. Stringified by the caller — this module never sees a Date. */
  createdAt: string;
  prevHash: string | null;
}

export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
    .join(",")}}`;
}

export function hashAuditRow(payload: AuditChainPayload): string {
  return createHash("sha256").update(canonicalJSON(payload)).digest("hex");
}
```

- [ ] **Step 4: Add the package export**

In `packages/shared/package.json`, add an `./audit-chain` entry to `exports`,
copying the shape of the existing `./crypto` entry exactly:

```json
    "./audit-chain": {
      "types": "./src/audit-chain.ts",
      "default": "./src/audit-chain.ts"
    },
```

Also re-export from `packages/shared/src/index.ts` alongside the other modules.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd packages/shared && nice -n 19 npx vitest run src/audit-chain.test.ts --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 6: Rewire audit.ts to import**

In `apps/api/src/lib/audit.ts`: delete the local `canonicalJSON`, `hashRow` and
`CanonicalPayload`, and import from `@rovenue/shared/audit-chain` instead. Keep
`buildCanonicalPayload` where it is — it maps an `AuditEntry` to the payload and
is API-side glue — but have it return `AuditChainPayload`, and replace the
`hashRow(canonicalJSON(...))` call with `hashAuditRow(...)`.

- [ ] **Step 7: Prove the writer still produces the same hashes**

`apps/api/src/lib/audit.ts` has a `__testing` export, and
`apps/api/tests/audit-chain.test.ts` reaches `canonicalJSON` through it (see its
`canonicalJSON` describe block). Keep `__testing` exposing `canonicalJSON` — now
re-exporting the imported function rather than a local one. That is expected
plumbing, not a behaviour change.

Run all four existing audit suites:

```bash
cd apps/api && nice -n 19 npx vitest run \
  tests/audit-chain.test.ts tests/audit-log.test.ts \
  tests/audit-tx-rollback.test.ts tests/audit-integrations.test.ts \
  --maxWorkers=2
```

Then from the repo root:

```bash
nice -n 19 npx tsc --noEmit -p apps/api
nice -n 19 npx tsc --noEmit -p packages/shared
```

The bar: every existing audit test passes with its ASSERTIONS unmodified.
Re-pointing the `__testing` export is allowed; changing what any test asserts is
not. If an assertion has to change to make a suite pass, STOP and report it —
that means the extraction altered behaviour, which is the one thing this task
must not do.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/audit-chain.ts packages/shared/src/audit-chain.test.ts \
        packages/shared/package.json packages/shared/src/index.ts apps/api/src/lib/audit.ts
git commit -m "refactor(audit): move the canonical encoder into @rovenue/shared

An external verifier must be able to recompute a row hash without
importing from the server it is auditing. Byte-equality against the
previous implementation is pinned by test, because a subtle encoding
change would invalidate every hash written afterwards while leaving the
existing suites green."
```

---

### Task 2: A repository read that returns exactly the hashed fields

**Files:**
- Modify: `packages/db/src/drizzle/repositories/audit-logs.ts`
- Create: `packages/db/src/drizzle/repositories/audit-logs.proof.integration.test.ts`

**Interfaces:**
- Consumes: `AuditChainPayload` from `@rovenue/shared/audit-chain` (Task 1).
- Produces: `export interface AuditProofRow extends AuditChainPayload { id: string; rowHash: string }`.
- Produces: `export async function listAuditProofRows(db: Db, args: { projectId: string; from?: Date; to?: Date; limit: number }): Promise<AuditProofRow[]>` — ordered by `createdAt` then `id` ascending, so the chain can be walked deterministically.

**Why a separate read:** the existing `listAuditLogs` joins the user table and
returns display fields. A proof row must contain exactly what the hash covers and
nothing else — a bundle whose entries carry extra or missing fields cannot
reproduce its own hashes. Do not extend `listAuditLogs`; add a sibling.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/repositories/audit-logs.proof.integration.test.ts`.
This runs against the ambient Postgres. Note `packages/db` has NO
`vitest.config.ts` — its `test` script is plain
`vitest run --minWorkers=1 --maxWorkers=2`, and its integration tests require
`DATABASE_URL` to be exported in the environment. Read the existing
`packages/db/src/drizzle/repositories/credit-ledger.integration.test.ts` for how
that package's integration tests are written and run, and match it.

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../client";
import { auditLogs, projects } from "../schema";
import { listAuditProofRows } from "./audit-logs";

// Seeded with direct inserts, never by calling the audit writer: a proof
// read must be verified against rows whose exact field values the test
// controls, not against whatever the writer happens to produce.

describe("listAuditProofRows", () => {
  it("returns exactly the hashed fields, chain-ordered", async () => {
    // 1. Insert a project and three audit rows with known createdAt
    //    values out of insertion order, each with a prevHash pointing at
    //    its predecessor's rowHash.
    // 2. Call listAuditProofRows for that project.
    // 3. Assert the rows come back ordered by createdAt ascending.
    // 4. Assert each row object has EXACTLY these keys and no others:
    //    id, projectId, userId, action, resource, resourceId, before,
    //    after, ipAddress, userAgent, createdAt, prevHash, rowHash.
    //    Use expect(Object.keys(row).sort()).toEqual([...].sort()) — an
    //    extra field silently breaks hash reproduction, so the key set
    //    is the assertion, not a spot check.
    // 5. Assert createdAt is an ISO string, not a Date: the encoder
    //    never sees a Date, so the read must have stringified it.
  });

  it("scopes to one project", async () => {
    // Insert rows under two projects; assert only the requested
    // project's rows return.
  });
});
```

Fill each numbered comment with real code. They are the assertions to write, not
placeholders to leave.

- [ ] **Step 2: Run it to verify it fails**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/audit-logs.proof.integration.test.ts --maxWorkers=2
```

Expected: FAIL — `listAuditProofRows` is not exported.

- [ ] **Step 3: Implement the read**

Add to `packages/db/src/drizzle/repositories/audit-logs.ts`. Select only the
hashed columns plus `id` and `rowHash`; stringify `createdAt` with
`.toISOString()` so the shape matches what the encoder expects. Order by
`createdAt` then `id` — `createdAt` alone is not a total order and two rows
sharing a timestamp would walk non-deterministically.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/audit-logs.proof.integration.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p packages/db
```

Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/audit-logs.ts \
        packages/db/src/drizzle/repositories/audit-logs.proof.integration.test.ts
git commit -m "feat(db): read audit rows in their exact hashed shape

A proof bundle's entries must reproduce their own row hash, so the read
returns the hashed fields and nothing else, chain-ordered by (createdAt,
id) since createdAt alone is not a total order."
```

---

### Task 3: The proof export endpoint

**Files:**
- Modify: `apps/api/src/routes/dashboard/audit-logs.ts`
- Create: `apps/api/src/routes/dashboard/audit-logs.proof.test.ts`

**Interfaces:**
- Consumes: `listAuditProofRows` (Task 2), `AUDIT_CHAIN_FORMAT_V1` (Task 1).
- Produces: `GET /dashboard/projects/:projectId/audit-logs/proof` returning
  `{ data: AuditProofBundle }` where
  `AuditProofBundle = { formatVersion: string; projectId: string; exportedAt: string; origin: { rowHash: string; createdAt: string } | null; tip: { rowHash: string; createdAt: string } | null; entries: AuditProofRow[] }`.
- Produces: `export const AUDIT_PROOF_MAX_ENTRIES = 5000`.

**Authorisation:** gate it exactly as the existing list route does —
`assertProjectAccess(projectId, user.id)` (verified at
`routes/dashboard/audit-logs.ts:28`). Do not invent a capability the codebase does
not have.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/dashboard/audit-logs.proof.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the data layer only; assertProjectAccess runs for real so the
// authorisation assertions exercise the real gate rather than a mock of
// it — the same approach §12.3's dashboard tests used.

describe("GET /audit-logs/proof", () => {
  test("returns a bundle whose entries reproduce their own rowHash", async () => {
    // Seed three rows with hashes computed by hashAuditRow itself, then
    // assert every returned entry re-hashes to its stated rowHash. This
    // is the test that makes the endpoint worth having: a bundle that
    // cannot self-verify is useless.
  });

  test("declares the format version", async () => {
    // Assert formatVersion === AUDIT_CHAIN_FORMAT_V1. A bundle without
    // it cannot be verified by a future reader.
  });

  test("origin is null when the range starts at the chain's first row", async () => {
    // The first row's prevHash is null; origin must reflect that rather
    // than inventing a predecessor.
  });

  test("origin names the predecessor when the range starts mid-chain", async () => {
    // Export from the second row onward; origin must carry the first
    // row's rowHash so a verifier can anchor the segment.
  });

  test("an empty range returns an empty bundle, not an error", async () => {
    // entries: [], tip: null. A project with no audit rows in the window
    // is a valid state.
  });

  test("a member of another project cannot export this project's bundle", async () => {
    // 403. Plus its mirror: a legitimate member CAN export, so the test
    // cannot pass against a route that refuses everything.
  });

  test("caps the entry count", async () => {
    // Assert the repository is called with limit AUDIT_PROOF_MAX_ENTRIES.
    // An unbounded export over a busy project's whole history is a
    // denial-of-service vector.
  });
});
```

Fill each comment with real code.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/audit-logs.proof.test.ts --maxWorkers=2
```

Expected: FAIL — route not found.

- [ ] **Step 3: Implement the endpoint**

Add the route to `apps/api/src/routes/dashboard/audit-logs.ts`, following the
file's existing structure, its `ok()` envelope and its Zod error mapping. Accept
optional `from` / `to` ISO query params validated with Zod. `origin` is the
`prevHash` of the first returned entry resolved to its predecessor row (or null
when that `prevHash` is null); `tip` is the last entry's `rowHash` and
`createdAt`.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/audit-logs.proof.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/audit-logs.ts \
        apps/api/src/routes/dashboard/audit-logs.proof.test.ts
git commit -m "feat(audit): export a self-verifying proof bundle

Entries carry exactly the hashed fields, so a bundle reproduces its own
hashes offline. Capped, and authorised on the project the same way the
existing list route is."
```

---

### Task 4: The standalone offline verifier

**Files:**
- Create: `scripts/verify-audit-bundle.ts`
- Create: `scripts/verify-audit-bundle.test.ts`

**Interfaces:**
- Consumes: `canonicalJSON`, `hashAuditRow`, `AUDIT_CHAIN_FORMAT_V1`,
  `AuditChainPayload` from `@rovenue/shared/audit-chain` (Task 1).
- Produces: `export interface VerifyResult { ok: boolean; entriesChecked: number; failure?: { index: number; entryId: string; reason: "ROW_HASH_MISMATCH" | "PREV_HASH_MISMATCH" | "UNHASHED_ROW" } }`.
- Produces: `export function verifyAuditBundle(bundle: unknown): VerifyResult`.
- Produces: a CLI entry point reading a bundle path from `process.argv[2]`,
  printing a human-readable result and exiting non-zero on failure.

**Constraints specific to this task:**
- It must import ONLY from `@rovenue/shared/audit-chain` and `node:` builtins.
  Nothing from `apps/api`, nothing from `packages/db`. An auditor running this is
  not trusting the server.
- Follow the existing pattern in `scripts/` — read `scripts/verify-asset-headers.ts`
  and `scripts/package.json` first and match how those are structured and run.

**Origin rule to implement:** a chain segment begins at the first entry. If the
bundle declares an `origin`, the first entry's `prevHash` must equal
`origin.rowHash`; if `origin` is null, the first entry's `prevHash` must be null.
Any entry with a null or missing `rowHash` inside the range is `UNHASHED_ROW` — a
hard error, never a skip.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-audit-bundle.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  AUDIT_CHAIN_FORMAT_V1,
  hashAuditRow,
  type AuditChainPayload,
} from "@rovenue/shared/audit-chain";
import { verifyAuditBundle } from "./verify-audit-bundle";

function entry(
  overrides: Partial<AuditChainPayload> & { id: string },
): AuditChainPayload & { id: string; rowHash: string } {
  const payload: AuditChainPayload = {
    projectId: "prj_1",
    userId: "usr_1",
    action: "update",
    resource: "product",
    resourceId: "prd_1",
    before: null,
    after: { price: 1 },
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    prevHash: null,
    ...overrides,
  };
  return { ...payload, id: overrides.id, rowHash: hashAuditRow(payload) };
}

function chainOf(n: number) {
  const out: Array<ReturnType<typeof entry>> = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i += 1) {
    const e = entry({
      id: `aud_${i}`,
      prevHash: prev,
      createdAt: new Date(Date.UTC(2026, 8, 5, 0, 0, i)).toISOString(),
    });
    out.push(e);
    prev = e.rowHash;
  }
  return out;
}

function bundle(entries: ReturnType<typeof chainOf>) {
  return {
    formatVersion: AUDIT_CHAIN_FORMAT_V1,
    projectId: "prj_1",
    exportedAt: "2026-09-05T01:00:00.000Z",
    origin: null,
    tip: entries.length
      ? { rowHash: entries[entries.length - 1]!.rowHash, createdAt: entries[entries.length - 1]!.createdAt }
      : null,
    entries,
  };
}

describe("verifyAuditBundle", () => {
  test("accepts an intact chain", () => {
    const r = verifyAuditBundle(bundle(chainOf(5)));
    expect(r.ok).toBe(true);
    expect(r.entriesChecked).toBe(5);
  });

  test("names the entry whose payload was altered", () => {
    const entries = chainOf(5);
    // Tamper with the payload but leave rowHash untouched: this is what
    // an edited audit record looks like.
    entries[2] = { ...entries[2]!, after: { price: 999 } };
    const r = verifyAuditBundle(bundle(entries));
    expect(r.ok).toBe(false);
    expect(r.failure?.index).toBe(2);
    expect(r.failure?.entryId).toBe("aud_2");
    expect(r.failure?.reason).toBe("ROW_HASH_MISMATCH");
  });

  test("names the link when a prevHash is rewritten", () => {
    const entries = chainOf(5);
    // Re-hash so the row itself is self-consistent — only the link to
    // its predecessor is wrong. A verifier that checked row hashes
    // alone would pass this.
    const broken = { ...entries[3]!, prevHash: "0".repeat(64) };
    entries[3] = { ...broken, rowHash: hashAuditRow(broken) };
    const r = verifyAuditBundle(bundle(entries));
    expect(r.ok).toBe(false);
    expect(r.failure?.index).toBe(3);
    expect(r.failure?.reason).toBe("PREV_HASH_MISMATCH");
  });

  test("detects a removed entry", () => {
    const entries = chainOf(5);
    entries.splice(2, 1);
    // Deleting a row leaves the next row's prevHash pointing at a hash
    // that is no longer its predecessor.
    const r = verifyAuditBundle(bundle(entries));
    expect(r.ok).toBe(false);
    expect(r.failure?.reason).toBe("PREV_HASH_MISMATCH");
  });

  test("rejects an unknown format version rather than guessing", () => {
    const b = { ...bundle(chainOf(2)), formatVersion: "rovenue.audit-chain.v99" };
    expect(verifyAuditBundle(b).ok).toBe(false);
  });

  test("rejects an entry with no rowHash", () => {
    const entries = chainOf(3);
    // @ts-expect-error deliberately malformed
    entries[1] = { ...entries[1]!, rowHash: null };
    const r = verifyAuditBundle(bundle(entries));
    expect(r.failure?.reason).toBe("UNHASHED_ROW");
  });

  test("anchors a mid-chain segment against its declared origin", () => {
    const all = chainOf(5);
    const segment = all.slice(2);
    const b = {
      ...bundle(segment),
      origin: { rowHash: all[1]!.rowHash, createdAt: all[1]!.createdAt },
    };
    expect(verifyAuditBundle(b).ok).toBe(true);

    const wrongOrigin = { ...b, origin: { rowHash: "0".repeat(64), createdAt: all[1]!.createdAt } };
    expect(verifyAuditBundle(wrongOrigin).ok).toBe(false);
  });

  test("an empty bundle verifies as ok with nothing checked", () => {
    const r = verifyAuditBundle(bundle([]));
    expect(r.ok).toBe(true);
    expect(r.entriesChecked).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd scripts && nice -n 19 npx vitest run verify-audit-bundle.test.ts --maxWorkers=2
```

Expected: FAIL — module not found. If `scripts/vitest.config.ts` does not pick up
this path, adjust the invocation to match how `scripts/asset-headers.integration.test.ts`
is run rather than changing the config.

- [ ] **Step 3: Implement the verifier**

Create `scripts/verify-audit-bundle.ts`. Walk the entries in order: for each, strip
`id` and `rowHash` to recover the `AuditChainPayload`, recompute with
`hashAuditRow`, compare against the stated `rowHash`, then check the link
(`entries[i].prevHash === entries[i-1].rowHash`, or against `origin` for the
first). Return on the first failure with its index, id and reason.

Add the CLI entry point: read the path from `process.argv[2]`, `JSON.parse` the
file, print `ok` with the count or the failure detail, and `process.exit(1)` on
failure so it is usable in a pipeline.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd scripts && nice -n 19 npx vitest run verify-audit-bundle.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p scripts
```

Expected: PASS, clean.

- [ ] **Step 5: Prove the two halves agree end to end**

The unit tests above build bundles from `hashAuditRow` directly, so they prove the
verifier is self-consistent — not that it accepts what the ENDPOINT actually
emits. Add one test that takes a bundle produced by Task 3's endpoint (reuse that
test's fixture construction) and runs `verifyAuditBundle` over it. Put it in
`apps/api/src/routes/dashboard/audit-logs.proof.test.ts`, importing the verifier.
Without this, the export and the verifier could drift apart while both suites stay
green — the exact failure mode §12 hit three times.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-audit-bundle.ts scripts/verify-audit-bundle.test.ts \
        apps/api/src/routes/dashboard/audit-logs.proof.test.ts
git commit -m "feat(audit): standalone offline bundle verifier

Imports only @rovenue/shared/audit-chain and node builtins -- an auditor
running it is explicitly not trusting the API. Detects an altered
payload, a rewritten link and a removed row, and refuses an unknown
format version rather than guessing."
```

---

### Task 5: Document the format and tick the checkbox

**Files:**
- Create: `docs/` page for the proof format (find the docs app's structure first:
  `ls apps/docs/content` or equivalent, and match the neighbouring pages)
- Modify: `ROADMAP.md`

**Interfaces:** consumes everything above; produces no code.

**Why this is a task and not a footnote:** the point of the deliverable is that
someone OUTSIDE Rovenue can verify a chain. That is impossible without a written
description of the bundle shape, the canonical encoding rule, and how to run the
verifier. An undocumented proof format is not externally verifiable.

- [ ] **Step 1: Write the documentation**

Cover: what the chain guarantees and what it does not; the exact canonical
encoding rule (sorted keys, recursive, non-finite numbers as null, `createdAt` as
ISO-8601); the bundle shape field by field; the origin rule; how to obtain a
bundle; how to run the verifier; and what each failure reason means.

State plainly what the chain does NOT prove: it detects alteration of recorded
rows, it does not prove that everything which happened was recorded.

- [ ] **Step 2: Tick the ROADMAP checkbox**

In `ROADMAP.md` under `## 9. GDPR / KVKK tooling`, mark the third item done with a
one-line note naming the endpoint and the verifier script. Do not claim coverage
the tests do not have.

- [ ] **Step 3: Commit**

```bash
git add docs ROADMAP.md
git commit -m "docs(audit): describe the proof bundle and its verification"
```
