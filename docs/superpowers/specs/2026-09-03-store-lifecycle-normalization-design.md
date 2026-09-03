# Store-Native Lifecycle Normalization — A Key Per Meaning, Not Per Event Type

**Date:** 2026-09-03
**Roadmap area:** §6 Third-party integrations (90 → 95) — the single remaining item
**Scope:** narrow, as the roadmap itself says. Two documented exclusions to reinstate, two
missing meanings to add, and one framing to correct.

---

## 1. Context — what reconnaissance found

### 1.1 The item asks for the wrong thing

§6's remaining line reads: *"raw Apple/Google/Stripe event types → the public event-key
catalog end to end (currently only the 4 keys above are mapped; most raw event shapes still
pass through only partially normalized)"*.

Taken literally, that means a public key per raw store event type. Measured against the
code, that target is wrong, and pursuing it would make the product worse.

Apple emits ~14 notification types, Google ~15 named RTDN types, Stripe dozens. Most of them
**already reach integration consumers** — through `revenue.event.recorded` (a renewal, a
refund and a revoke all produce revenue events), through `subscription.cancel_requested`, or
through `subscription.expired`. Minting a second key for `DID_RENEW` would deliver every
consumer two events for one real-world thing, and the fan-out is at-least-once, so
deduplicating them would become the consumer's problem.

**The right unit is a distinct subscriber-facing meaning, not a raw event type.** Measured
that way, the gap is small and specific.

### 1.2 What is mapped today, and the two rows deliberately left out

`packages/shared/src/store-event-normalization.ts` holds `STORE_EVENT_TO_PUBLIC_KEY`: ten
store event types onto four public keys (`subscription.billing_issue`, `grace_period`,
`uncancelled`, `product_changed`), across all three stores.

Above it sits a long comment excluding two rows **on purpose**, and its reasoning is exact:

- **Apple `DID_CHANGE_RENEWAL_STATUS`** fires for both re-enabling auto-renew (which would
  be `subscription.uncancelled`) and turning it off. `apple-webhook.ts`'s
  `applyRenewalStatusChange()` *does* read the direction from
  `ctx.renewalInfo?.autoRenewStatus` — but that value only updates a column. It is never
  threaded through `postProcess({ eventType })`, which always carries the bare notification
  type string.
- **Stripe `customer.subscription.updated`** fires on any field change, and only a
  `cancel_at_period_end` flip is a lifecycle signal. The bridge site likewise receives only
  the bare `event.type`; the before/after delta never reaches it.

The comment ends: *"If a future task threads the subtype/delta through to the bridge site,
these two rows can be reinstated with real evidence backing them."* **This spec is that
task.** The exclusions were never a coverage failure — they were accuracy over coverage, and
the fix is named in the code.

### 1.3 Two meanings the catalog genuinely lacks — with asymmetric store coverage

`ROVENUE_EVENT_KEYS` has twelve entries. Checked against what the subscription state machine
and the stores actually express, two meanings have no key at all:

- **Paused.** `PAUSED` is a real state in the subscription enum
  (`packages/db/src/drizzle/enums.ts:52`) and Google emits `SUBSCRIPTION_PAUSED`. A
  subscriber pausing is invisible to every integration.
- **Recovered.** Google emits `SUBSCRIPTION_RECOVERED` — a billing issue resolved itself and
  the subscription is healthy again. Today a consumer sees `subscription.billing_issue` and
  then silence, so a dunning or win-back campaign has no signal to stop on. This is the more
  valuable of the two: an integration that can start a recovery flow but never learns it
  succeeded will keep chasing a subscriber who already paid.

**Neither key can fire for every store, and the spec must say so rather than imply parity.**
Checked against the handlers:

| key | Apple | Google | Stripe |
|---|---|---|---|
| `subscription.paused` | **no such notification** — Apple has no pause concept | `SUBSCRIPTION_PAUSED` | a `paused` status exists (`stripe-types.ts:99`) |
| `subscription.recovered` | **no native signal** | `SUBSCRIPTION_RECOVERED` | **no native signal** |

For Apple and Stripe, "recovered" could only be *inferred* — a `DID_RENEW` following a grace
period, an `invoice.paid` following a `payment_failed`. **Do not infer it.** This codebase
has refused exactly this shape of inference before: country comes from the store and never
from a device attribute, and currency is never fabricated. An inferred recovery that fires
on an unrelated renewal is worse than no event, because a consumer would stop a dunning
campaign on it.

So both keys ship with **documented partial coverage**, the same way §5's country dimension
did. A consumer must be able to learn from the docs that recovery signals arrive for Google
subscribers only.

### 1.4 The shape

§6's remainder is not "normalize everything". It is: **reinstate two rows the code already
knows how to justify, add two meanings the catalog is missing, and correct a roadmap line
that asks for something we should not build.**

## 2. Goals

1. Thread the direction/delta to the bridge site so Apple `DID_CHANGE_RENEWAL_STATUS` and
   Stripe `customer.subscription.updated` map with real evidence rather than a guess.
2. Add `subscription.paused` and `subscription.recovered` to the public catalog and map the
   store events that carry those meanings.
3. Confirm — by enumeration, not assumption — that every other handled store event already
   reaches consumers through an existing key, and record the result.
4. Correct §6's roadmap line to describe a key per meaning rather than per raw event type.

## 3. Non-goals

- **No key per raw store event type.** See §1.1. This is the item's stated ask and the spec
  rejects it deliberately.
- **No change to the fan-out, the deliver worker, or any provider's transport.** New keys
  flow through machinery that already exists and is registry-driven.
- **No new provider.** §6's provider breadth is done; fourteen ship.
- **No change to the subscription state machine.** `PAUSED` already exists; this exposes it,
  it does not redefine it.
- **No retroactive emission.** Events that already happened stay unemitted; the outbox is
  forward-only and backfilling lifecycle events would deliver a consumer a burst of history
  it cannot distinguish from live traffic.

---

## 4. Design

### 4.1 Thread the evidence, then reinstate the rows

The bridge site (`webhook-processor.ts`'s `postProcess`) receives `{ eventType }` as a bare
string. Widen what it receives so the caller can pass the disambiguating fact it already
holds:

- Apple: `applyRenewalStatusChange()` knows `autoRenewStatus`. Pass it.
- Stripe: the handler writes `autoRenewStatus: !subscription.cancel_at_period_end`
  unconditionally — it must instead compare against the stored prior value and pass whether
  the flag actually flipped.

Then `STORE_EVENT_TO_PUBLIC_KEY` gains the two rows, resolved by that evidence rather than
by the event type alone.

**Neither reinstated row may double-map.** The excluded comment names this risk directly:
turning auto-renew OFF is already carried by `subscription.cancel_requested`, so mapping
`DID_CHANGE_RENEWAL_STATUS` in that direction would deliver one real-world event under two
public keys. The same question has to be asked of the Stripe row against
`cancel_requested` and `product_changed`. Prove the absence of a double-map with a test that
drives a real cancel and asserts exactly one lifecycle key is emitted — not by reading the
mapping table.

**Do not reinstate a row without its evidence.** The excluded comment's judgment — accuracy
over coverage — is the standard this work has to meet, not an obstacle to route around. If
the Stripe delta turns out not to be reachable at the handler, report that and leave the row
out; a row that misclassifies half its deliveries is worse than no row.

### 4.2 Two new keys, added the way the last two were

`subscription.paused` and `subscription.recovered` join `ROVENUE_EVENT_KEYS`, then:

- `SUBSCRIPTION_BRIDGE_EVENT_KEYS`, so the fan-out consumer's envelope builder accepts them;
- `RovenueEventType` in `services/integrations/types.ts` — the file carries a compile-time
  bridge between the two hand-maintained unions precisely so a spelling drift fails the
  build. Use it rather than working around it;
- the mapping tables in `event-mapping.ts`. **Corrected during the audit:** this is not
  fourteen hand-edited tables. There is one shared `ANALYTICS_DEFAULT_EVENT_NAMES` (`:36`)
  and one per-provider override map (`:219`), plus two derived tables — and every one of
  them is typed `Partial<Record<RovenueEventKey, string>>`.

  **That `Partial` is the risk, and it is worse than the count I first wrote.** A missing key
  is not a type error; it silently produces no event for that provider. So the guard cannot
  be "remember to add rows" — it must be a test that fails when a provider's catalog claims
  a key it has no name for. See §6.

**The event-key catalog is public API for `CUSTOM_WEBHOOK` consumers.** Adding a key is
additive and safe; renaming or repurposing one is not, and nothing here does either.

### 4.2b The two surfaces a new public key also has to reach

Adding a key to `ROVENUE_EVENT_KEYS` is not the end of it. Two consumer-facing surfaces read
that catalog and were missing from this spec's first draft:

- **The integration drawer's event picker** (`apps/dashboard/src/components/apps/
  integration-drawer/step-events.tsx`) imports `ROVENUE_EVENT_KEYS` directly, so new keys
  appear in the picker automatically — but they need **i18n labels**. `en.json` has no
  missing-key handler, so an absent label renders as the raw key path, a defect this repo
  has shipped before.
- **The provider docs.** Every provider page carries a per-key mapping table
  (`apps/docs/content/docs/integrations/adjust.mdx:52`, `amplitude.mdx:50`, and the rest).
  The event catalog is public API for `CUSTOM_WEBHOOK` consumers, so a key that exists in
  code and not in the docs is an undocumented API addition. The per-store coverage table
  from §1.3 belongs here too — this is where a consumer would look to learn that recovery
  fires for Google only.

### 4.3 Enumerate what remains unmapped, and prove it is already covered

For every store event type the webhook processor handles, record which public key carries
its meaning to consumers today — `revenue.event.recorded`, an existing subscription key, or
nothing.

This is a deliverable, not a formality. §1.1's claim that renewals and refunds "already
reach consumers" is the justification for *not* adding keys, so it has to be true. Any event
the enumeration finds carries no meaning to consumers at all is a finding: either it needs a
key, or it needs a sentence saying why its meaning does not belong in the integration
stream.

### 4.4 Correct the roadmap line

§6's item should say what the right target is, so the next reader does not pursue raw-type
passthrough. Record the principle (a key per meaning), the two reinstated rows and their
evidence, the two new keys, and the enumeration's result.

---

## 5. Data changes

**None.** New event keys are string constants in shared code and rows in mapping tables.
The outbox, the fan-out topics and the delivery worker are unchanged. No migration.

## 6. Risks and decisions worth stating

- **A new key that no provider maps is invisible.** Fourteen provider tables must each gain
  a row, and the compile-time union bridge does not check provider tables — only the two key
  unions. Whatever guards the tables must be a test, and if none exists this work should add
  one rather than trusting fourteen hand edits.
- **The Stripe delta may not be reachable** at the handler without a wider refactor. That is
  an acceptable outcome, reported, not worked around.
- **`subscription.recovered` overlaps `revenue.event.recorded`** in time: a recovery usually
  coincides with a successful renewal charge. They are different facts — one is money, one
  is a state transition out of billing trouble — and a consumer wanting to stop a dunning
  campaign needs the second. State this at the key so nobody later "deduplicates" them.
- **At-least-once delivery** means consumers may see a lifecycle key twice. That is
  pre-existing and documented; the new keys inherit it and must carry the same dedup
  identity as the existing bridge keys.

## 7. Acceptance criteria

1. Apple `DID_CHANGE_RENEWAL_STATUS` maps to `subscription.uncancelled` only when the
   threaded `autoRenewStatus` says auto-renew was turned back ON, and to nothing otherwise —
   proven by a test for each direction.
2. Stripe `customer.subscription.updated` maps to a lifecycle key only when
   `cancel_at_period_end` actually flipped, compared against the stored prior value — or the
   row stays out with a reported reason.
3. `subscription.paused` and `subscription.recovered` exist in `ROVENUE_EVENT_KEYS`,
   `SUBSCRIPTION_BRIDGE_EVENT_KEYS` and `RovenueEventType`, and the compile-time bridge
   between the two unions still passes.
4. A test fails when a provider whose `eventCatalog` claims a key has no name for it in its
   mapping table. The tables are `Partial`, so a missing key is not a type error — it
   silently produces no event, and only a test can catch that.
5. Google `SUBSCRIPTION_PAUSED` and `SUBSCRIPTION_RECOVERED` produce the new keys end to
   end, asserted through the bridge rather than at the mapping table alone.
6. The enumeration from §4.3 exists in the report: every handled store event type, and the
   public key that carries its meaning today.
7. No migration, no fan-out change, no provider added, and no existing key renamed or
   repurposed.
8. ROADMAP §6 states the key-per-meaning principle and records what was reinstated, what was
   added, and what the enumeration found.
9. Both new keys have i18n labels in the integration drawer's picker, verified by grepping
   the finished component against `en.json` rather than by eye.
10. Every provider doc page that lists the event catalog gains the two keys, and states the
    per-store coverage — recovery for Google only — so a consumer can learn the limit from
    the docs rather than from silence.
11. Reinstating either excluded row emits exactly ONE lifecycle key for a real cancel,
    proven by a test rather than by reading the mapping table.
12. Neither `subscription.recovered` nor `subscription.paused` is ever inferred for a store
    that has no native signal for it.
