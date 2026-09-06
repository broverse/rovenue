# Self-Service DSAR API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Rovenue customer expose GDPR/KVKK subject-access and erasure to its own end users, through secret-key S2S endpoints backed by a durable request record.

**Architecture:** The customer's backend authenticates its end user, then calls Rovenue with that subscriber's identifier. Rovenue authorises on the SUBSCRIBER's project, never on the caller's claim. A `dsar_requests` row makes each request idempotent and gives both sides evidence of when it was answered. Exports run asynchronously on BullMQ into private object storage and are served back through an authenticated route. Erasure reuses the shipped `anonymizeSubscriber` service and additionally purges ClickHouse.

**Tech Stack:** TypeScript strict, Hono, Drizzle, BullMQ, ClickHouse, S3-protocol object storage, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-roadmap-9-gdpr-kvkk-design.md` (§9.1)

## Global Constraints

- TypeScript strict. Zod for API input. Responses are `{ data: T }` or `{ error: { code, message } }`.
- No magic values: every limit, budget, queue name and status string is a named exported constant.
- Postgres access through Drizzle repositories under `packages/db/src/drizzle/repositories`. In raw `sql`, qualify columns.
- Workers follow `apps/api/src/workers/leaderboard-scheduler.ts`: a `Deps` interface with `defaultDeps`, a pure injectable entry point, per-item `try/catch`, a `*SkippedTotal` counter labelled by reason.
- Self-confirming tests prove nothing. Every test names the mutation it catches, and each task red-checks at least the ones its brief lists.
- Every authorisation test needs BOTH directions — a foreign caller refused AND a legitimate caller served. A refusal-only test passes against a route that refuses everyone.
- Tests throttled and sequential: `nice -n 19 npx vitest run <paths> --maxWorkers=2`. Never the full suite. Integration tests use the ambient docker stack (Postgres 5433, Redis 6380, Redpanda 19092, ClickHouse 8124).
- `tsc --noEmit` is currently FULLY clean for `apps/api`, `packages/db` and `packages/shared`. Keep it that way.

## Established facts — verified against the code, not assumed

1. **The erasure hole is real and located.** `resolveOrCreateSubscriber`
   (`apps/api/src/lib/resolve-or-create-subscriber.ts:85-100`) calls
   `resolveSubscriberForWrite` and destructures only `{ subscriber }`, discarding the
   `deadEnded` flag the resolver computes (`:28`, `:45`, `:52`, `:61`).
   `apps/api/src/middleware/app-user-context.ts:34` uses that lossy wrapper, so every
   route behind it — including `POST /v1/me/attributes` — writes onto a soft-deleted
   subscriber. `apps/api/src/routes/v1/subscribers.ts:147-177` already does it correctly
   and documents why.
2. **The GDPR services already exist.** `apps/api/src/services/gdpr/export-subscriber.ts`
   exports `exportSubscriber` / `SubscriberExport`;
   `apps/api/src/services/gdpr/anonymize-subscriber.ts` exports `anonymizeSubscriber` /
   `AnonymizeReason`. This plan wires them to an API and a request record; it does not
   reimplement them. Read both before writing anything.
3. **`anonymize-subscriber.ts` has zero ClickHouse references.** Postgres anonymisation
   replaces `appUserId` with an HMAC and clears attributes but KEEPS the row id — which
   is exactly what `raw_revenue_events` and `raw_credit_ledger` store as a plain String.
   So today, erasure leaves a subscriber's full revenue and credit history in analytics
   keyed to a now-pseudonymous id.
4. **Secret-key auth is `requireSecretKey`** from `apps/api/src/middleware/api-key-auth`,
   used by `/v1/subscribers/transfer` (`routes/v1/subscribers.ts:16`, `:188`).
5. **Endpoint rate limiting is `endpointRateLimit({ name, max })`**, per API key on top of
   the `/v1` envelope — see `routes/v1/receipts.ts:47-51`, which uses `max: 30` and
   explains why one budget is shared across sibling routes.
6. **Neither object store supports presigned URLs.** `asset-store.ts` and
   `import-store.ts` expose `putObject` / `deleteObject` / `isStorageConfigured` and no
   signing helper.

## Rulings made before execution

**Ruling A — export artifacts go to the IMPORT bucket, never the asset bucket.**
The spec says "the existing asset-storage path". That is wrong and would publish
PII: the asset bucket's MinIO policy grants anonymous `s3:GetObject` across the
whole bucket, which is *why* `import-store.ts` exists as a separate private bucket
(its own comment, `import-store.ts:16-34`, says exactly this about PII exports).
Use the import bucket under a distinct `dsar-exports/` prefix. §9.2 established
that `import-retention` deletes only keys read off `import_jobs` rows and never
scans the bucket, so it cannot reach these.

**Ruling B — no signed URLs; serve the download through an authenticated route.**
The spec asks for "a short-lived signed download", but neither store can sign, and
adding presigning means new bucket-policy surface. A signed URL is also a bearer
token in a query string: it leaks through logs, referrers and copy-paste, and a
DSAR export is the most sensitive artifact this system produces. Serve it from
`GET /v1/dsar/:id/download` behind `requireSecretKey`, streaming from storage, with
the same subscriber-project authorisation as every other route here. An expiry
still applies — the request record carries one, and the route refuses a stale
request.

**Ruling C — erasure purges ClickHouse (the spec's option B).** ClickHouse here is a
DERIVED analytics store, not the book of record: the real financial records live in
Stripe/Apple/Google and in Postgres's append-only `credit_ledger`. So deleting the
analytics rows destroys nobody's tax or accounting evidence, which removes the main
argument against B. Option A (pseudonymisation is enough) leaves per-subject
purchase history keyed to a stable id for two years; option C (re-key to the HMAC)
is not erasure at all, because Postgres stores that same HMAC as `appUserId`, so
the link is trivially re-established. ClickHouse mutations are asynchronous, so
"erasure complete" must mean the mutation FINISHED, not that it was submitted.

---

### Task 1: Close the erasure hole

**Files:**
- Modify: `apps/api/src/lib/resolve-or-create-subscriber.ts`
- Modify: `apps/api/src/middleware/app-user-context.ts`
- Modify: `apps/api/src/routes/v1/me.ts`
- Create: `apps/api/src/routes/v1/me.dead-ended.test.ts`

**Interfaces:**
- Produces: `resolveOrCreateSubscriber` returns `{ subscriber: Subscriber; deadEnded: boolean }`, and the app-user context carries `deadEnded`.

**Why this is task one.** Self-service erasure is a lie without it. Today an end
user can be erased and their app's very next attribute write silently un-erases
them, while the user has been told the erasure succeeded. Making erasure
self-service turns that from a rare operator-triggered case into a routine one.

**Do not narrow the fix to `/v1/me/attributes`.** `resolveOrCreateSubscriber` is
also used by `routes/v1/experiments.ts:97` and `:178`. Surface `deadEnded` from the
resolver and the middleware; then decide per route, and say in your report what you
decided for the experiments routes and why. A dead-ended subscriber being assigned
to an experiment is a different question from one being written to, and you should
answer it deliberately rather than by omission.

- [x] **Step 1: Write the failing regression test**

Create `apps/api/src/routes/v1/me.dead-ended.test.ts`:

```ts
describe("POST /v1/me/attributes on an erased subscriber", () => {
  it("does not re-populate a dead-ended subscriber's attributes", async () => {
    // Seed a subscriber, anonymize it via the real anonymizeSubscriber
    // service, then POST attributes for the same appUserId. Assert the
    // stored row still has the anonymized attributes — NOT the ones just
    // posted. This must FAIL against current code; that failure is the
    // bug the whole sub-project depends on being fixed.
  });

  it("still writes attributes for a live subscriber", async () => {
    // The mirror. Without it the first test passes against a route that
    // refuses every write.
  });

  it("reports success to the caller rather than an error", async () => {
    // Decide and pin the contract: an erased subject's client should not
    // learn that they were erased from a 4xx. Assert whatever you choose
    // and say why in your report.
  });
});
```

Fill each comment with real code.

- [x] **Step 2: Run it and watch the first test fail**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/v1/me.dead-ended.test.ts --maxWorkers=2
```

Expected: the first test FAILS against current code. Report the exact message. If it passes, STOP — the bug is not where the plan says it is.

- [x] **Step 3: Surface `deadEnded` and refuse the write**

- [x] **Step 4: Run it green, then re-run the neighbours**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/v1/me.dead-ended.test.ts --maxWorkers=2
cd apps/api && nice -n 19 npx vitest run src/routes/v1/experiments.test.ts src/middleware --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

- [x] **Step 5: Commit**

Message:

```
fix(gdpr): stop an attribute write from un-erasing a subscriber

resolveOrCreateSubscriber discarded the deadEnded flag its own resolver
computes, so every route behind app-user-context wrote onto soft-deleted
rows. routes/v1/subscribers.ts already guarded this and documented why.
```

---

### Task 2: The `dsar_requests` record

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: migration via `pnpm db:migrate:generate`
- Create: `packages/db/src/drizzle/repositories/dsar-requests.ts`
- Create: `packages/db/src/drizzle/repositories/dsar-requests.integration.test.ts`
- Modify: `packages/db/src/drizzle/index.ts` (barrel)

**Interfaces:**
- Produces: table `dsar_requests` — `id`, `projectId` (FK, cascade), `subscriberId` (FK), `type` (`EXPORT` | `ERASURE`), `status` (`PENDING` | `RUNNING` | `COMPLETED` | `FAILED`), `requestedBy` (free text supplied by the customer, identifying who asked), `artifactKey` (nullable), `expiresAt` (nullable), `error` (nullable), `createdAt`, `updatedAt`, `completedAt` (nullable).
- Produces: `findOpenDsarRequest(db, args)`, `createDsarRequest(db, args)`, `claimDsarRequest(db, id)`, `completeDsarRequest(db, args)`, `failDsarRequest(db, id, error)`, `findDsarRequestById(db, id)`.

**Idempotency is the point of this table.** A retry must return the SAME request
rather than starting a second export. Decide the uniqueness rule and enforce it in
the database, not only in the route: a partial unique index over
`(subscriberId, type)` where `status IN ('PENDING','RUNNING')` expresses "one open
request of each type per subject" and makes a concurrent double-submit a database
error rather than two exports. Add it by hand to the generated SQL if drizzle-kit
cannot express it, and re-run `db:migrate:generate` afterwards to confirm it
reports no changes.

**Migration constraints — read before generating.** The journal is NOT globally
monotonic; entries at idx 40/41, 52/53 and 58/59 are ancient violations from main's
own history, already applied everywhere. Leave them alone. What matters is that
your NEW entry's `when` exceeds the current maximum — check it, and if drizzle-kit
generates a lower value, set it explicitly above the maximum as one deliberate
value rather than interpolating between neighbours. `packages/db/tests/journal-monotonic.test.ts`
is the guard; run it. Verify the migration applies on an upgrade-path database, not
only a fresh one.

- [x] **Step 1: Write the failing integration test**

Create `packages/db/src/drizzle/repositories/dsar-requests.integration.test.ts`. Read `retention-overrides.integration.test.ts` in the same directory first and match how it obtains a handle, seeds and cleans up.

```ts
describe("dsar requests", () => {
  it("round-trips a request", async () => {});

  it("refuses a second OPEN request of the same type for one subject", async () => {
    // Assert on the Postgres error code by walking the .cause chain, not
    // a message substring — Drizzle wraps errors, so a substring match
    // silently never fires. retention-overrides.integration.test.ts has
    // the walk to copy.
  });

  it("allows a new request once the previous one completed", async () => {
    // Otherwise a subject could exercise their rights exactly once, ever.
  });

  it("allows the same subject an EXPORT and an ERASURE concurrently", async () => {
    // They are different rights and must not block each other.
  });

  it("scopes lookups to a project", async () => {
    // Both directions: a foreign project cannot see the request, and the
    // owning project can.
  });
});
```

Fill each comment with real code.

- [x] **Step 2: Run it to verify it fails**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/dsar-requests.integration.test.ts --maxWorkers=2
```

Expected: FAIL — relation does not exist.

- [x] **Step 3: Implement schema, migration and repository**

- [x] **Step 4: Run green, verify the journal and the upgrade path**

```bash
cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/dsar-requests.integration.test.ts tests/journal-monotonic.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p packages/db
```

Report the `when` you ended up with and the upgrade-path `max(created_at)` before and after.

- [x] **Step 5: Commit**

```
feat(gdpr): a durable record for subject-access requests

DSARs carry legal deadlines, so the request is a row rather than a job:
it makes a retry idempotent, gives the customer evidence of when they
responded, and makes outstanding obligations queryable.
```

---

### Task 3: The DSAR API routes

**Files:**
- Create: `apps/api/src/routes/v1/dsar.ts`
- Create: `apps/api/src/routes/v1/dsar.test.ts`
- Modify: `apps/api/src/routes/v1/index.ts` (route registration)

**Interfaces:**
- Consumes: `requireSecretKey`, `endpointRateLimit`, the Task 2 repository.
- Produces: `POST /v1/dsar/export`, `POST /v1/dsar/erasure`, `GET /v1/dsar/:id`, `GET /v1/dsar/:id/download`.
- Produces: `export const DSAR_ENDPOINT_MAX_PER_MINUTE = 5`.

**Authorisation, and the §12.3 lesson.** Resolve the subscriber FIRST, then check
that subscriber's `projectId` against the authenticated key's project. Never trust
a projectId from the request body or path. Every authorisation test needs both
directions.

**Rate limit tighter than receipts.** A DSAR export runs a multi-table read;
`receipts` uses `max: 30`, and this must be lower. Share ONE budget across
`/export` and `/erasure` so a caller cannot double it by alternating, exactly as
receipts shares one across `/apple` and `/google`.

**The download route (Ruling B).** `GET /v1/dsar/:id/download` behind
`requireSecretKey`, authorised on the subscriber's project, refusing a request that
is not `COMPLETED`, whose `expiresAt` has passed, or whose `artifactKey` is null.
Stream from the import bucket; never return a URL.

- [x] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/dsar.test.ts`:

```ts
describe("DSAR routes", () => {
  it("creates an EXPORT request and enqueues exactly one job", async () => {});

  it("returns the SAME request when the same subject asks twice", async () => {
    // Idempotency at the route, on top of the database constraint.
    // Assert one request id AND that a second job was not enqueued.
  });

  it("refuses a subscriber belonging to another project", async () => {
    // 403/404 — decide and pin which, and say why in your report.
  });

  it("serves a subscriber belonging to the calling project", async () => {
    // The mirror. Without it the previous test passes against a route
    // that refuses everyone.
  });

  it("refuses a public API key", async () => {
    // These are secret-key S2S endpoints. A public key reaching them
    // would let anyone with a client bundle erase other people's data.
  });

  it("enforces the rate limit across export AND erasure together", async () => {
    // Alternating the two routes must not double the budget.
  });

  it("refuses to download a request that is not COMPLETED", async () => {});

  it("refuses to download an expired request", async () => {});

  it("refuses to download another project's request", async () => {});
});
```

Fill each comment with real code.

- [x] **Step 2: Run it to verify it fails**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/v1/dsar.test.ts --maxWorkers=2
```

Expected: FAIL — routes not found.

- [x] **Step 3: Implement**

- [x] **Step 4: Run green**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/v1/dsar.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

Red-check the authorisation: make the route read `projectId` from the body instead of from the resolved subscriber, confirm the foreign-project test fails, restore. Report what you saw.

- [x] **Step 5: Commit**

```
feat(gdpr): self-service DSAR endpoints

Secret-key S2S: the customer authenticates its own end user, then asks
Rovenue on their behalf. Authorised on the subscriber's project, never on
a projectId the caller supplied.
```

---

### Task 4: The export worker

**Files:**
- Create: `apps/api/src/workers/dsar-export.ts`
- Create: `apps/api/src/workers/dsar-export.integration.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/lib/metrics.ts`

**Interfaces:**
- Consumes: `exportSubscriber` (`services/gdpr/export-subscriber.ts`), the Task 2 repository, `importStore`.
- Produces: `runDsarExport`, `ensureDsarExportWorker()`, `DSAR_EXPORT_QUEUE_NAME`, `DSAR_ARTIFACT_TTL_DAYS`.

**Ordering.** Claim the request (conditional UPDATE `PENDING` → `RUNNING`, returning
null if another replica won), run the export, write the artifact to storage and
CONFIRM the write, then mark `COMPLETED` with the key and `expiresAt`. A failure at
any step marks `FAILED` with the error, never leaves the row `RUNNING` forever.
Every state change is audited.

**Fail closed when storage is unconfigured** — mark the request `FAILED` with a
clear error rather than pretending to succeed. A customer who was told their export
was ready and finds nothing has been misinformed about a legal obligation.

- [x] **Step 1: Write the failing integration test**

```ts
describe("runDsarExport", () => {
  it("writes the artifact before marking the request COMPLETED", async () => {
    // Assert call ORDER, not merely that both happened.
  });

  it("marks FAILED and stores nothing when the export throws", async () => {});

  it("marks FAILED when storage is unconfigured", async () => {});

  it("cannot be claimed twice", async () => {
    // Two concurrent runs, one claim. The other must no-op rather than
    // producing a second artifact.
  });

  it("writes an audit row for each state change", async () => {});
});
```

Fill each comment with real code.

- [x] **Step 2: Run it to verify it fails**

- [x] **Step 3: Implement**

- [x] **Step 4: Run green plus `tsc`**

Red-check: move the storage write after the COMPLETED update, confirm the ordering test fails, restore.

- [x] **Step 5: Commit**

```
feat(gdpr): asynchronous DSAR export worker

The artifact is written and confirmed before the request is marked
complete, so a customer is never told an export is ready that is not.
```

---

### Task 5: Erasure, including ClickHouse

**Files:**
- Create: `apps/api/src/workers/dsar-erasure.ts`
- Create: `apps/api/src/workers/dsar-erasure.integration.test.ts`
- Modify: `apps/api/src/services/gdpr/anonymize-subscriber.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `anonymizeSubscriber`, the Task 2 repository, the ClickHouse client.
- Produces: `runDsarErasure`, `ensureDsarErasureWorker()`, `DSAR_ERASURE_QUEUE_NAME`.

**Ruling C in practice.** After Postgres anonymisation, issue
`ALTER TABLE ... DELETE WHERE subscriberId = ?` against the analytics tables that
carry it — establish which those are by reading the ClickHouse migrations rather
than assuming; the spec names `raw_revenue_events` and `raw_credit_ledger`, so
verify that list is complete and say what you found.

**"Complete" must mean the mutation FINISHED.** ClickHouse mutations are
asynchronous. Poll `system.mutations` for `is_done` before marking the request
`COMPLETED`, with a bounded wait and a clear `FAILED` on timeout. A request record
that claims erasure while rows are still present is worse than no record, because
it is evidence of a promise that was not kept.

**The regression test that matters most:** erase a subscriber, then POST
`/v1/me/attributes` for them and assert the row is NOT re-populated. That is Task
1's guarantee, verified end to end through the real erasure path — if Task 1 ever
regresses, this is what catches it.

- [x] **Step 1: Write the failing integration test**

```ts
describe("runDsarErasure", () => {
  it("anonymizes in Postgres and purges ClickHouse", async () => {
    // Against real ClickHouse. Seed rows for the subject, run erasure,
    // assert an analytics query for that subscriberId returns nothing.
    // Mocked ClickHouse would prove nothing here — this repo has shipped
    // a query against non-existent columns that was green in CI.
  });

  it("waits for the mutation to finish before marking COMPLETED", async () => {});

  it("marks FAILED if the mutation does not finish in time", async () => {});

  it("leaves the subject erased after a later attribute write", async () => {
    // The Task 1 guarantee, end to end.
  });

  it("is idempotent — a second erasure of the same subject is a no-op", async () => {});
});
```

Fill each comment with real code.

- [x] **Step 2: Run it to verify it fails**

- [x] **Step 3: Implement**

- [x] **Step 4: Run green plus `tsc`**

- [x] **Step 5: Commit**

```
feat(gdpr): erasure purges analytics, not just Postgres

ClickHouse is a derived store, not the book of record, so deleting a
subject's rows there destroys no financial evidence -- and leaving them
keyed to a stable pseudonym would not be erasure.
```

---

### Task 6: Document and close §9

**Files:**
- Create: `apps/docs/content/docs/guides/dsar.mdx`
- Modify: `apps/docs/content/docs/guides/meta.json`
- Modify: `ROADMAP.md`

**Document what a customer must do**, not what Rovenue does internally: that they
authenticate their own end user first, that Rovenue never authenticates someone
else's users, the four endpoints, the rate budget, how idempotency behaves on a
retry, how long an artifact lives, and that the download is authenticated rather
than a shareable link.

**State the limits plainly**, because each is one a reader would otherwise assume
away: erasure anonymises rather than deleting the Postgres row (the id survives,
which is what makes the ledger's append-only guarantee possible); erasure DOES now
purge the analytics tables, but not any copy the customer has exported themselves;
and an export is a point-in-time snapshot, not a subscription.

- [x] **Step 1: Write the page**

Register it in `meta.json`'s `pages` array — a page missing from that array is unreachable with no error. Keep every brace inside a fenced code block; a bare double-brace in MDX prose breaks the static prerender. Read `apps/docs/content/docs/guides/retention-policies.mdx` and `audit-proof.mdx` and match their conventions.

- [x] **Step 2: Tick the ROADMAP checkbox**

`ROADMAP.md`, the FIRST bullet under `## 9. GDPR / KVKK tooling` — "Self-service DSAR API". With Tasks 1–5 done and §9.2 and §9.3 already ticked, this closes the section: update the section's score line too. Do not claim coverage the tests do not have.

- [x] **Step 3: Build the docs and commit**

```bash
nice -n 19 pnpm --filter @rovenue/docs build
```

Report the prerender line for the new page.

```
docs(gdpr): describe the self-service DSAR API and close §9
```

---
