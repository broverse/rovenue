# Server-side authoring paths for paywalls and funnels

**Date:** 2026-09-07
**Status:** Design approved, not yet planned
**Sub-project:** B of 3 (see "Where this sits" below)

---

## Where this sits

This spec came out of brainstorming a **Rovenue MCP server**. That work
decomposed into three sub-projects once it became clear that the thing
blocking agent-authored paywalls was not MCP at all:

| | Sub-project | Depends on |
|---|---|---|
| A | MCP foundation — transport, token auth, read tools, experiment control | — |
| **B** | **Server-side authoring paths (this spec) — no MCP in it** | — |
| C | MCP authoring tools (`create_paywall`, `edit_funnel`, …) | A + B |

A and B are independent of each other; C needs both. B was sequenced
first because agent-authored paywalls and funnels are the actual goal,
and B is the critical path to them. **There is no MCP code in this
spec.** Every change here benefits any non-dashboard client, including
the dashboard itself.

---

## Problem

### 1. Paywall tree edits have no server-side write path

`action_paywall_editTree`'s intent handler
(`apps/api/src/services/copilot/intent-handlers.ts`) is **dry-run
only**. It runs `applyTreeOp` + `assertSaveValid` and returns
`{ op, paywallId }`. It performs no repo write. The handler's own
comment states persistence happens afterwards through
`PATCH /paywalls/:id`, once the user reviews the diff **in the
dashboard builder**.

So the only way a paywall tree edit becomes durable today is a
client-side apply from an open builder canvas. Any non-dashboard
client — an agent, a script, a future MCP tool — can validate an edit
but cannot land it.

### 2. Two authorization systems reach the same mutation

- `PATCH /paywalls/:id` gates on
  `assertProjectCapability(projectId, userId, "products:write")`.
  `CAPABILITY_ROLES["products:write"]` is the **set**
  `{OWNER, ADMIN, DEVELOPER}`.
- The intent-execute gate is `assertProjectAccess`, which is
  **rank**-based. `ROLE_RANK` gives GROWTH the same rank as DEVELOPER
  (both 2), so `requiresRole: "DEVELOPER"` would silently admit GROWTH —
  which `products:write` does not allow. `action-paywall.ts` therefore
  picks `requiresRole: "ADMIN"` and documents why: it is "the tightest
  rank that is a subset" of the capability, i.e. a workaround for the
  rank system's inexpressiveness, not a deliberate tightening.

Two paths to one mutation with two different authorizations is the
defect. It is also self-reinforcing: any new client has to pick a side.

Note what the fix is and is not: D3 unifies the **authorization**, not
the number of code paths. `PATCH /paywalls/:id` and the intent handler
both continue to exist and both write drafts; after D3 they answer to
one gate and one capability.

### 3. Funnel writes sit outside the capability system entirely

Every funnel mutation route uses
`assertProjectAccess(projectId, userId, MemberRole.DEVELOPER)` — the
rank gate — and there is **no `funnels:write` entry in
`CAPABILITY_ROLES` at all**. By rank equality, funnel writes today admit
`{OWNER, ADMIN, DEVELOPER, GROWTH}`.

### 4. The paywall draft has no concurrency control

`paywalls.builderConfig` is the draft, and the schema comment names it
"the builder's autosave target". The `paywalls` table carries no
version or etag column — only `updatedAt`. Two writers silently clobber
each other. This is not hypothetical: the builder autosaves.

### 5. Funnel page validation is UI-only

`packages/shared/src/funnel/pages-schema.ts` is deliberately permissive
— only `id` and `type` are required — and its own comment says per-type
field requirements (a `single_choice` page needing `options`, etc.) are
enforced by the dashboard UI before save. The server's
`validateFunnelGraph` checks cross-page invariants only (at least one
paywall + success, no cycles, no dangling refs, reachability).

A non-dashboard writer can therefore persist a structurally valid but
semantically broken funnel, and the server will accept it.

---

## What makes this tractable

`/v1/placements` serves the **published snapshot** from
`paywall_versions`, never `paywalls.builderConfig`
(`apps/api/src/lib/placement-resolution.ts`). Writing to a draft cannot
affect live traffic. The same draft/publish split exists for funnels
(`draft_pages_json` vs the published version).

This is the property the whole design leans on: **authoring is safe,
publishing is the guarded step.**

---

## Design

### D1 — Make the paywall tree handler persist

`action_paywall_editTree`'s handler adopts the same shape as every
other intent handler: one Drizzle transaction containing

1. `applyTreeOp` against the current draft,
2. `assertSaveValid` on the result,
3. the `builderConfig` write,
4. `audit()` **inside the same transaction**, so the audit row commits
   or rolls back atomically with the mutation.

The intent execute becomes the **sole** carrier of persistence for
this op. The dashboard's client-side apply-then-`PATCH` for the same
approved op is **removed**, and the builder reloads from the server
instead.

This removal is not optional. If both the handler and the dashboard
apply the op, it lands twice — an `insert` adds two nodes. `draftRevision`
would make the second write fail with 409 rather than duplicate, but
relying on a conflict error to prevent a double-apply is a latent bug,
not a design.

### D2 — Optimistic concurrency on the draft

Add a monotonic `draftRevision` integer column to `paywalls`. Every
draft write submits the revision it expects; a mismatch is rejected
with **409** and no write occurs. "Every" includes the builder's
autosave — an exempt writer would defeat the mechanism entirely.

`updatedAt` was considered as an etag and rejected: unrelated updates
touch it, and timestamp granularity makes it fragile. A monotonic
counter says what it means.

**No merge on conflict.** Merging component trees is a separate
problem with its own failure modes. The builder receives 409, reloads,
and the user sees the current state.

### D3 — Reconcile authorization onto capabilities

Define two capabilities and route every paywall/funnel **mutation**
path through `assertProjectCapability`. Read routes are unchanged.

| Capability | Roles | Why these roles |
|---|---|---|
| `funnels:write` | OWNER, ADMIN, DEVELOPER, GROWTH | Exactly the set today's DEVELOPER **rank** gate admits. Nobody loses access; the same policy is restated as a set instead of a rank. |
| `paywalls:write` | OWNER, ADMIN, DEVELOPER | Today's `products:write` set, which is what `PATCH /paywalls/:id` already enforces. |

`paywalls:write` **widens** the intent path (from the ADMIN rank
workaround to include DEVELOPER). This is deliberate: the REST route
carries the real product policy, and the ADMIN rank was a compromise
forced by the rank system, as its own comment documents.

`funnels:write` applies to funnel mutation routes — create, patch,
publish, duplicate, revert, delete. Funnel read routes keep their
current gate.

**Deliberately not changed:** GROWTH can author a whole funnel — which
contains a paywall step and takes payments — but cannot edit a single
paywall. Faithful translation preserves this asymmetry. It is a real
product inconsistency and it is recorded here as a **product question**,
not silently fixed. It will become more visible once agents can author,
because an agent takes the path of least resistance.

### D4 — Per-type funnel page validation, at publish time

Per-type rules join `validateFunnelGraph` in
`packages/shared/src/funnel/`, and run where it already runs: **at
publish** (`funnels.ts`, inside `POST /:funnelId/publish`), not at save.

Rationale:

- Save stays permissive, so work-in-progress drafts — human or agent —
  are never blocked mid-edit.
- Publish fails loudly with actionable, per-page errors, which is
  exactly the feedback loop an agent needs.
- Existing saved drafts are not retroactively rejected, which removes
  most of the migration risk.

One real risk remains: an **already-published** funnel that does not
satisfy the new rules will be blocked when its owner next republishes.
See M1.

---

## Migration and rollout

**M1 — Measure before shipping.** After the per-type rules are written,
dry-run them against every published funnel in the database and record
how many fail and why. This is a measurement whose result belongs in
this document before D4 ships — not an estimate. If the count is
non-trivial, the rules ship behind a report-only mode first.

**M2 — `draftRevision` backfill.** New column, default 0, backfilled
for existing rows. Writers that do not send an expected revision are
rejected rather than defaulted, so an un-migrated client fails closed
instead of clobbering.

**M3 — Migration placement.** Every new Drizzle migration in this repo
has historically landed *below* the journal watermark and been silently
skipped on upgrade-path databases. The migration adding `draftRevision`
must be checked against the journal's current watermark before it is
considered done.

---

## Testing

The repo has a history of tests that confirm themselves, so what needs
real infrastructure is stated up front.

1. **409 race — real Postgres (testcontainer).** Two concurrent
   writers; exactly one wins, the loser gets 409. A mocked-transaction
   test asserting "it rolled back" proves nothing here.
2. **Authorization matrix.** Table-driven over role × operation,
   pinning the exact permitted set for both capabilities.
3. **Structural authorization guard.** A test asserting that *every*
   paywall/funnel mutation route passes through the capability gate —
   derived from the router, not from a hand-maintained list, so a route
   added next month cannot silently bypass it.
4. **Draft never reaches live traffic.** After a draft edit,
   `/v1/placements` still serves the published snapshot. This is the
   invariant the whole design rests on; it gets pinned.
5. **Per-type funnel validation at publish.** Table-driven per page
   type. Plus, deliberately, a test asserting that saving an invalid
   page still **succeeds** — permissive save is a chosen property, and
   without a test someone will later "fix" it.
6. **Audit atomicity — real Postgres.** A failed mutation leaves no
   audit row.

---

## Out of scope

- Anything MCP. Transport, tokens, tool surfaces: sub-projects A and C.
- Merging concurrent paywall drafts.
- Moving funnel **read** routes into the capability system.
- Resolving the GROWTH funnel-vs-paywall asymmetry (recorded as a
  product question in D3).
- The `action_paywall_create` tool itself — this spec opens the write
  path; the tool that uses it belongs to C.

---

## Findings recorded along the way (not this spec's work)

Both surfaced while reading the intent layer and are worth their own
triage:

1. `intent-handlers.ts`'s header comment marks
   `action.subscriptions.cancel`, `action.subscriptions.refund` and
   `action.subscribers.transfer` as **STUB**. If still accurate, the
   Copilot advertises refund and cancel tools whose handlers do
   nothing. The comment is a "worktree base" discovery summary, so it
   must be verified against the handlers as they stand today before
   anyone acts on it.
2. `action.experiments.stop` only sets status to `COMPLETED`. The
   dashboard's stop-with-winner flow also repoints placements. Two
   paths to "stop an experiment" may therefore carry different side
   effects.

---

## Open questions

- **M1's number.** Unknown until measured; blocks D4's rollout shape.
- **What `assertSaveValid` actually guarantees.** D1 makes it the
  correctness gate for writers that are not the dashboard builder, so
  its coverage matters more after this spec than before it. It is
  schema parse + `assertUrlSchemes` + the *blocking* subset of
  `validateBuilderConfig`. Two things are unresolved:
  - Whether the blocking set covers the **three-platform decoder
    contract** (`packages/shared/src/paywall/render-fixtures.json`).
    A tree that renders on web but not in SwiftUI or Android Views
    would be a bad thing to let a non-dashboard writer persist.
  - It is called as
    `validateBuilderConfig(parsed.data, { offeringPackageIds: [] })` —
    an **empty** id set. Package-reference checks therefore run against
    nothing. Tolerable when a human picked the packages in the builder;
    not tolerable for a generated tree that can reference a package the
    offering does not contain.

  Both must be answered before C ships. If either gap is real, closing
  it belongs in B, because B is what opens the door.

- **Scope of `funnels:write`.** Applied here to funnel mutation routes.
  A narrower reading — only the routes agent authoring needs — is
  possible; this spec takes the broader one because leaving some funnel
  mutations on the rank gate re-creates the two-gate problem inside a
  single resource.
