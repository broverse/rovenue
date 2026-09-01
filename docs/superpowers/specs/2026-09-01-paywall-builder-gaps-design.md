# Paywall Builder — Two Known Gaps, One Shape

**Date:** 2026-09-01
**Roadmap area:** §3 Paywall builder & native rendering (80 → 95) — the two items marked "known gap"
**Scope:** deliberately small. This closes two defects and removes the mechanism that produced both.

---

## 1. Context

Reconnaissance on 2026-09-01 confirmed both roadmap items are real, and reframed both. Each turned out to be a **symptom of a hand-maintained link that nothing keeps in sync** — and in each case the codebase already contains the structural fix, applied elsewhere.

### Gap 1 — `trialLabelKey` cannot be set as a conditional override

`trialLabelKey` is a `purchaseButton` prop shown instead of `labelKey` while the selected package's trial/intro period is active (`packages/shared/src/paywall/schema.ts:138-144`). It is:

- declared **overridable** — `OVERRIDABLE_PROP_KEYS.purchaseButton` at `schema.ts:455` lists `["labelKey", "trialLabelKey", "background", "labelColor", "border", "cornerRadius"]`;
- honoured by all three renderers (`packages/paywall-renderer/src/nodes.tsx`, sdk-swift's `PaywallViewModelHelpers.swift`/`BuilderConfigModel.swift`, and the Kotlin `paywallui` equivalents);
- editable as a **base** value — the inspector's Binding tab already writes it (`inspector/binding-tab.test.tsx:372`).

But the **override** editor omits it. `inspector/overrides.tsx` builds a hand-written `OverridablePropCombo` union that lists five `purchaseButton.*` combos and not `purchaseButton.trialLabelKey`; a grep for `trialLabelKey` in that file returns zero hits. So the schema says the prop is overridable, three renderers are ready to render the override, and the operator has no way to set one.

**The file documents its own root cause** (`overrides.tsx:53-61`): *"The schema's arrays are typed as plain `readonly string[]` (not literal tuples), so nothing forces this union to stay in sync automatically."* The existing `const exhaustive: never = combo` check at `:362` only proves the switch covers the union — **not that the union covers the schema**. So `trialLabelKey` fell out silently, and the next overridable prop added will fall out the same way.

### Gap 2 — a credential change keeps serving prices fetched with the old credential

`offering-price-resolver.ts` caches resolved Apple/Google prices in Redis for `RESOLVED_PRICE_CACHE_TTL_SECONDS = 900` under `paywall:resolved:{store}:{projectId}:{offeringId}` (`:65-67`). **The key carries nothing derived from the credential.**

The roadmap's "no invalidation" framing is stale — `purgeResolvedPriceCache` exists and fires from `products.ts` and `offerings.ts`, with tests. Enumerating every non-test caller of either purge shows exactly five routes: products, offerings, placements, experiments, paywalls. **`credentials.ts` is not among them**, and its only mutations are `PUT /:store` and `DELETE /:store` (`:163`, `:223`).

So rotating an Apple or Google key, correcting a wrong account, or disconnecting a store leaves the previous account's prices being served for up to fifteen minutes. That is not "the cache is slightly stale" — it is *serving data from an account we may no longer have access to*, while the operator believes they have just fixed something and sees no effect.

**Stripe is already immune, structurally.** `services/stripe/price-resolver.ts:34` keys its cache `cacheKey(accountId, priceId)` — on the connected account. Change the account and the key changes; no purge call is required, and none can be forgotten.

### The shape both share

Both gaps are a **hand-maintained link standing in for a structural guarantee**: a union that must be remembered alongside a schema, and a purge that must be remembered at every mutation site. Both have already failed once. Adding the missing entry to each would fix today's symptom and leave tomorrow's.

## 2. Goals

1. `trialLabelKey` is settable as a conditional override, on all three platforms' existing support.
2. The override editor's coverage of the schema is **enforced at compile time**, so a future overridable prop cannot silently go missing.
3. A credential change stops serving prices fetched with the previous credential.
4. That guarantee is **structural**, not a purge call a future route can forget.

## 3. Non-goals

- **Any other §3 roadmap item.** Node-type parity, the template gallery, element-level experiments and the localization workflow are separate sub-projects. (Recon note for whoever scopes them: `carousel`, `timeline` and `video` already exist in the schema, all three renderers and `render-fixtures.json`, so the node-type item is largely done — only a footer link group appears genuinely absent.)
- **Changing what `trialLabelKey` means or how any renderer draws it.** The three-platform contract is settled; this is builder and cache work only.
- **Reducing the 15-minute TTL.** The TTL is the backstop for prices changing *at the store*, which we cannot observe. It is not the mechanism for credential changes, and shortening it would paper over the real gap.
- **Touching the Stripe resolver**, which is already correct.

---

## 4. Design

### 4.1 Make the override union derive from the schema

Type `OVERRIDABLE_PROP_KEYS`'s arrays as literal tuples (`as const`) so each node type's prop names are a literal union rather than `readonly string[]`. Then derive — or compile-time check — `OverridablePropCombo` from the schema, so that adding a prop to the schema and not to the editor **fails the build**, naming the missing combo.

Two consequences to accept deliberately:

- The existing `never` exhaustiveness check stays; it covers the other direction (a combo in the union with no `case`). Both directions are needed, and neither implies the other.
- The build will fail immediately on `purchaseButton.trialLabelKey`. **That failure is the proof the mechanism works** — it is what the current design could not produce. Capture it before adding the field.

Then add the `trialLabelKey` override field itself, following whatever the Binding tab already does for the base value so the two editors agree on validation and placeholder behaviour.

### 4.2 Key the Apple/Google price cache on the credential

Follow the pattern Stripe already proves: include something credential-derived in the cache key, so a credential change moves the key and the old entries become unreachable and expire on their own.

**Where the credential actually lives** (verified 2026-09-01): not a separate table — `projects.appleCredentials` and `projects.googleCredentials` are encrypted JSONB columns, written by `writeProjectCredential` (`packages/db/src/drizzle/repositories/projects.ts:339-343`) and nulled by its sibling on disconnect.

**The key component is a short digest of the stored encrypted credential blob.** Requirements and the reasoning behind that choice:

- It changes exactly when the credential changes, and never otherwise.
- **`projects.updatedAt` was evaluated and rejected on two independent grounds.** First, it does not work: `writeProjectCredential` sets only the credential column and there is no `$onUpdate` anywhere in the schema, so `updatedAt` is not bumped by a credential write at all. Second, even if it were, it bumps on *any* project edit, so renaming a project would throw away every resolved price for no reason.
- **No migration is needed.** The digest is derived from a column that already exists — which is also why this is the cheaper option.
- **Do not put credential material in a Redis key.** A key is not a secret store and is visible to anyone with Redis access. A one-way digest of the *already-encrypted* blob is not material; say so in a comment so the next reader does not have to re-derive it.
- A **disconnect** must not fall back to the last known key. The column is nulled, so there is no digest and therefore no cached price to serve — which is the correct outcome, not an edge case to handle.
- `purgeResolvedPriceCache` stays. Keying makes credential staleness impossible; the purge remains the right tool for the mutations that already call it (a product's identifiers changing does not change the credential).

### 4.3 What we are explicitly not relying on

Adding a `purgeResolvedPriceCache` call to `credentials.ts` would fix today's bug and leave the mechanism intact — the next route that touches credentials would have to remember, and the evidence is that call sites do get forgotten: five routes remembered, one did not. Keying removes the obligation.

---

## 5. Data changes

**None.** The cache key's new component is derived from `projects.appleCredentials` / `projects.googleCredentials`, which already exist. No paywall-model change, no ClickHouse change, no renderer change.

## 6. Risks / decisions worth stating

- **Deriving the union may surface more than one missing combo.** If the build fails on props beyond `trialLabelKey`, each is a real gap of the same kind and should be reported, not silently added — the count is information about how long the drift has been running.
- **A changed cache key invalidates every entry for that project at once**, so the first request after a credential change pays a full resolve. That is correct: those prices were fetched with a credential that no longer applies.
- **The tuple retyping touches a shared schema** consumed by three renderers and the builder. It is a type-level change with no runtime effect, but it must not alter the emitted JSON or the fixtures.
- The recon for this spec deliberately did not verify the Stripe resolver's behaviour beyond reading its key construction; the plan should not extend scope there on the strength of this document alone.
- Test surface for gap 2 already exists and should be extended rather than replaced: `apps/api/src/services/offering-price-resolver.test.ts`, `routes/dashboard/offerings.resolved.test.ts`, and `routes/dashboard/products.cache-purge.test.ts` — the last of which is the closest precedent for asserting cache behaviour from a route.

## 7. Acceptance criteria

1. Adding a prop to `OVERRIDABLE_PROP_KEYS` without adding it to the override editor **fails the build**, naming the combo — demonstrated by capturing that failure for `purchaseButton.trialLabelKey` before fixing it.
2. `trialLabelKey` is settable as a conditional override in the builder, validated consistently with the Binding tab's base editor, and round-trips through save/publish.
3. Any other combos the new check surfaces are reported explicitly, with a decision per combo rather than a silent addition.
4. After a credential rotation, correction or disconnect, no request is served prices fetched with the previous credential — proven by a test that changes the credential and asserts the resolver does not return the earlier values.
5. No credential material appears in any Redis key.
6. `purgeResolvedPriceCache` and its five existing call sites still work; the Stripe resolver is unchanged.
7. No change to the paywall model's emitted JSON, `render-fixtures.json`, or any renderer.
