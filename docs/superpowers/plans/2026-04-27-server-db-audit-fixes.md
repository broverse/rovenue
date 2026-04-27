# Server & DB Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four production-grade gaps surfaced by the 2026-04-27 server/DB audit (Apple root pin placeholders, Apple verifier silent fallback in prod, audit-tx atomicity, Stripe handler clone hack) and refresh CLAUDE.md so it matches the real stack.

**Architecture:** All fixes are local edits to `apps/api/src` plus one doc update — no schema, no migrations, no new packages. Where behaviour changes (verifier fail-closed, audit-tx re-thread, Stripe clone), an integration-style test pins the new contract before the implementation lands. The `_callerTx` re-thread is the only refactor that touches a public function shape; existing callers already pass `tx` so the change is transparent at call sites.

**Tech Stack:** TypeScript / Hono / Drizzle / Vitest / Better Auth / @apple/app-store-server-library / `pg_advisory_xact_lock`. No new deps.

**Out of scope (deliberate):**
- Receipt route (`/v1/receipts`) Stripe support — needs product decision, not a bug.
- pg_partman cron health verification — already documented as registered for `revenue_events` + `credit_ledger` in `0019_install_pg_partman.sql`; revisit only if the partition-maintenance integration test starts failing.
- Stripe webhook end-to-end test — adding one is good hygiene but expands scope; tracked as a follow-up note in Task 4.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/services/apple/apple-root-fingerprints.ts` | Modify | Pin canonical SHA-256s of Apple Root CA G3 + Apple Inc Root |
| `apps/api/tests/_helpers/apple-roots/AppleRootCA-G3.cer` | Create | Real cert fixture so the positive-case test in `apple-root-fingerprint.test.ts` actually runs |
| `apps/api/tests/_helpers/apple-roots/AppleIncRootCertificate.cer` | Create | Same, RSA legacy root |
| `apps/api/src/services/apple/apple-verify.ts` | Modify | `createAppleVerifier` must fail closed in prod when certs are missing/empty (today only mismatch fails closed) |
| `apps/api/tests/apple-verify.test.ts` | Modify | Add prod-fail-closed assertion |
| `apps/api/src/lib/audit.ts` | Modify | When `callerTx` is supplied, run `writeChained` in that tx instead of opening a new one; export `AuditTx` as a usable structural type |
| `apps/api/src/services/gdpr/anonymize-subscriber.ts` | Modify | Drop the `TODO(audit-tx)` comment now that re-threading is real |
| `apps/api/tests/audit-tx-rollback.test.ts` | Create | Integration test asserting that an audit row rolls back when the caller's transaction rolls back |
| `apps/api/src/routes/webhooks/stripe.ts` | Modify | Drop `JSON.parse(JSON.stringify(event))`; pass the verified event directly |
| `CLAUDE.md` | Modify | Drizzle (not Prisma); ClickHouse + Kafka/Redpanda + outbox + pg_partman; expanded scope (experiments, flags, audiences, GDPR) |

Each task ends with a focused commit so git history matches the punch list.

---

## Pre-Flight

- [ ] **Step 0.1: Create a feature branch**

```bash
cd /Volumes/Development/rovenue
git checkout -b fix/audit-2026-04-27
```

- [ ] **Step 0.2: Confirm baseline is green**

```bash
cd /Volumes/Development/rovenue
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: exit 0, no output. If errors exist, stop and surface them — don't layer fixes on a broken tree.

---

## Task 1: Replace Apple root CA fingerprints with canonical values

**Why:** `apple-root-fingerprints.ts` ships two `@placeholder` hashes. `assertAppleRootFingerprints()` will reject every real Apple chain in production unless these are replaced with the actual SHA-256 digests of the certificates Apple publishes at https://www.apple.com/certificateauthority/. Apple Root CA G3 (ECC) signs StoreKit / App Store Server JWS; Apple Inc Root (RSA) is the legacy root some older receipts still chain to. Keep both.

**Files:**
- Modify: `apps/api/src/services/apple/apple-root-fingerprints.ts`
- Create: `apps/api/tests/_helpers/apple-roots/AppleRootCA-G3.cer`
- Create: `apps/api/tests/_helpers/apple-roots/AppleIncRootCertificate.cer`

- [ ] **Step 1.1: Download the canonical certs from apple.com and compute SHA-256**

Run via `mcp__plugin_context-mode_context-mode__ctx_execute` (shell), so binary cert bytes never enter our context — only the printed hex digest does:

```bash
set -euo pipefail
WORK=$(mktemp -d)
cd "$WORK"
curl -sSfL -o AppleRootCA-G3.cer https://www.apple.com/appleca/AppleRootCA-G3.cer
curl -sSfL -o AppleIncRootCertificate.cer https://www.apple.com/appleca/AppleIncRootCertificate.cer

# Sanity: confirm DER parses as a self-signed root
for f in *.cer; do
  echo "--- $f ---"
  openssl x509 -inform DER -in "$f" -noout -subject -issuer -fingerprint -sha256 | tr -d ':' | tr 'A-F' 'a-f'
done

# Move into the repo as test fixtures
mkdir -p /Volumes/Development/rovenue/apps/api/tests/_helpers/apple-roots
cp AppleRootCA-G3.cer AppleIncRootCertificate.cer \
   /Volumes/Development/rovenue/apps/api/tests/_helpers/apple-roots/
```

Expected: subject contains `Apple Root CA - G3` for the first, `Apple Root CA` / `Apple Inc.` for the second; both have matching subject and issuer (self-signed root); fingerprints printed as 64-char lowercase hex.

**Capture the two `sha256 Fingerprint=...` hex values into context — these become the literals in Step 1.2.**

- [ ] **Step 1.2: Replace the placeholder Set entries**

`apps/api/src/services/apple/apple-root-fingerprints.ts` — replace the two `@placeholder` lines (and their comments) with the verified hashes from Step 1.1. Keep the immutability shim and the `assertAppleRootFingerprints` export untouched.

```ts
const frozen = new Set<string>([
  // Apple Root CA - G3 (ECC) — apple.com/certificateauthority
  "<G3_SHA256_FROM_STEP_1.1>",
  // Apple Inc. Root Certificate (RSA, legacy)
  "<AAI_SHA256_FROM_STEP_1.1>",
]);
```

Hex values must be lowercase, exactly 64 chars, no separators.

- [ ] **Step 1.3: Run the existing fingerprint test — positive case now activates**

The test in `apps/api/tests/apple-root-fingerprint.test.ts` is `test.skipIf(!existsSync(FIXTURE_DIR))` — by adding the fixtures in Step 1.1 we light it up.

```bash
pnpm --filter @rovenue/api exec vitest run apple-root-fingerprint
```

Expected: every test in the file passes, including `accepts when every provided buffer matches a pinned fingerprint`. If it fails with a fingerprint-mismatch error, the hex you pasted in Step 1.2 is wrong — re-derive from Step 1.1.

- [ ] **Step 1.4: Commit**

```bash
git add apps/api/src/services/apple/apple-root-fingerprints.ts \
        apps/api/tests/_helpers/apple-roots/
git commit -m "fix(api): pin canonical Apple Root CA G3 + AAI fingerprints"
```

---

## Task 2: Apple verifier must fail closed in production when root certs are missing

**Why:** `createAppleVerifier()` only re-throws the cert-load error when `loadAppleRootCerts()` *throws* (fingerprint mismatch). If the dir is unset, missing, empty, or unreadable, `loadAppleRootCerts()` returns `null` and the factory **silently** returns `JoseAppleNotificationVerifier` — explicitly documented as "insecure: no chain validation". Production must refuse to construct that verifier.

**Files:**
- Modify: `apps/api/src/services/apple/apple-verify.ts:179-201`
- Modify: `apps/api/tests/apple-verify.test.ts`

- [ ] **Step 2.1: Write the failing test**

Append to `apps/api/tests/apple-verify.test.ts`:

```ts
describe("createAppleVerifier — production safety", () => {
  test("throws in production when no Apple root certs are configured", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevDir = process.env.APPLE_ROOT_CERTS_DIR;
    process.env.NODE_ENV = "production";
    delete process.env.APPLE_ROOT_CERTS_DIR;
    try {
      vi.resetModules();
      const { createAppleVerifier } = await import(
        "../src/services/apple/apple-verify"
      );
      expect(() =>
        createAppleVerifier({ projectId: "p1", bundleId: "com.example" }),
      ).toThrow(/apple root|chain validation|fail closed/i);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevDir === undefined) delete process.env.APPLE_ROOT_CERTS_DIR;
      else process.env.APPLE_ROOT_CERTS_DIR = prevDir;
      vi.resetModules();
    }
  });

  test("falls back to jose verifier outside production", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevDir = process.env.APPLE_ROOT_CERTS_DIR;
    process.env.NODE_ENV = "test";
    delete process.env.APPLE_ROOT_CERTS_DIR;
    try {
      vi.resetModules();
      const { createAppleVerifier } = await import(
        "../src/services/apple/apple-verify"
      );
      const verifier = createAppleVerifier({
        projectId: "p1",
        bundleId: "com.example",
      });
      expect(verifier).toBeDefined();
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevDir === undefined) delete process.env.APPLE_ROOT_CERTS_DIR;
      else process.env.APPLE_ROOT_CERTS_DIR = prevDir;
      vi.resetModules();
    }
  });
});
```

- [ ] **Step 2.2: Run the test — expect the prod-safety case to FAIL**

```bash
pnpm --filter @rovenue/api exec vitest run apple-verify
```

Expected: `throws in production when no Apple root certs are configured` fails with no error thrown (the current code returns a Jose verifier instead). The dev-fallback case should already pass.

- [ ] **Step 2.3: Tighten the factory — fail closed on null/empty in prod**

In `apps/api/src/services/apple/apple-verify.ts`, edit `createAppleVerifier`:

```ts
export function createAppleVerifier(
  opts: CreateAppleVerifierOpts,
): AppleNotificationVerifier {
  let certs: Buffer[] | null = null;
  try {
    certs = loadAppleRootCerts();
  } catch (err) {
    if (env.NODE_ENV === "production") {
      throw err;
    }
    log.warn("Apple root cert load failed — dev fallback to jose verifier", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!certs || certs.length === 0) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "Apple root certs unavailable (APPLE_ROOT_CERTS_DIR unset, missing, or empty) — refusing to construct an unchained verifier in production",
      );
    }
    log.warn("falling back to jose verifier (no Apple root certs)", {
      projectId: opts.projectId,
    });
    return new JoseAppleNotificationVerifier();
  }
  // ... rest unchanged (cache + LibraryAppleNotificationVerifier construction)
}
```

- [ ] **Step 2.4: Run the test — expect PASS**

```bash
pnpm --filter @rovenue/api exec vitest run apple-verify
```

Expected: both new cases pass; pre-existing apple-verify tests still pass.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/services/apple/apple-verify.ts \
        apps/api/tests/apple-verify.test.ts
git commit -m "fix(api): apple verifier fails closed in prod when root certs missing"
```

---

## Task 3: Re-thread audit() through the caller's transaction for atomicity

**Why:** `audit()` accepts `_callerTx` but ignores it and opens its own `drizzle.db.transaction(...)` (audit.ts:~205). That means GDPR anonymize, subscriber transfer, project delete, and credential rotation all commit their domain row first and the audit row second — independent of each other. A crash between commits leaves an entry in the resource without a tamper-evident log row, which violates the audit-chain compliance contract. Fix: when a caller passes their tx, run the chain write inside it.

**Trade-off:** the `pg_advisory_xact_lock` now releases when the **caller's** transaction commits, not when the inner tx commits — so per-project audit serialisation extends across the caller's whole tx. Acceptable: caller transactions are short, and atomicity is the whole point.

**Files:**
- Modify: `apps/api/src/lib/audit.ts`
- Modify: `apps/api/src/services/gdpr/anonymize-subscriber.ts` (drop the obsolete TODO)
- Create: `apps/api/tests/audit-tx-rollback.test.ts`

- [ ] **Step 3.1: Write the failing rollback test**

Create `apps/api/tests/audit-tx-rollback.test.ts`:

```ts
import { describe, expect, test, beforeAll } from "vitest";
import { drizzle, eq } from "@rovenue/db";
import { audit } from "../src/lib/audit";
import { setupTestDb, makeProject } from "./_helpers/test-db";

describe("audit() respects caller transaction lifecycle", () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  test("audit row rolls back when caller tx rolls back", async () => {
    const project = await makeProject();
    const action = "subscriber.anonymized";
    const resourceId = `roll-${Date.now()}`;

    await expect(
      drizzle.db.transaction(async (tx) => {
        await audit(
          {
            projectId: project.id,
            userId: null,
            action,
            resource: "subscriber",
            resourceId,
            before: null,
            after: { anonymousId: "anon" },
            ipAddress: null,
            userAgent: null,
          },
          tx,
        );
        throw new Error("force-rollback");
      }),
    ).rejects.toThrow(/force-rollback/);

    const found = await drizzle.db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, resourceId));
    expect(found).toHaveLength(0);
  });

  test("audit row commits when caller tx commits", async () => {
    const project = await makeProject();
    const action = "subscriber.anonymized";
    const resourceId = `keep-${Date.now()}`;

    await drizzle.db.transaction(async (tx) => {
      await audit(
        {
          projectId: project.id,
          userId: null,
          action,
          resource: "subscriber",
          resourceId,
          before: null,
          after: { anonymousId: "anon" },
          ipAddress: null,
          userAgent: null,
        },
        tx,
      );
    });

    const found = await drizzle.db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, resourceId));
    expect(found).toHaveLength(1);
  });
});
```

If `apps/api/tests/_helpers/test-db.ts` lacks a `setupTestDb` / `makeProject` helper, mirror the pattern from `apps/api/tests/audit-chain.test.ts` and `apps/api/tests/audit-log.test.ts` — they already speak to the same Postgres testcontainer. Reuse, don't reinvent.

- [ ] **Step 3.2: Run — expect the rollback case to FAIL**

```bash
pnpm --filter @rovenue/api exec vitest run audit-tx-rollback
```

Expected: `audit row rolls back when caller tx rolls back` fails — `found.length` is 1 because audit() opened its own tx that committed before the caller threw.

- [ ] **Step 3.3: Re-thread audit() to honour the caller tx**

In `apps/api/src/lib/audit.ts`:

1. Replace the private `type AuditTx = unknown;` with a structural export:

```ts
export type AuditTx = {
  select: DrizzleDb["select"];
  insert: DrizzleDb["insert"];
  execute: DrizzleDb["execute"];
};
```

(Drop the now-redundant `DrizzleAuditTxInner` alias and use `AuditTx` everywhere it referenced the inner type.)

2. Re-thread the function:

```ts
export async function audit(
  entry: AuditEntry,
  callerTx?: AuditTx,
): Promise<void> {
  if (entry.resource === "credential") {
    for (const snapshot of [entry.before, entry.after]) {
      if (snapshot && !isRedacted(snapshot)) {
        throw new Error(
          "credential audit entries must pass redacted snapshots",
        );
      }
    }
  }

  if (callerTx) {
    await writeChained(entry, callerTx);
    return;
  }

  await drizzle.db.transaction(async (innerTx) =>
    writeChained(entry, innerTx as unknown as AuditTx),
  );
}
```

`writeChained`'s second parameter type changes from `DrizzleAuditTxInner` to `AuditTx` — no behaviour change, just the rename.

- [ ] **Step 3.4: Drop the obsolete TODO**

In `apps/api/src/services/gdpr/anonymize-subscriber.ts`, remove the seven-line `// TODO(audit-tx): ...` block immediately above the `await audit(..., tx)` call. The behaviour it warned about is now fixed.

- [ ] **Step 3.5: Run all audit + GDPR tests**

```bash
pnpm --filter @rovenue/api exec vitest run audit-tx-rollback audit-chain audit-log gdpr-anonymize subscriber-transfer
```

Expected: every test passes. If `audit-chain` regresses, the per-project advisory lock might be racing differently when callers nest transactions — re-read `audit.ts` for the lock acquisition order.

- [ ] **Step 3.6: Commit**

```bash
git add apps/api/src/lib/audit.ts \
        apps/api/src/services/gdpr/anonymize-subscriber.ts \
        apps/api/tests/audit-tx-rollback.test.ts
git commit -m "fix(api): re-thread audit() through caller tx for atomicity"
```

---

## Task 4: Stripe webhook — pass the verified event without JSON round-trip

**Why:** `routes/webhooks/stripe.ts` deep-clones `verified.event` via `JSON.parse(JSON.stringify(event))` before enqueueing. Stripe's `webhooks.constructEvent()` already returns a plain JSON-shaped POJO — the round-trip costs CPU, allocates twice, and `as Stripe.Event` papers over the fact that any Date/Buffer/class instance on the event would silently flatten. BullMQ serialises the job payload itself when persisting to Redis, so an extra clone before enqueue is pure waste.

**Files:**
- Modify: `apps/api/src/routes/webhooks/stripe.ts:43-46`

**Follow-up note (out of scope):** there is no test for `stripeWebhookRoute`. Add one in a separate PR — pattern mirrors `apple-webhook` route tests (sign a payload with the project secret, post, assert 202 + queue enqueue).

- [ ] **Step 4.1: Make the edit**

In `apps/api/src/routes/webhooks/stripe.ts`, replace:

```ts
const event = verified.event;

const job = await enqueueWebhookEvent({
  source: "STRIPE",
  projectId,
  event: JSON.parse(JSON.stringify(event)) as Stripe.Event,
});
```

with:

```ts
const event = verified.event;

const job = await enqueueWebhookEvent({
  source: "STRIPE",
  projectId,
  event,
});
```

If TypeScript complains that `event`'s inferred type doesn't match `enqueueWebhookEvent`'s `event` parameter, the right fix is to widen `enqueueWebhookEvent`'s typing in `apps/api/src/services/webhook-processor.ts` to take the same `Stripe.Event` shape that `verified.event` already carries — not to reintroduce the cast.

- [ ] **Step 4.2: Typecheck + targeted test run**

```bash
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/api exec vitest run webhook-processor stripe
```

Expected: tsc exit 0; tests pass (those that exist for the processor).

- [ ] **Step 4.3: Commit**

```bash
git add apps/api/src/routes/webhooks/stripe.ts
git commit -m "fix(api): drop redundant JSON round-trip in stripe webhook handler"
```

---

## Task 5: Update CLAUDE.md to reflect the actual stack

**Why:** the doc still says Prisma, omits ClickHouse/Kafka/Redpanda/pg_partman, omits experiments/feature-flags/audiences/leaderboards/GDPR, and lists obsolete env vars. Future contributors and Claude itself will keep generating Prisma queries against a Drizzle codebase until this is fixed.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 5.1: Apply the edits**

Replace the relevant sections of `CLAUDE.md`:

**Tech Stack** — change `**Database:** PostgreSQL + Prisma ORM` → `**Database:** PostgreSQL 16 + Drizzle ORM (declarative range partitions via pg_partman)`. Add lines:

```
- **Analytics:** ClickHouse (read replica fed via Kafka Engine + Materialized Views)
- **Streaming:** Kafka / Redpanda + transactional outbox pattern (no dual-writes)
```

**Coding Conventions** — change `Prisma for all DB access` → `Drizzle for all DB access — repositories live under packages/db/src/drizzle/repositories`. Drop the `prisma migrate` mention.

**Database** — replace the existing block with:

```
- PostgreSQL 16, Drizzle ORM, drizzle-kit migrations under `packages/db/drizzle/migrations`
- Hot tables (revenue_events, credit_ledger, outgoing_webhooks) are declarative range partitions; pg_partman manages premake/retention for the first two, partition-maintenance worker handles outgoing_webhooks
- ClickHouse mirrors Postgres via Kafka Engine + MVs (`packages/db/clickhouse/migrations/`) for MRR / credit balance / consumption
- Auth tables (managed by Better Auth): user, session, account
- App tables: project_members, api_keys, projects, subscribers, products, product_groups, purchases, subscriber_access, credit_ledger, webhook_events, outgoing_webhooks, revenue_events, audiences, experiments, exposure_events, feature_flags, audit_logs, outbox_events
- All IDs are UUIDs (cuid2 generated); all timestamps UTC with timezone
- Encrypted store credentials use AES-256-GCM
- credit_ledger is append-only; audit_logs are append-only with per-project SHA-256 hash chain
```

**Project Structure** — add `apps/dashboard/`, drop the obsolete `prisma migrate` references in commands. Add scope note that the platform now also covers experiments, feature flags, audiences, leaderboards, and GDPR (anonymize / export).

**Environment Variables** — add `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `KAFKA_BROKERS`, `APPLE_ROOT_CERTS_DIR`. Drop any vars no longer present in `.env.example`.

**Commands** — replace `pnpm db:migrate` reference if it points to Prisma; the actual command is `pnpm --filter @rovenue/db drizzle-kit migrate` (or equivalent — check `packages/db/package.json` scripts before writing).

- [ ] **Step 5.2: Verify against `.env.example` and `package.json` scripts**

Cross-check every env var and command you wrote against the current `.env.example` and `packages/db/package.json` / root `package.json` so the doc isn't stale-on-arrival.

- [ ] **Step 5.3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: refresh CLAUDE.md for Drizzle + ClickHouse + outbox + pg_partman stack"
```

---

## Final Verification

- [ ] **Step F.1: Full typecheck**

```bash
cd /Volumes/Development/rovenue
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/db  exec tsc --noEmit
```

Expected: both exit 0, no output.

- [ ] **Step F.2: Run the suites touched by these changes**

```bash
pnpm --filter @rovenue/api exec vitest run \
  apple-root-fingerprint apple-verify \
  audit-chain audit-log audit-tx-rollback \
  gdpr-anonymize subscriber-transfer \
  webhook-processor
```

Expected: green.

- [ ] **Step F.3: Push and open PR**

```bash
git push -u origin fix/audit-2026-04-27
```

PR title: `fix: 2026-04-27 audit findings — Apple pinning, verifier fail-closed, audit-tx, stripe clone, docs`. Body should link to this plan and the original audit summary.

---

## Self-Review Notes

- **Spec coverage:** every P0/P1/P2 from the audit (except the deferred receipt-route product question) maps to a task. The Apple verifier fail-closed gap was *not* in the original audit but was discovered while reading the verifier code for Task 1; promoted to P0 since it lets prod silently use an unchained Jose verifier.
- **Placeholders:** `<G3_SHA256_FROM_STEP_1.1>` / `<AAI_SHA256_FROM_STEP_1.1>` are not plan placeholders — they are values the executor *computes* in Step 1.1 and pastes in Step 1.2. The plan tells you how to derive them.
- **Type consistency:** `AuditTx` becomes a real exported structural type in Task 3 and replaces `DrizzleAuditTxInner` everywhere. `writeChained`'s signature changes once, atomically with the export.
