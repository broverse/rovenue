# Store Lifecycle Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close §6's last item by adding a public event key per distinct subscriber-facing *meaning* — not per raw store event type — which means reinstating two deliberately-excluded mappings with real evidence, and adding the two meanings (`paused`, `recovered`) the catalog lacks.

**Architecture:** The bridge site receives only a bare event-type string today, which is exactly why two rows were excluded. Widen what it receives so the caller can pass the direction/delta it already holds, then map on that evidence. New keys ride machinery that already exists; nothing about the fan-out or the delivery worker changes.

**Tech Stack:** TypeScript (strict), Hono, Postgres/Drizzle outbox, Kafka fan-out, React dashboard, Fumadocs.

**Spec:** `docs/superpowers/specs/2026-09-03-store-lifecycle-normalization-design.md` — read it in full before Task 1. §1.1 (why per-raw-type is the wrong target), §1.3's per-store coverage table, and the non-goals are requirements, not commentary.

## Global Constraints

- **Never create or switch branches or worktrees.** Commit on whatever HEAD is checked out.
- **Never stage** `apps/dashboard/src/components/assets/asset-library.tsx` or `packages/db/seed.ts` — both are dirty for unrelated reasons and must stay that way.
- **Throttle:** `nice -n 19` on every heavy command; vitest `--maxWorkers=2`; suites strictly sequential; run the dashboard suite from inside `apps/dashboard`.
- **`apps/api`'s test suite is two passes**: `vitest run` excludes testcontainer suites; `VITEST_CONTAINER_PASS=1 vitest run` runs them. Any number you report must name which pass it covers.
- **Never infer a lifecycle signal a store does not send.** Recovery for Apple/Stripe would have to be guessed from a renewal after a grace period; a false recovery stops a consumer's dunning campaign. This is the same rule as "country comes from the store, never the device".
- **No migration, no fan-out change, no new provider, and no existing key renamed or repurposed.** The event catalog is public API for `CUSTOM_WEBHOOK` consumers; additions are safe, changes are not.
- TypeScript strict. No magic values. No self-confirming tests. Conventional commits.

### Confirmed facts (verified 2026-09-03 — do not re-derive; re-confirm only if something fails)

- **The mapping table** is `packages/shared/src/store-event-normalization.ts`, `STORE_EVENT_TO_PUBLIC_KEY` (`:58`): ten store event types onto four public keys. The comment above it excludes two rows on purpose and names the fix.
- **The key catalog** is `ROVENUE_EVENT_KEYS` in `packages/shared/src/integrations.ts` (12 entries), with subsets `STANDARD_PROVIDER_EVENT_KEYS` (`:103`) and `SUBSCRIPTION_BRIDGE_EVENT_KEYS`. `isRovenueEventKey` is the guard.
- **The second, hand-maintained union** is `RovenueEventType` in `apps/api/src/services/integrations/types.ts:25`. The file carries a deliberate compile-time bridge between the two unions so a spelling drift fails the build — use it, do not route around it.
- **The bridge site**: `WebhookPostProcess` (`apps/api/src/services/webhook-processor.ts:78`) whose ctx carries `eventType: string` (`:80`); `EnqueueOutgoingWebhookArgs` (`:303`) likewise; the mapping happens at `:353` — `isRovenueEventKey(args.eventType) ? args.eventType : STORE_EVENT_TO_PUBLIC_KEY[args.eventType]`.
- **Callers**: `apple-webhook.ts:234` and `google-webhook.ts:185`. Apple's direction is known inside `applyRenewalStatusChange` (`apple-webhook.ts:456`) via `ctx.renewalInfo?.autoRenewStatus`, and is currently used only to set a column.
- **Provider mapping tables** in `apps/api/src/services/integrations/event-mapping.ts`: `ANALYTICS_DEFAULT_EVENT_NAMES` (`:36`) and a per-provider override map (`:219`), plus two derived tables — **all typed `Partial<Record<RovenueEventKey, string>>`**, so a missing key is not a type error and silently yields no event.
- **Dashboard picker**: `apps/dashboard/src/components/apps/integration-drawer/step-events.tsx:3` imports `ROVENUE_EVENT_KEYS` directly, so new keys appear automatically but need i18n labels. `en.json` has no missing-key handler.
- **Docs**: every provider page carries a per-key table (`apps/docs/content/docs/integrations/adjust.mdx:52`, `amplitude.mdx:50`, …).
- **Store reality**: Apple has no pause and no recovery notification. Google emits `SUBSCRIPTION_PAUSED` and `SUBSCRIPTION_RECOVERED`. Stripe has a `paused` status (`stripe-types.ts:99`) and no native recovery signal.

---

## Task 1: Enumerate what each handled store event already carries — before anything is added

**Files:** none modified. Deliverable is a report.

**Interfaces:**
- Produces: the table Task 3 uses to justify NOT adding keys. If the spec's claim that renewals and refunds already reach consumers is false, this is where that surfaces.

- [ ] **Step 1: List every store event type the webhook processor handles**, per store — Apple notification types, Google named RTDN types, Stripe event types.
- [ ] **Step 2: For each, record which public key carries its meaning to consumers today**: `revenue.event.recorded`, an existing subscription key, or **nothing**.
- [ ] **Step 3: Trace, do not assume.** A renewal is claimed to reach consumers via `revenue.event.recorded` — follow the code and confirm it. The spec uses this claim as the reason not to mint per-type keys, so it has to be true.
- [ ] **Step 4: Report every event that carries NO meaning to consumers.** Each is a finding: either it needs a key, or it needs one sentence saying why its meaning does not belong in the integration stream. Do not add keys — that is Task 3's decision, informed by this.
- [ ] **Step 5: Change no code.** Report only.

---

## Task 2: Thread the evidence, then reinstate the two excluded rows

**Files:**
- Modify: `apps/api/src/services/webhook-processor.ts`, `apps/api/src/services/apple/apple-webhook.ts`, the Stripe webhook handler
- Modify: `packages/shared/src/store-event-normalization.ts`
- Test: alongside each

- [ ] **Step 1: Read the exclusion comment in full first** (`store-event-normalization.ts`, above `STORE_EVENT_TO_PUBLIC_KEY`). It states exactly why each row was left out and what would justify reinstating it. You are meeting that standard, not overriding it.
- [ ] **Step 2: Widen the bridge's input** so a caller can pass the disambiguating fact alongside the event type. Keep it optional: the other callers pass a bare type today and must keep compiling and behaving identically.
- [ ] **Step 3: Apple — pass the direction.** `applyRenewalStatusChange` already reads `ctx.renewalInfo?.autoRenewStatus`. Thread it through. Map `DID_CHANGE_RENEWAL_STATUS` to `subscription.uncancelled` **only when auto-renew was turned back ON**, and to nothing otherwise.
- [ ] **Step 4: Stripe — compare against the stored prior value.** The handler currently writes `autoRenewStatus: !subscription.cancel_at_period_end` unconditionally. It must compare with what is stored and pass whether the flag actually flipped. **If that prior value is not reachable at the handler without a wider refactor, stop and report it** — leaving the row out with a reason is an acceptable, spec-sanctioned outcome. Do not guess.
- [ ] **Step 5: Prove no double-mapping.** The exclusion comment's stated risk is one real-world event arriving under two public keys. Write a test that drives a real cancel end-to-end and asserts **exactly one** lifecycle key is emitted — not a test that reads the mapping table.
- [ ] **Step 6: Test both directions** of the Apple row: ON produces `subscription.uncancelled`, OFF produces no lifecycle key.
- [ ] **Step 7: Commit** `feat(integrations): reinstate the two lifecycle mappings with real evidence`.

---

## Task 3: Add `subscription.paused` and `subscription.recovered`

**Files:**
- Modify: `packages/shared/src/integrations.ts`, `packages/shared/src/store-event-normalization.ts`
- Modify: `apps/api/src/services/integrations/types.ts`, `event-mapping.ts`
- Test: alongside each

- [ ] **Step 1: Add both keys to `ROVENUE_EVENT_KEYS`, `SUBSCRIPTION_BRIDGE_EVENT_KEYS` and `RovenueEventType`.** The compile-time bridge between the two hand-maintained unions must still pass — that guard exists because a rename on either side used to make a cast silently wrong.
- [ ] **Step 2: Map only what the stores natively send.** Google `SUBSCRIPTION_PAUSED` → `subscription.paused`; Google `SUBSCRIPTION_RECOVERED` → `subscription.recovered`; Stripe's paused status → `subscription.paused` if a native signal exists at the handler. **Apple gets neither, and Stripe gets no recovery** — do not infer them from a renewal after a grace period. A false recovery stops a consumer's dunning campaign.
- [ ] **Step 3: Add both keys to the provider mapping tables.** Every table is `Partial<Record<RovenueEventKey, string>>`, so a missing key is **not** a type error — it silently produces no event for that provider.
- [ ] **Step 4: Write the guard that makes Step 3 checkable.** A test that fails when a provider whose `eventCatalog` claims a key has no name for it in its mapping table. This is the deliverable that stops the next key from going missing; adding rows by hand and trusting review is what the `Partial` type makes unsafe.
- [ ] **Step 5: Prove it end to end**, not at the mapping table. A Google `SUBSCRIPTION_PAUSED` and a `SUBSCRIPTION_RECOVERED` must each produce their key through the bridge, with the same dedup identity the existing bridge keys use.
- [ ] **Step 6: Comment `subscription.recovered` against `revenue.event.recorded`.** A recovery usually coincides with a successful renewal charge; they are different facts — one is money, one is a state transition out of billing trouble — and a consumer stopping a dunning campaign needs the second. Say so at the key so nobody later "deduplicates" them.
- [ ] **Step 7: Commit** `feat(integrations): subscription.paused and subscription.recovered`.

---

## Task 4: The two consumer-facing surfaces

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Modify: `apps/docs/content/docs/integrations/*.mdx`
- Test: alongside the dashboard change

- [ ] **Step 1: i18n labels for both new keys.** The picker (`step-events.tsx`) reads `ROVENUE_EVENT_KEYS` directly, so the keys already appear — without labels they render as raw key paths, a defect this repo has shipped before.
- [ ] **Step 2: Grep the finished picker for `t("` and confirm every key resolves.** Say in your report that you did; do not check by eye.
- [ ] **Step 3: Add both keys to every provider doc page that lists the event catalog.** The catalog is public API for `CUSTOM_WEBHOOK` consumers, so a key in code and not in docs is an undocumented API addition.
- [ ] **Step 4: Document the per-store coverage** — the table from spec §1.3. A consumer must be able to learn from the docs that recovery arrives for Google subscribers only, rather than inferring it from silence. This is the same honesty §5 applied to the country dimension.
- [ ] **Step 5: Avoid bare `{{var}}` in MDX** — it breaks the prerender.
- [ ] **Step 6: Commit** `docs(integrations): document the two new lifecycle keys and their coverage`.

---

## Task 5: ROADMAP and the battery

**Files:** `ROADMAP.md`

- [ ] **Step 1: Rewrite §6's remaining item to state the principle** — a public key per distinct subscriber-facing meaning, not per raw store event type — so the next reader does not pursue raw-type passthrough. Record what was reinstated and on what evidence, what was added, and what Task 1's enumeration found.
- [ ] **Step 2: State the per-store coverage limit** for the two new keys in the ROADMAP too, not only the docs.
- [ ] **Step 3: If Task 2 left the Stripe row out**, record that as a known gap with its reason rather than as an oversight.
- [ ] **Step 4: Update §6's score and the table's header date.**
- [ ] **Step 5: Battery**, sequential and throttled, real numbers, **naming which api pass each covers**: `nice -n 19 pnpm build --concurrency=2`; `@rovenue/shared`; the dashboard suite from inside `apps/dashboard`; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`; then `VITEST_CONTAINER_PASS=1`. Known-good baselines: api non-container 420 files / 3641 tests, api container 12 files / 84 tests, dashboard 130 files / 1161 tests, shared 44 files / 842 tests, build 9/9. `pnpm --filter @rovenue/docs check:links` already exits 1 on the pre-existing `reference/methods.mdx → /docs/guides/funnel-attribution` link — report it, do not fix it here.
- [ ] **Step 6: Commit** `docs: ROADMAP §6 close-out` with the battery numbers in the body.

---

## Self-review notes (for executors)

- **Task 1 gates Task 3's restraint.** Its enumeration is the evidence for *not* minting a key per raw event type. If it finds an event carrying no meaning to consumers, that is a real finding — but the default answer is still a sentence explaining why, not a new key.
- **The `Partial` on the provider tables is the sharpest hazard in this plan.** A missing key compiles, ships, and silently sends nothing. Task 3 Step 4's guard is the deliverable that matters most.
- **Never infer recovery.** Apple and Stripe send no such signal, and a guessed one would stop a consumer's dunning campaign on a subscriber who has not actually recovered.
- Reinstating a mapping row without the evidence that disambiguates it would reproduce exactly the misclassification the exclusion comment refused. Meeting that bar is the task; lowering it is not.
