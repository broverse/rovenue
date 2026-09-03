# Store Integrations Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three of §1's six items — give a customer whose card failed a way to fix it, stop an unknown Stripe status granting entitlement, model Apple external purchases without fabricating revenue, and catch Google purchases whose RTDN was lost.

**Architecture:** Three independent subsystems. Nothing here depends on anything else here; they are ordered only so the riskiest measurement (the fail-open count) happens before the change that acts on it.

**Tech Stack:** TypeScript (strict), Hono, Stripe SDK, Google Play Developer API, Postgres/Drizzle, BullMQ.

**Spec:** `docs/superpowers/specs/2026-09-03-store-integrations-completeness-design.md` — read it in full before Task 1. §1.2 (the fail-open), §1.3's narrow Apple scope and the non-goals are requirements, not commentary.

## Global Constraints

- **Never create or switch branches or worktrees.** Commit on whatever HEAD is checked out.
- **Never stage** `apps/dashboard/src/components/assets/asset-library.tsx` or `packages/db/seed.ts`. Do not use `git add -A` on a directory that contains them — stage files by name.
- **Throttle:** `nice -n 19`; vitest `--maxWorkers=2`; suites strictly sequential; run the dashboard suite from inside `apps/dashboard`.
- **`apps/api`'s suite is two passes**: `vitest run` then `VITEST_CONTAINER_PASS=1 vitest run`. Any number reported must name which pass it covers.
- **Never fabricate money.** An external-purchase token has no price attached; a guessed amount corrupts every downstream aggregate.
- **Never infer a store signal that was not sent.** Same rule the lifecycle keys just shipped under.
- **No new store, no dunning campaign engine, no full Apple External Purchase implementation.** See the spec's non-goals.
- TypeScript strict. Zod for API input. No magic values. No self-confirming tests. Conventional commits.

### Confirmed facts (verified 2026-09-03 — do not re-derive)

- **The fail-open**: `mapStripeStatus` (`apps/api/src/services/stripe/stripe-webhook.ts:1130`) maps `active`→ACTIVE, `trialing`→TRIAL, `past_due`/`unpaid`/`incomplete`→GRACE_PERIOD, `incomplete_expired`/`canceled`→EXPIRED, `paused`→PAUSED, and `default: return PurchaseStatus.ACTIVE`.
- **Handled Stripe events** (`services/stripe/stripe-types.ts`): `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `payment_intent.succeeded`, `setup_intent.succeeded`. `invoice.payment_action_required` and `customer.subscription.trial_will_end` are NOT handled.
- **Connected-account resolution** is `requireConnectedStripe` (`apps/api/src/lib/stripe-platform.ts:172`), already used by `routes/public/funnel-payment.ts`. Do not introduce a second way.
- **The v1 (SDK-facing) surface** mounts `apiKeyAuth("any")` and `apiKeyRateLimit()` at `apps/api/src/routes/v1/index.ts:39,43`.
- **Apple external purchase**: `grep -rn "EXTERNAL_PURCHASE"` over `apps/api/src` and `packages/shared/src` returns nothing.
- **Google verification pieces** already exist: `verifyGoogleSubscription` (`services/google/google-verify.ts:30`), `getGoogleAccessToken`, `expireSupersededGooglePurchase`, `mapSubscriptionStateToStatus`. `services/import/verify-store-clients.ts` is the precedent for re-verifying against a store WITHOUT doing subscriber reconciliation.
- **Worker conventions** (`apps/api/src/workers/expiry-checker.ts`): `EXPIRY_QUEUE_NAME` const, `runExpiryCheck`, `getExpiryQueue`, `scheduleExpiryCheck`, `createExpiryWorker`, wired in `index.ts`. Queue names must be unique — a shared name is the known cause of main's flaky integration tests.
- **The lifecycle-key surfaces** a new public key must reach, from the §6 work: `ROVENUE_EVENT_KEYS` and `SUBSCRIPTION_BRIDGE_EVENT_KEYS` (`packages/shared/src/integrations.ts`), `RovenueEventType` (`apps/api/src/services/integrations/types.ts` — a compile-time bridge checks the two agree), the provider tables in `event-mapping.ts`, the coverage guard `event-mapping.catalog-coverage.test.ts`, and the docs tables under `apps/docs/content/docs/integrations/`.

---

## Task 1: Measure the fail-open before changing it

**Files:** none modified. Deliverable is a report.

- [ ] **Step 1: Count subscribers currently in a Stripe status `mapStripeStatus` does not name.** The spec's risk section is explicit: if any exist, they lose entitlement the moment the default changes, and **that finding matters more than the fix**.
- [ ] **Step 2: Say how you counted.** Local dev data is not production, so state what the number represents and what it cannot tell us. A number from an empty database is not evidence — say so plainly rather than reporting a reassuring zero.
- [ ] **Step 3: List the statuses Stripe documents today** against the ones `mapStripeStatus` names, and report any Stripe status that exists and is unmapped. That is the real blast radius, independent of what local data happens to hold.
- [ ] **Step 4: Report. Change no code.**

---

## Task 2: Close the fail-open, and handle two more dunning events

**Files:** `apps/api/src/services/stripe/stripe-webhook.ts`, `stripe-types.ts`, tests alongside.

- [ ] **Step 1: `mapStripeStatus`'s `default` stops returning `ACTIVE`.** An unrecognised status must not grant entitlement. Map it to the most conservative state that does not, and **log the unrecognised value** — the current failure is silent, and a status Stripe adds next year should announce itself.
- [ ] **Step 2: Do not touch the existing mappings.** `past_due`/`unpaid`/`incomplete` → `GRACE_PERIOD` is correct and load-bearing.
- [ ] **Step 3: Handle `invoice.payment_action_required`.** It surfaces the existing `subscription.billing_issue` key — the subscriber does need to act — but what is stored must distinguish it from a hard decline. "Tap to approve" and "your card was declined" are different emails, and a consumer cannot write either one from an undifferentiated billing-issue event.
- [ ] **Step 4: Handle `customer.subscription.trial_will_end`** as a new public key `subscription.trial.will_end`, following the §6 rule: a key per distinct meaning. Take it through **every** surface the §6 work established — both unions, the provider tables, and the coverage guard must pass. Apple and Google send no equivalent, so document the Stripe-only coverage in `outbound-webhooks.mdx`'s per-store table.
- [ ] **Step 5: Test the default branch directly** with a status string Stripe does not currently send, asserting no entitlement is granted and the value is logged.
- [ ] **Step 6: Commit** `fix(stripe): an unknown subscription status no longer grants entitlement`.

---

## Task 3: The billing-portal session endpoint

**Files:** a new route under `apps/api/src/routes/v1/`, tests alongside.

- [ ] **Step 1: Resolve the Stripe customer server-side** from the authenticated subscriber. **A customer id in the request body must be ignored or rejected** — accepting one is an account-takeover primitive, since a portal session grants access to payment data.
- [ ] **Step 2: Use `requireConnectedStripe`** (`lib/stripe-platform.ts:172`) for the connected account, exactly as `routes/public/funnel-payment.ts` does. Do not add a second resolution path.
- [ ] **Step 3: Validate the return URL** against the project's configured domains rather than echoing the request's. Reject an arbitrary URL, and test that rejection — the outbound-webhook SSRF guard exists for the same class of reason.
- [ ] **Step 4: Mount it on the v1 surface**, which already applies `apiKeyAuth("any")` and `apiKeyRateLimit()`. The app is what needs to open the portal, not the dashboard.
- [ ] **Step 5: Test the security properties, not just the happy path.** A body-supplied customer id does not change whose portal opens; an unlisted return URL is rejected; an unauthenticated call fails.
- [ ] **Step 6: Commit** `feat(stripe): SDK-facing billing-portal session endpoint`.

---

## Task 4: Apple external purchase — model the event, name the gap

**Files:** `apps/api/src/services/apple/`, `packages/shared/src/`, a migration, tests alongside.

- [ ] **Step 1: Handle `EXTERNAL_PURCHASE_TOKEN`** as a first-class notification type: record that an external purchase occurred and attach it to the subscriber.
- [ ] **Step 2: Persist it in its own table, not `purchases`.** An external purchase has no store transaction, so it cannot share that table's store-transaction unique index. Key the row by token with the subscriber and the notification's own identifiers.
- [ ] **Step 3: Emit a public event key for it**, through every surface §6 established. **No revenue event and no amount** — Apple did not process the purchase and we have no price. A guessed amount corrupts every downstream aggregate.
- [ ] **Step 4: Check the `outcome.subscriberId` trap.** Two Apple handlers (`applyRenewalStatusChange`, `applyRevoke`) shipped without setting it, and `postProcess` bails without one, so a mapping row alone never fires. Prove your key reaches the **outbox**, not just the mapping table.
- [ ] **Step 5: Document what is NOT implemented** — the External Purchase Server API, token reporting deadlines, commission accounting — and state that handling was verified against the documented payload shape, **not against Apple**, because this repo has no external-purchase entitlement. Shipping untestable integration code while implying it was exercised is how the `revenuecat_google_token` preset became detectable-but-never-importable.
- [ ] **Step 6: Commit** `feat(apple): model external-purchase notifications without fabricating revenue`.

---

## Task 5: The Google reconciliation sweep

**Files:** `apps/api/src/workers/google-reconciliation.ts` (new), `apps/api/src/index.ts`, a migration, tests alongside.

- [ ] **Step 1: Add the last-reconciled timestamp** to purchases — nullable, defaulting to null, where null means "never checked" and sorts first.
- [ ] **Step 2: Reuse `verifyGoogleSubscription` and `mapSubscriptionStateToStatus`.** `services/import/verify-store-clients.ts` is the precedent for calling that layer without doing subscriber reconciliation. A second Google verification path would drift from the first.
- [ ] **Step 3: Bound the work with a stated rule.** Google's API is rate-limited and a project may hold millions of purchases. Select candidates — purchases past expiry but still ACTIVE, and purchases not re-verified within a named interval, oldest first — capped per sweep by a named constant.
- [ ] **Step 4: A correction must flow through the same path a webhook would**: update the purchase, sync entitlements, **and emit the outbox event**. A sweep that fixes the database and skips the outbox leaves every integration consumer holding the old state — the exact asymmetry the §6 work exists to remove.
- [ ] **Step 5: Decide the first-run burst deliberately.** The first sweep can correct every purchase that has drifted since RTDN began, and each emits an event. Either cap it low enough to spread over days, or add an explicit backfill mode that corrects without emitting. **Choose in this task and say why; do not leave it to be discovered in production.**
- [ ] **Step 6: Per-row claims and audit.** Two instances must not process the same purchase — use the claim pattern, not read-then-write. Every transition is audited, attributed to the sweep rather than a user.
- [ ] **Step 7: Count what it found.** A sweep that corrects drift without recording how much cannot answer "is our RTDN delivery healthy?", which is the question that justifies the job.
- [ ] **Step 8: Integration test against a real database**: a purchase Google reports as expired while Rovenue has it ACTIVE is corrected, entitlements sync, and the outbox event lands. Two concurrent sweeps produce one transition.
- [ ] **Step 9: Commit** `feat(google): reconciliation sweep for purchases whose RTDN was lost`.

---

## Task 6: ROADMAP and the battery

**Files:** `ROADMAP.md`

- [ ] **Step 1: Tick the three items** with what actually shipped, including Task 1's fail-open finding and what the reconciliation sweep chose for its first run.
- [ ] **Step 2: State the Apple external-purchase boundary** — what is modelled and what is not — so the next reader does not assume end-to-end support.
- [ ] **Step 3: Update §1's score and the header date.**
- [ ] **Step 4: Battery**, sequential and throttled, real numbers, **naming which api pass each covers**. Known-good baselines: api non-container 423 files / 3653 tests, api container 12 / 84, dashboard 130 / 1161, shared 44 / 846, build 9/9. `check:links` already exits 1 on the pre-existing `funnel-attribution` link — report it, do not fix it.
- [ ] **Step 5: Commit** `docs: ROADMAP §1 update` with the battery numbers in the body.

---

## Self-review notes (for executors)

- **Task 1 gates Task 2.** If subscribers exist in an unmapped status, revoking their entitlement is a production incident, not a fix. Report before changing.
- **The `outcome.subscriberId` trap has now bitten twice** in Apple handlers. Task 4 must assume it applies until proven otherwise — a mapping row is not a delivery guarantee.
- **Task 5's outbox emission is the difference between a fix and a divergence.** Correcting the database silently is worse than not correcting it, because the integrations then disagree with the source of truth and nothing says so.
- The billing-portal endpoint returns a URL granting access to payment data. Treat it as an auth surface.
