# P7 — A/B from the Builder (design)

**Date:** 2026-07-28
**Phase:** P7 of the paywall-builder gap-analysis plan (`2026-07-23-paywall-builder-gap-analysis.md` §7, endpoint §6.19).
**Status:** Approved design. Feeds an implementation plan.

## 1. Scope decisions

1. **Element-level A/B stays deferred** (user decision 2026-07-28, re-affirming §8 decision 6 at its "revisit once P0–P6 are live" checkpoint). The popover ships with PAYWALL live and ELEMENT visibly disabled ("coming soon") — the entry point is the valuable part. Consequence: **zero SDK-wire, zero shared-schema, zero renderer changes; no wave-C gate anywhere in P7.**
2. **Variant B source: duplicate OR pick existing** (user decision). "Duplicate this paywall" is the primary affordance; an existing-paywall picker is the cheap secondary.
3. **The popover repoints a placement row** (user decision) — this is what makes it a *launch* rather than a form shortcut.
4. **Audience: Everyone default + dropdown** (user decision) — `experiments.audienceId` is NOT NULL, so the popover finds-or-creates an "Everyone" audience when none is chosen.

## 2. Context facts the design builds on (verified 2026-07-28)

- Experiments engine is complete: `experimentType` enum already contains `PAYWALL` **and `ELEMENT`** (enums.ts:107-112 — the deferred kind has a reserved value); variants are jsonb `{ id, name, value, weight }` with shared-schema refinements (≥2 variants, Σweights=1, no zero weight); PAYWALL variant `value` must be exactly `{ paywallId }` belonging to the project (`assertPaywallVariantsValid`, experiments.ts:46-82). `key` is server-assigned and is the bucketing seed.
- Placement walk (placement-resolution.ts:162-212) serves an experiment only when `type === "PAYWALL" && status === "RUNNING"`; variants whose paywall is missing/inactive/**unpublished** are dropped; all-dropped → the row is skipped. So: **a builder-launched A/B serves only when both paywall rows are published and the experiment is RUNNING** — and **stopping an experiment can dark a placement** whose only row targets it.
- Client-side draw is `(subscriberId, experiment.key)` via the shared bucketing contract — untouched by P7.
- Creating a paywall A/B today takes two disconnected pages: the 1572-line `/experiments/new` form, then a manual placement re-point. The popover collapses both.
- `top-bar.tsx` (354 lines) has an established `onOpenX` prop pattern from builder-shell; the VM already exposes `projectId`, `paywall`, `publishedVersionId`, `status`. Wave C is fully committed; no dirty overlap.

## 3. API

### 3.1 `POST /dashboard/projects/:projectId/paywalls/:id/experiments` (§6.19)

One atomic orchestration endpoint (dashboard-auth + `assertProjectCapability(projectId, userId, "experiments:write")`). Body (Zod):

```ts
{
  name: string,                    // experiment name; key stays server-assigned
  variantB:
    | { kind: "existing"; paywallId: string }
    | { kind: "duplicate"; name: string },   // new paywall row's display name
  audienceId?: string,             // absent → find-or-create "Everyone" (§3.2)
  placement?: { placementId: string; rowIndex: number },  // row to repoint (§3.3)
}
```

Inside **one Drizzle transaction**:
1. **Duplicate** (when `kind: "duplicate"`): insert a new `paywalls` row copying `builderConfig`, `remoteConfig`, `offeringId`, `configFormatVersion` from paywall A; fresh cuid2 id + derived unique identifier (slugified name with numeric suffix on collision); `status: "draft"`, `publishedVersionId: null`, `isActive: true`. It is deliberately **unpublished** — the author edits then publishes it.
2. **Create the experiment** as `DRAFT`, `type: PAYWALL`, variants `[{ id: "a", name: <paywall A name>, value: { paywallId: A }, weight: 0.5 }, { id: "b", …B…, weight: 0.5 }]` — through the same shared-schema validation + `assertPaywallVariantsValid` + server-assigned-key path the existing `POST /dashboard/experiments` uses (extract that route's core into a service function both routes call; no logic fork).
3. **Repoint** (when `placement` given): load the placement, assert `rows[rowIndex]` currently targets `{ type: "paywall", paywallId: A }` (409 otherwise — the row changed under the popover), replace the target with `{ type: "experiment", experimentId }`, persist, `purgeProjectCatalogCache`-class invalidation as the placements route does today.
4. `audit()` each mutation inside the tx (duplicate, experiment create, placement update).

Response `{ data: { experiment, createdPaywallId: string | null } }`. Any step failing rolls the whole thing back — no half-launched state.

### 3.2 The "Everyone" audience

`findOrCreateEveryoneAudience(tx, projectId)`: the match-all representation is **`rules = {}`** — `audiences.rules` defaults to `'{}'::jsonb` (schema.ts:1207) and `matchesAudience` returns `true` for a non-object or empty-object rule set (packages/shared/src/experiments/targeting.ts:91-92, sift-based). Match = the project's audiences whose `rules` deep-equals `{}`, preferring one named `Everyone`, else the first; none → insert `{ name: "Everyone", rules: {} }`. Idempotent under the same tx isolation as siblings (accept the same benign race the funnel-parity `nextVersionNo` decision accepted; a duplicate "Everyone" is harmless and mergeable by hand). Name string is a named constant.

### 3.3 Stop-with-winner repoints the placement (the one existing-behaviour change)

In the existing `POST /dashboard/experiments/:id/stop` handler: when the experiment is `type: PAYWALL` **and** `winnerVariantId` is supplied, after marking COMPLETED, rewrite every placement row in the project whose target is `{ type: "experiment", experimentId: <this> }` to `{ type: "paywall", paywallId: <winner's paywallId> }`, in the same tx, audited per placement. Stop **without** a winner keeps today's behaviour (rows left pointing at a COMPLETED experiment → walk skips them) — the popover's status panel warns about this state (§4). No other lifecycle endpoint changes.

## 4. Dashboard

- **TopBar**: a `FlaskConical` icon button between the eligibility toggle and the issues chip; new `onOpenExperiment` prop threaded from `builder-shell.tsx` (the established pattern). Disabled with a tooltip while the paywall has never been published (`publishedVersionId === null`) — variant A must be servable.
- **Popover** (new `experiment-popover.tsx` next to the other builder modals, overlay idiom byte-consistent with diff-modal/localization-modal):
  - **Kind switch**: PAYWALL (active) / ELEMENT (disabled, "coming soon" caption) — §8 decision 6 affordance.
  - Name input (default `"<paywall name> A/B"`).
  - **Variant B**: radio "Duplicate this paywall" (default; name input defaulting to `"<name> (B)"`) | "Use an existing paywall" (select of project paywalls minus A, flagging unpublished ones).
  - **Audience**: select of project audiences with "Everyone (default)" preselected — when the project has no match-all audience the option reads "Everyone (will be created)".
  - **Placement**: rows currently targeting this paywall, listed as "placement identifier · row N" checkboxes-as-radio (exactly one repointable per launch — YAGNI); exactly one → preselected; none → an inline warning "Not attached to any placement — the experiment won't serve until a placement targets it" with a link to placements. Serving-path note copy: "50/50 split — adjust weights later on the experiment page".
  - **Create** → calls §3.1 → on success with a duplicate, offer "Open variant B in the builder" (navigates to the new paywall's builder) plus the checklist state.
  - **Status panel** replaces the form whenever an experiment (DRAFT/RUNNING/PAUSED) already has a variant pointing at this paywall (lookup via existing `GET /dashboard/experiments?projectId=&type=PAYWALL` filtered client-side): name, status chip, per-variant publish state, **prerequisite checklist** (A published ✓/✗, B published ✓/✗, placement attached ✓/✗), a **Start** button (existing `POST /:id/start`) enabled only when all checks pass, links to the experiment page + results. COMPLETED-without-winner while still targeted by a placement row shows the "placement is dark" warning from §3.3.
- No weight editing, no metrics config, no multi-experiment management in the popover — the experiment page owns all of that.

## 5. Serving-path guarantees (unchanged, relied upon)

`placement-resolution.ts`, the bucketing contract, `/v1/experiments/:id/expose`, presented-context attribution and the results pipeline are **not modified**. The popover only creates rows the existing walk already knows how to serve. The existing walk tests remain the contract; P7 adds no serving tests beyond the stop-repoint route tests.

## 6. Testing

- **API route tests** (pattern: products.store-catalog.test.ts local-mock idiom): atomicity — duplicate-step failure leaves no experiment/paywall (assert via the tx mock); variantB existing vs duplicate; identifier collision suffixing; Everyone find (match-all exists) / create (none) / prefer-named; repoint happy path + 409 when the row no longer targets A; capability gate; stop-with-winner rewrites exactly the rows targeting the experiment (multiple placements, mixed targets) and stop-without-winner touches nothing.
- **Dashboard component tests**: popover create flow (duplicate default, payload shape), disabled-unpublished TopBar state, status-panel branch with prerequisite checklist gating Start, ELEMENT option rendered disabled.
- **No shared/renderer/SDK tests** — nothing there changes.

## 7. Collision + sequencing

Wave C is committed; P7 touches `top-bar.tsx`, `builder-shell.tsx`, a new popover file, `experiments.ts` (stop handler + extracted create service), `paywalls.ts` route file (new sub-route), placements repo helpers, and `en.json` — none in wave C's remaining surface (device-smoke deliverables). **Single-block implementation, no gate.** Standing constraints: current branch only, no worktrees, sequential dispatch, explicit staging (parallel session may reappear), named constants, `t()` English defaults for new copy with keys added in the same task (no wave-B-era en.json restriction remains).
