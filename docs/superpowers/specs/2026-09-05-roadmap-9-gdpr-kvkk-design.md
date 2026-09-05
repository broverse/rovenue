# ROADMAP §9 — GDPR / KVKK tooling (85 → 95)

Date: 2026-09-05
Branch: `roadmap-12-feature-breadth` (§12 complete on it; §9 continues here unless
a fresh branch is preferred)
Status: design, awaiting review

## Scope

The three §9 checkboxes:

1. Self-service DSAR API, exposed by customers to their end users
2. Per-table data-retention policy automation
3. Externally verifiable proof format for the audit hash chain

Three independent subsystems. Each gets its own implementation plan; this
document is the shared design so the interactions between them are decided once,
up front, rather than discovered during the third one.

## What already exists

| Area | State |
|---|---|
| Export | `services/gdpr/export-subscriber.ts` emits subscriber + purchases + access + credit ledger. Works. |
| Erasure | `services/gdpr/anonymize-subscriber.ts` replaces `appUserId` with an HMAC of the row id, clears `attributes`, nulls `appleAppAccountToken`, stamps `deletedAt`, and cancels live Stripe subscriptions. Keeps the row id. |
| Exposure | Both are reachable ONLY from `routes/dashboard/subscribers.ts` behind `requireDashboardAuth`. There is no SDK- or S2S-facing route. A customer's staff must service every end-user request by hand. |
| Retention | `billing_tier_limits.retentionDays` and `.auditLogDays` are declared and seeded by migration 0100 — and read by nothing. Three unrelated workers delete specific things on hardcoded windows: `rovi-retention` (copilot messages, env var), `import-retention` (import files, constant), `webhook-retention`. |
| Audit chain | `lib/audit.ts` keeps a per-project SHA-256 chain with a correct canonical JSON encoder (sorted keys, recursive, non-finite numbers normalised). `audit_logs` carries `prevHash` and a unique `rowHash`. `routes/dashboard/audit-logs.ts` lists rows. There is no verification endpoint and no exportable proof. |

## The two cross-item interactions

These are the reason this is one design document rather than three.

### Retention would silently destroy the audit chain

`auditLogDays` means deleting old `audit_logs` rows. Every row's `prevHash`
references its predecessor, so deleting row N makes every row after it
unverifiable back to origin. Item 2, built naively, destroys what item 3 builds.

**Resolution — checkpoint-and-truncate.** Before truncating a project's audit
history, export the segment as an item-3 proof bundle, then delete it, then
write a `checkpoint` audit row recording the hash of the last deleted row and
the bundle's identifier. The verifier treats a checkpoint as a legitimate
segment boundary: the chain after it verifies from the checkpoint, and the
deleted portion remains independently verifiable from the exported bundle.

This is why item 3 is built first: item 2 cannot safely touch audit logs until
the bundle format exists.

### Self-service erasure makes a known bug dangerous

`/v1/me/attributes` can re-populate an erased subscriber. `resolveOrCreateSubscriber`
(`lib/resolve-or-create-subscriber.ts:93`) destructures only `{ subscriber }` and
discards the `deadEnded` flag that `resolveSubscriberForWrite` computes;
`routes/v1/me.ts` then upserts unconditionally onto the soft-deleted row.
`routes/v1/subscribers.ts:163` guards exactly this case and documents the intent.

Today that requires an operator to erase someone first, so it is rare. Self-service
erasure makes it routine: an end user erases themselves, then their app's next
attribute write silently un-erases them — and the user has been told the erasure
succeeded.

**This is a blocker for 9.1, not a deferred minor.** It is the first task of that
plan.

## Global constraints

- TDD: a failing test precedes every behaviour change.
- No magic values. Retention windows, rate limits and format versions are named
  exported constants.
- Postgres access through Drizzle repositories only; raw `sql` with qualified
  columns.
- Every destructive path is audited through the existing `audit()` chain, inside
  the caller's transaction.
- Tests that claim a concurrency, retention or verification property run against
  real infrastructure. Integration tests use the ambient stack via
  `apps/api/tests/setup.ts` and seed inline with `getDb()`.
- Verify every wire and column identifier against the producing code before
  trusting a fixture. §12 produced three defects of exactly this kind.
- New workers declare Prometheus counters in `apps/api/src/lib/metrics.ts`.
- Dashboard strings go through `t()` keys resolved via explicit maps.
- Throttled runs: `nice -n 19 npx vitest run <paths> --maxWorkers=2`, from inside
  the app directory, never the repo root.

---

## Sub-project 9.3 — Externally verifiable audit proof

Built first: 9.2 depends on its bundle format.

### Design

**Extract the canonical encoder.** `canonicalJSON` and `hashRow` move from
`apps/api/src/lib/audit.ts` into `@rovenue/shared` as a documented, versioned
format. `audit.ts` imports them; its behaviour must not change, which a
byte-equality test against the current implementation pins.

**Version the format.** The encoder gains an explicit version identifier
(`AUDIT_CHAIN_FORMAT_V1`). Rows carry no version column today, and adding one to
a table with existing chained rows would change their hashes. So the version
lives in the *bundle*, not the row: a bundle declares which format version its
hashes were computed under, and the verifier refuses a version it does not
implement rather than guessing.

**Export endpoint.** `GET /dashboard/projects/:projectId/audit-logs/proof`,
gated the same way the existing audit-log list route is — `assertProjectAccess`,
not a named capability (verified at `routes/dashboard/audit-logs.ts:28`) — streaming
a bundle:

```
{ formatVersion, projectId, exportedAt,
  origin: { rowHash, createdAt } | null,     // null = chain start
  tip:    { rowHash, createdAt },
  entries: [ { ...the exact fields the hash covers..., prevHash, rowHash } ] }
```

The entry fields are whatever `canonicalJSON` hashes — not a prettified subset.
A bundle whose entries cannot reproduce their own `rowHash` is worthless, so the
export is defined by the encoder rather than by what reads nicely.

**Standalone verifier.** A dependency-free script under `packages/db` or
`scripts/` that takes a bundle and recomputes every hash: each entry's `rowHash`
from its canonical form, and each `prevHash` against its predecessor's `rowHash`.
It reports the first divergence with the entry id. It must not import from
`apps/api` — an auditor running it is explicitly not trusting the API.

**Origin rule, stated.** `prevHash` is nullable and rows predating the chain have
no hash. This database has none (0 unhashed of 116 verified), but the schema
permits them, so the verifier defines: a chain begins at the first row with a
non-null `rowHash`, and any unhashed row inside an exported range is a hard
error, not a skip.

### Files

- `packages/shared/src/audit-chain.ts` — encoder, version constant, verify helper
- `apps/api/src/lib/audit.ts` — import instead of define
- `apps/api/src/routes/dashboard/audit-logs.ts` — the proof endpoint
- `scripts/verify-audit-bundle.ts` — the standalone verifier

### Tests

- Byte-equality: the extracted encoder produces identical output to the current
  one across nested objects, arrays, nulls, non-finite numbers and key ordering.
- A round trip: export a real project's bundle and verify it passes.
- Tamper detection: flip one byte in one entry's `after` payload and assert the
  verifier names that entry. Flip a `prevHash` and assert it names the link.
- Version refusal: a bundle claiming an unknown format version is rejected, not
  best-effort verified.

---

## Sub-project 9.2 — Per-table retention automation

### Design

**A policy registry, not a sweeper full of special cases.** One table describing
what is retainable:

| Field | Meaning |
|---|---|
| `table` | the physical table |
| `timestampColumn` | which column ages the row |
| `strategy` | `DROP_PARTITION` \| `DELETE_ROWS` \| `CHECKPOINT_TRUNCATE` |
| `tierLimitField` | `retentionDays` or `auditLogDays` |
| `minimumDays` | a floor no project may go below (legal/operational) |

**Strategy matters more than the window.** `credit_ledger`, `revenue_events` and
`outgoing_webhooks` are range-partitioned (migrations 0015, 0016, 0017).
Retention there must DROP PARTITIONS, not delete rows — orders of magnitude
cheaper, and row deletion on the highest-volume tables is exactly where a naive
sweeper would fall over. `audit_logs` uses `CHECKPOINT_TRUNCATE` per the
interaction above. Everything else uses `DELETE_ROWS` in bounded batches.

**Window resolution.** The project's billing tier supplies the default from the
already-seeded `retentionDays` / `auditLogDays`. A project may configure a
SHORTER window per table; never a longer one. The effective window is
`max(minimumDays, min(tierDays, projectOverrideDays ?? tierDays))`, computed in
one place and unit-tested against the ladder.

**`credit_ledger` is append-only behind a database trigger.** Any deletion there
must go through `withLedgerDeleteAuthorized` (`SET LOCAL "rovenue.allow_ledger_delete"`).
Dropping a partition may bypass the row trigger — that must be verified against a
real database rather than assumed, and if it does bypass it, the audit entry for
the drop is the only record that it happened.

**ClickHouse is out of scope here and that is a decision, not an oversight.**
Analytics tables carry their own fixed TTL (`INTERVAL 2 YEAR` on
`raw_revenue_events`). Making that tier-driven is a separate piece of work; this
sub-project owns Postgres retention and says so explicitly rather than implying
coverage it does not have.

**One worker, registry-driven**, replacing the bespoke windows in
`rovi-retention`, `import-retention` and `webhook-retention` — those tables become
registry rows. Counters: rows/partitions reclaimed per table, and sweeps skipped
by reason.

### Tests

- Window resolution against the real tier ladder, including a project override
  that tries to exceed its tier (clamped) and one below the floor (clamped).
- Partition strategy against real Postgres: a partition older than the window is
  dropped and a newer one is not.
- `CHECKPOINT_TRUNCATE` on `audit_logs`: the bundle is exported before deletion,
  the checkpoint row records the last deleted hash, and the surviving chain
  verifies from the checkpoint using 9.3's verifier.
- Append-only enforcement: a ledger deletion outside `withLedgerDeleteAuthorized`
  still fails.

---

## Sub-project 9.1 — Self-service DSAR API

Largest, built last, and it opens with a bug fix.

### Design

**Task one: fix the erasure hole.** `resolveOrCreateSubscriber` must surface
`deadEnded`, and `/v1/me/attributes` must refuse to write onto a dead-ended row —
matching what `routes/v1/subscribers.ts` already does and documents. Without
this, self-service erasure is a lie.

**Auth: secret-key S2S, the customer acting for its own user.** The customer's
backend authenticates its end user however it already does, then calls Rovenue
with that subscriber's identifier. Rovenue never authenticates someone else's
users. This matches `/v1/subscribers/transfer`, which is already secret-key only.

**Authorise on the subscriber's own project, never the caller's claim.** The
§12.3 lesson: resolve the subscriber, then check that subscriber's `projectId`
against the authenticated key's project. A negative test and its mirror (a caller
legitimately reaching its own subscriber) both required — a negative-only test
also passes against a route that refuses everything.

**Rate limit it.** A DSAR export runs a multi-table read; an unlimited endpoint
is a denial-of-service vector. Reuse the existing rate-limit middleware pattern
(`routes/v1/receipts.ts` sets `max: 30`), with its own tighter budget.

**A request record, because DSARs have legal deadlines.** A `dsar_requests` table
recording subject, type (`EXPORT` | `ERASURE`), requester, status, timestamps and
the resulting artifact. It makes the request idempotent (a retry returns the same
request rather than starting a second export), gives the customer evidence of
when they responded, and gives Rovenue a queryable record of outstanding
obligations.

**Exports are asynchronous.** An export is enqueued on BullMQ, written to the
existing asset-storage path, and exposed as a short-lived signed download. Reuse
that machinery rather than streaming a large multi-table read inside a request.
Every state change is audited.

### The open decision: what erasure means for ClickHouse

Verified: `anonymize-subscriber.ts` has zero ClickHouse references, while
`raw_revenue_events` and `raw_credit_ledger` store `subscriberId` as a plain
String. Postgres anonymisation replaces `appUserId` with an HMAC and clears
attributes, but keeps the row id — which is exactly what ClickHouse holds. So
after an erasure, the subscriber's full revenue and credit history remains in
analytics, keyed to an id that is now pseudonymous, until the fixed 2-year TTL.

Three positions, and this is a legal call rather than an engineering one:

- **A — pseudonymisation is sufficient.** The identifying material (the customer's
  own user id, the attributes) is destroyed; what remains cannot be re-identified
  through Rovenue. Document it plainly in the DSAR response and the docs so
  customers can assess it for their own jurisdiction. No new work.
- **B — purge analytics too.** Issue `ALTER TABLE ... DELETE WHERE subscriberId = ?`
  mutations against the analytics tables as part of erasure. Complete, but
  ClickHouse mutations are asynchronous and expensive, so erasure becomes a
  long-running job with its own completion tracking.
- **C — re-key instead of delete.** Rewrite `subscriberId` to the same HMAC
  pseudonym Postgres uses, preserving aggregate revenue history while breaking
  the link. Cheaper than deletion and keeps analytics correct, but is still a
  mutation and still leaves a per-subject row.

**Recommendation: B, scoped as its own task within 9.1**, with A documented as the
interim behaviour until it lands. A product that advertises erasure should not
retain per-subject purchase history keyed to a stable id, even a pseudonymous
one — and the fixed 2-year TTL is a retention policy, not an erasure.

### Tests

- Erasure sticks: erase a subscriber, then POST `/v1/me/attributes` for them and
  assert the row is not re-populated. This is the regression test for the bug
  above and must fail against current code.
- Cross-project: a key for project A cannot export or erase project B's
  subscriber; a key for project A can reach its own (the mirror).
- Idempotency: submitting the same erasure twice yields one request record and
  one erasure.
- Rate limiting: the configured budget is enforced.
- If B is chosen: after erasure, an analytics query for that subscriber returns
  nothing, verified against real ClickHouse rather than mocked.

---

## Sequencing

1. **9.3 audit proof** — no dependencies; produces the bundle format 9.2 needs.
2. **9.2 retention** — depends on 9.3 for `CHECKPOINT_TRUNCATE`.
3. **9.1 DSAR** — largest; opens with the `deadEnded` fix, and its ClickHouse
   task depends on nothing but is the riskiest single piece.

Estimated 13–17 tasks total; exact counts come with each plan.

## Risks

- **The `credit_ledger` partition-drop-versus-trigger question is unresolved by
  design.** Whether dropping a partition bypasses the append-only trigger must be
  established against a real database before 9.2's strategy table is trusted. If
  it does bypass, the audit entry is the only record — which is acceptable, but
  only once it is a decision rather than an assumption.
- **ClickHouse mutations are asynchronous.** If option B is chosen, "erasure
  complete" must mean the mutation finished, not that it was submitted. That
  needs completion tracking, or the DSAR record will claim more than it delivers.
- **Extracting the canonical encoder changes a compliance-critical code path.**
  The byte-equality test is what makes it safe; without it, a subtle encoding
  difference would silently invalidate every hash written afterwards while all
  existing tests stayed green.
