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

Do NOT add `export * from "./audit-chain"` to `packages/shared/src/index.ts`.
That barrel deliberately excludes `./crypto`, the bucketing helpers and
`./import/keys` because they import `node:crypto` and "would crash the dashboard
Vite bundle" — the comments saying so are at `index.ts:184`, `:193`, `:204` and
`:316`. `audit-chain.ts` imports `node:crypto` too, so it belongs in the same
category: reachable as `@rovenue/shared/audit-chain`, absent from the barrel.
Add a comment there recording the exclusion, matching the `./crypto` precedent.

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
  tests/audit-tx-rollback.test.ts src/lib/audit-integrations.test.ts \
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
- Produces: `export interface AuditProofRow extends AuditChainPayload { id: string; rowHash: string | null }`.
  `rowHash` is NULLABLE in the schema (`schema.ts:586`) for rows predating the
  chain, and this read has no `WHERE rowHash IS NOT NULL` filter, so such a row
  can reach a proof range. Do not filter nulls out and do not assert them away:
  an export must KNOW an unhashed row was in range, and the verifier treats that
  as a hard error. A non-nullable type here would hide the exact case the
  verifier exists to catch.
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
- Produces: `GET /dashboard/audit-logs/proof?projectId=<id>` returning
  (the router is mounted at `/audit-logs` in `routes/dashboard/index.ts:71`, and
  its sibling list route takes `projectId` as a required query param — this route
  matches it; there is no `/projects/:projectId` router to hang it off)
  `{ data: AuditProofBundle }` where
  `AuditProofBundle = { formatVersion: string; projectId: string; exportedAt: string; origin: { rowHash: string } | null; tip: { rowHash: string | null; createdAt: string } | null; entries: AuditProofRow[]; truncated: boolean }`.
  `truncated` is `entries.length === AUDIT_PROOF_MAX_ENTRIES`. Without it a
  capped export is byte-indistinguishable from a complete one, and a verifier
  declares a partial segment valid while the operator believes they hold the
  whole history. A cap that hides itself is worse than no cap.
  `origin` is derived purely from `entries[0].prevHash` — no second read, no
  predecessor timestamp; the anchor a verifier needs is the hash. `rowHash` is
  nullable on both an entry and the tip: `audit_logs.rowHash` is nullable for
  pre-chain legacy rows, and `listAuditProofRows` deliberately does not filter
  them out. Carry a null through; never drop the row, never coerce it.
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
optional `from` / `to` ISO query params validated with Zod. `origin` is
`{ rowHash: entries[0].prevHash }`, or null when that `prevHash` is null — do NOT
read the predecessor row; `tip` is the last entry's `rowHash` (possibly null) and
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
- Produces: `export interface VerifyResult { ok: boolean; entriesChecked: number; truncated: boolean; failure?: { index: number | null; entryId: string | null; reason: "ROW_HASH_MISMATCH" | "PREV_HASH_MISMATCH" | "UNHASHED_ROW" | "TIP_MISMATCH" | "MALFORMED_BUNDLE" | "UNSUPPORTED_FORMAT_VERSION" } }`.
  EVERY `ok: false` carries a `failure` with a reason. A verifier whose whole job
  is to say what is wrong must never answer "not ok" and nothing else. `index` and
  `entryId` are null for the failures that are not about a particular entry.
  `truncated` mirrors the bundle's own flag. A truncated bundle whose entries are
  intact is still `ok: true` — truncation is a legitimate export state, not
  tampering — but a programmatic consumer must not be able to read `ok` without
  seeing it, and the CLI must print it as a prominent line, not a footnote.
  A bundle missing the field entirely is treated as `truncated: true`: an export
  that will not say whether it is complete has not earned the benefit of the doubt.
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

**Shape rules, equally load-bearing.** The verifier takes `unknown` from a file an
auditor may have edited, so a malformed bundle is a VERDICT, never a thrown
TypeError and never a pass:

- `entries` absent, null, or not an array is `MALFORMED_BUNDLE`. It must NOT
  default to `[]`. Substituting an empty array turns the single easiest tamper on
  an audit bundle — delete the rows — into a clean attestation reading
  "0 entries verified", which is the worst possible output this tool can produce.
- `origin` present but without a string `rowHash` is `MALFORMED_BUNDLE`, not a
  mismatch. Never coerce with `String(...)`: that turns `origin: {}` into the
  literal `"undefined"` and compares it as if it were a hash.
- An unknown `formatVersion` is `UNSUPPORTED_FORMAT_VERSION`.

**Tip rule.** The tail must be anchored: if `tip` is non-null, the LAST entry's
`rowHash` must equal `tip.rowHash`; `tip` must be null exactly when `entries` is
empty. Otherwise deleting rows from the END of a bundle passes — the mid-chain
`prevHash` walk cannot see a missing tail, and closing that hole is the entire
reason `tip` is in the format. Mismatch is `TIP_MISMATCH`.

Each of these needs its own test, and each test must be red-checked against the
mutation it exists to catch.

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
    truncated: false,
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
      origin: { rowHash: all[1]!.rowHash },
    };
    expect(verifyAuditBundle(b).ok).toBe(true);

    const wrongOrigin = { ...b, origin: { rowHash: "0".repeat(64) } };
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

- [ ] **Step 5: Prove the two halves agree end to end, through a fixture**

The unit tests above build bundles from `hashAuditRow` directly, so they prove the
verifier is self-consistent — not that it accepts what the ENDPOINT actually
emits. Without an end-to-end tie, the export and the verifier drift apart while
both suites stay green — the exact failure mode §12 hit three times.

`apps/api` does not depend on `@rovenue/scripts`, so the endpoint test CANNOT
import the verifier. Use this repo's existing cross-boundary contract convention
instead — the one `packages/shared/src/experiments/bucketing-vectors.json` and
`packages/shared/src/paywall/render-fixtures.json` already use: a committed JSON
fixture that both sides read via `new URL("./<name>.json", import.meta.url)` (see
`packages/shared/src/experiments/bucketing-vectors.test.ts:24`).

Create `packages/shared/src/audit-proof-bundle-fixture.json` holding ONE real
bundle. Its entry hashes must be computed by `hashAuditRow`, never typed by hand.

Then wire both ends to it:

- In `apps/api/src/routes/dashboard/audit-logs.proof.test.ts`, add a test that
  mocks the repository read to return exactly the fixture's `entries`, calls the
  endpoint, and asserts the assembled bundle deep-equals the fixture (modulo
  `exportedAt`, which is a wall clock). If the endpoint's assembly drifts, this
  goes red.
- In `scripts/verify-audit-bundle.test.ts`, add a test that reads the same
  fixture and asserts `verifyAuditBundle(fixture).ok === true`.

Together these two prove the verifier accepts what the endpoint emits, with no
package-boundary violation in either direction.

Two pieces of plumbing this needs, both following patterns already in the repo:

1. `packages/shared/package.json` has an explicit `exports` map with no wildcard,
   so the fixture is unreachable until you add a subpath beside `./audit-chain`:

```json
    "./audit-proof-bundle-fixture.json": "./src/audit-proof-bundle-fixture.json",
```

   `resolveJsonModule` is already true in `tsconfig.base.json`, which every
   package extends, so `import fixture from "@rovenue/shared/audit-proof-bundle-fixture.json"`
   type-checks in both `apps/api` and `scripts` once that entry exists.

2. Register the CLI in `scripts/package.json`, matching the existing
   `verify:asset-headers` entry exactly in form:

```json
    "verify:audit-bundle": "tsx verify-audit-bundle.ts",
```

   Task 5 documents how an auditor runs the verifier; without this entry the only
   documentable invocation is a raw `tsx` path.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-audit-bundle.ts scripts/verify-audit-bundle.test.ts \
        packages/shared/src/audit-proof-bundle-fixture.json \
        packages/shared/package.json scripts/package.json \
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
