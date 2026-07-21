# Stripe Connect OAuth — design

**Date:** 2026-07-21
**Status:** approved, ready for planning
**Scope:** Sub-project **B1** of the web-to-app onboarding payment work.

## 1. Summary

Replace the per-project "paste your Stripe secret key" integration with Stripe
Connect. A project owner clicks **Connect with Stripe**, completes Stripe's
OAuth consent screen, and Rovenue stores nothing but the resulting account id.
All subsequent Stripe calls run against Rovenue's *platform* key with a
`Stripe-Account: acct_…` header (Standard account, direct charges), so funds
settle directly in the customer's account and Rovenue is never in the flow of
money.

The old API-key path is removed outright — schema, routes, middleware, UI, and
tests. There is no dual-path period.

## 2. Why this exists

The onboarding funnel's paywall page has never been able to take a payment.
`funnel_purchases` carries `stripe_checkout_session_id`, `stripe_customer_id`,
`stripe_subscription_id`, `amount_cents` and `currency`, but nothing writes
them; `funnelPurchaseRepo.markPaid` has zero call sites. The only "payment" is
a dev stub at `apps/api/src/routes/public/funnels.ts:399-431`, and publishing
any funnel containing a paywall page is hard-blocked in production by a
placeholder gate at `apps/api/src/routes/dashboard/funnels.ts:353-363`.

Charging on behalf of a customer requires knowing *which* Stripe account to
charge and holding a durable, revocable authorisation to do so. That is what
this sub-project delivers. Selling the right thing (B2) and collecting the card
on the page (B3) build on top of it.

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Connection mechanism | Stripe Connect OAuth | Customer never copies a secret; authorisation is revocable from either side. |
| Account type & charge flow | **Standard account, direct charges** | Customer stays merchant of record; disputes, refunds, KYC and payout liability remain theirs. Money never touches Rovenue. Mirrors how RevenueCat/Adapty observe rather than process payments. |
| Application fee | **None** in B1 | `application_fee_amount` is a single parameter that can be added later without redesign; taking a cut is a pricing decision, not an architectural one. |
| Relationship to API keys | **Replaces them** | One connection, one mental model. |
| Migration | **Hard cutover** | No dual code path, no migration debt. Operational cost is stated in §12. |
| Token storage | **Do not persist OAuth tokens** | Direct charges on a Standard account need only `stripe_user_id`; the access/refresh tokens serve the legacy act-as-account flow we do not use. Not storing them removes an entire class of secret rotation and leakage risk. |
| Test mode | **Supported** | Stripe issues separate Connect client ids for test and live. Without it nobody can exercise a funnel payment locally. |

## 4. Non-goals

- Selling anything. Binding the paywall page to an offering is **B2**.
- Taking a card on the page. Payment Element, Express Checkout, Apple Pay and
  Google Pay domain registration are **B3**.
- Migrating platform SaaS billing. `/billing/stripe/webhook`,
  `STRIPE_BILLING_*` and the `STRIPE_BILLING` dedup space are untouched.
- Application fees / revenue share.
- Express or Custom connected accounts.

## 5. Data model

New table `project_stripe_connections` (migration `0086_stripe_connect.sql`;
latest existing migration is `0085_pricing_consolidation.sql`).

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | cuid2 via `createId()` |
| `project_id` | `text` NOT NULL | FK → `projects.id`, `onDelete: cascade` |
| `stripe_account_id` | `text` NOT NULL | `acct_…` |
| `livemode` | `boolean` NOT NULL | from the OAuth token response |
| `scope` | `text` NOT NULL | Stripe returns `read_write` |
| `charges_enabled` | `boolean` NOT NULL default `false` | from `accounts.retrieve` |
| `payouts_enabled` | `boolean` NOT NULL default `false` | from `accounts.retrieve` |
| `capabilities` | `jsonb` NOT NULL default `'{}'` | raw `account.capabilities` |
| `country` | `text` nullable | informational; shown in the dashboard |
| `default_currency` | `char(3)` nullable | informational |
| `connected_at` | `timestamptz` NOT NULL defaultNow | |
| `connected_by` | `text` | FK → `user.id`, `onDelete: set null` |
| `disconnected_at` | `timestamptz` | soft delete; NULL means active |
| `disconnect_reason` | `text` | `user` \| `stripe_deauthorized` |
| `last_synced_at` | `timestamptz` | last `accounts.retrieve` |

Indexes:

- `project_stripe_connections_active_uq` — partial unique on `(project_id)`
  `WHERE disconnected_at IS NULL`. At most one live connection per project.
- `project_stripe_connections_account_idx` on `(stripe_account_id)` — the
  webhook routing lookup.

A dedicated table rather than another JSONB column on `projects` because a
Connect link has real, changing state (capabilities can be revoked, an account
can be disabled by Stripe) and because connect/disconnect history is worth
auditing. The removed `projects.stripeCredentials` column could hold neither.

Repository: `packages/db/src/drizzle/repositories/project-stripe-connections.ts`
exporting `findActiveByProject`, `findActiveByAccountId`, `insert`,
`markDisconnected`, `updateAccountState`; re-exported through the package
barrel as `drizzle.stripeConnectionRepo`.

### Migration

`0086_stripe_connect.sql` creates the table and drops
`projects."stripeCredentials"`. Dropping the column is destructive and
irreversible; §12 states the consequence.

## 6. Environment

A new group, deliberately **not** gated on `HOST_MODE`.
`isBillingEnabled()` is cloud-only (`apps/api/src/lib/host-mode.ts:15-17`)
because it governs Rovenue's own SaaS billing. Connect is a customer-facing
capability that self-hosted deployments need too — a self-hoster registers
their own Connect platform in the Stripe dashboard and fills these in.

```
STRIPE_CONNECT_CLIENT_ID=          # ca_… (live)
STRIPE_CONNECT_CLIENT_ID_TEST=     # ca_… (test)
STRIPE_PLATFORM_SECRET_KEY=        # sk_live_…
STRIPE_PLATFORM_SECRET_KEY_TEST=   # sk_test_…
STRIPE_PLATFORM_PUBLISHABLE_KEY=   # pk_live_… (served to the browser in B3)
STRIPE_PLATFORM_PUBLISHABLE_KEY_TEST=
STRIPE_CONNECT_WEBHOOK_SECRET=     # whsec_… for the Connect endpoint
```

When `STRIPE_CONNECT_CLIENT_ID` and `STRIPE_PLATFORM_SECRET_KEY` are unset,
Stripe features report themselves unavailable: the dashboard renders the
Connect card disabled with an operator-facing explanation, the connect route
returns 503, and the paywall publish gate refuses. No startup crash — the
same graceful-degradation posture the codebase already takes for a blank
ClickHouse in local dev.

Cross-field validation in `apps/api/src/lib/env.ts` mirrors the existing
billing block: in production, if `STRIPE_CONNECT_CLIENT_ID` is set then
`STRIPE_PLATFORM_SECRET_KEY` and `STRIPE_CONNECT_WEBHOOK_SECRET` must also be
set.

## 7. Platform Stripe client

`apps/api/src/lib/stripe-platform.ts` — new module, sibling to the existing
`stripe-billing.ts`.

- `getPlatformStripe(livemode: boolean): Stripe | null` — memoised per mode,
  `apiVersion` pinned to `"2024-12-18.acacia"` (matching
  `apps/api/src/lib/stripe-billing.ts:32`), `appInfo: { name: "rovenue-connect" }`.
  Returns `null` when the corresponding key is unset.
- `getConnectedStripe(projectId): Promise<{ stripe: Stripe; accountId: string } | null>`
  — resolves the active connection, picks the platform client by
  `connection.livemode`, returns `null` when the project has no live
  connection. Callers turn that `null` into a domain error naming the
  project; the resolver itself never throws, so a caller can also branch on
  it (the health endpoint does).
- Every connected call passes `{ stripeAccount: accountId }` as the request
  options argument. The per-project `getStripeClient(secretKey)` cache in
  `apps/api/src/services/stripe/stripe-webhook.ts:31-41` is deleted.

Pinning the API version is a change in behaviour: the old per-project client
was constructed as bare `new Stripe(secretKey)` with no pin, so it silently
tracked whatever version the account defaulted to.

## 8. OAuth flow

### Connect

`GET /dashboard/projects/:projectId/stripe/connect` — `MemberRole.OWNER`,
matching the authority the removed `PUT /credentials/:store` required.

1. 503 if the platform is unconfigured; 409 if an active connection exists.
2. Read `?mode=live|test`, defaulting to `live`. This picks which
   `STRIPE_CONNECT_CLIENT_ID` is used and therefore which kind of account
   Stripe will hand back; the dashboard only offers the test option when
   `STRIPE_CONNECT_CLIENT_ID_TEST` is configured. 400 if the requested mode
   has no client id.
3. Generate a 32-byte random `state` nonce. Store
   `stripe:oauth:<nonce> → { projectId, userId, mode }` in Redis with a
   600-second TTL. The nonce is the only thing that travels through the
   browser, so a leaked URL grants nothing after ten minutes and cannot be
   replayed (the callback deletes it).
4. 302 to `https://connect.stripe.com/oauth/authorize` with
   `response_type=code`, the mode's `client_id`, `scope=read_write`, `state`,
   and `redirect_uri` pointing at the callback below.

The `redirect_uri` is a single fixed URL registered once with Stripe — it
carries no project information, because the nonce already does. `mode` in the
nonce selects the platform client used to exchange the code; the authoritative
`livemode` written to the row is the one Stripe returns in the token response,
not the requested mode.

### Callback

`GET /stripe/oauth/callback` — unauthenticated by necessity (Stripe redirects
the browser here), so the nonce carries all trust.

1. Stripe error responses (`?error=access_denied`) redirect back to the
   dashboard with a readable message; no row is written.
2. Look up and immediately delete the nonce. Missing or expired → 400.
   Deleting before use makes the callback single-shot.
3. `stripe.oauth.token({ grant_type: "authorization_code", code })` →
   `stripe_user_id`, `livemode`, `scope`. **The access and refresh tokens in
   this response are discarded and never written anywhere, including logs.**
4. `accounts.retrieve(stripe_user_id)` on the platform client for
   `charges_enabled`, `payouts_enabled`, `capabilities`, `country`,
   `default_currency`.
5. Insert the row and write `audit("stripe.connected")` in the same
   transaction, per the codebase's `audit()`-inside-caller-tx convention.
6. 302 back to the project's Stripe settings page under `DASHBOARD_URL`.

Two new audit actions join the union in `apps/api/src/lib/audit.ts:44-45`:
`"stripe.connected"` and `"stripe.disconnected"`.

### Disconnect

`DELETE /dashboard/projects/:projectId/stripe/connect` — OWNER. Calls
`stripe.oauth.deauthorize({ client_id, stripe_user_id })`, then sets
`disconnected_at` and `disconnect_reason = "user"` and audits. Stripe's
deauthorize is idempotent enough in practice, but a failure there must not
strand the row: if the API call fails with `invalid_client` or the account is
already deauthorized, we still soft-delete locally and log.

The reverse direction — the customer revoking access from their own Stripe
dashboard — arrives as `account.application.deauthorized` on the Connect
webhook and takes the same path with `disconnect_reason = "stripe_deauthorized"`.

Disconnecting does not cancel anything. Subscriptions the customer's account
already holds keep billing; Rovenue simply stops receiving events and stops
being able to act. The confirmation dialog says exactly that.

## 9. Webhooks

One platform-level endpoint replaces the per-project one.

`POST /webhooks/stripe/connect`:

1. Verify with `stripe.webhooks.constructEvent(rawBody, sig,
   STRIPE_CONNECT_WEBHOOK_SECRET, 300)` — same 300-second tolerance as the
   removed `verifyStripeWebhook`.
2. Read `event.account`. Absent → 400. A Connect endpoint should only ever
   receive connected-account events; a platform event arriving here means
   misconfiguration and should be loud, not silently swallowed.
3. `findActiveByAccountId(event.account)` → project. No match → 202 with
   `{ status: "unknown_account" }`. This is deliberately not an error:
   after a disconnect, Stripe may still deliver in-flight events, and
   retrying them forever helps nobody.
4. Replay guard (`webhook:seen:stripe:<event.id>`) and
   `enqueueWebhookEvent({ source: "STRIPE", projectId, event })` exactly as
   today. `claimWebhookEvent` idempotency on `(STRIPE, event.id)` is unchanged.

The only thing that moves is *how the project is discovered* — from a URL path
parameter to the event body. Everything downstream of `processStripeEvent`
(status mapping, `guardStatusWrite`, revenue-event dedupe keys, refund delta
handling) is untouched.

Rate limiting: a single global endpoint, so the per-store limiter keyed on
store + first-hop IP no longer fits. Use the same shape as the platform
billing webhook (`apps/api/src/routes/billing/index.ts:20-27`): 200 requests
per minute per IP.

The customer configures **no** webhook endpoint in their own Stripe dashboard.
The platform's Connect endpoint is registered once, by the operator.

## 10. Capability gate

`chargesEnabled(projectId)` returns true when an active connection exists,
`charges_enabled` is true, and `capabilities.card_payments === "active"`.

This replaces the placeholder at
`apps/api/src/routes/dashboard/funnels.ts:353-363`, which today throws
`STRIPE_NOT_CONNECTED` for *any* funnel containing a paywall page whenever
`NODE_ENV === "production"` — meaning no paywall funnel can be published at
all. The new gate throws the same error code, but only when the project
genuinely cannot take a charge, and in every environment rather than only
production.

`accounts.retrieve` is refreshed and `last_synced_at` bumped whenever an
`account.updated` event arrives for the connected account, so the gate does
not go stale.

## 11. Removals

Server:

- `apps/api/src/lib/project-credentials.ts` — `stripeSchema`,
  `loadStripeCredentials`.
- `apps/api/src/routes/dashboard/credentials.ts` — the `stripe` branch in
  `GET /`, `PUT /:store`, `DELETE /:store`, and `stripeCredentialsBodySchema`.
- `apps/api/src/middleware/webhook-verify.ts:271-314` — `verifyStripeWebhook`.
- `apps/api/src/routes/webhooks/stripe.ts` — the `:projectId` route, and its
  `storeLimit("stripe")` entry in `apps/api/src/routes/webhooks/index.ts`.
- `apps/api/src/services/stripe/stripe-webhook.ts` — `getStripeClient`, the
  client cache, and the legacy synchronous `handleStripeNotification`.
- `packages/db/src/helpers/encrypted-field.ts` — `"stripeCredentials"` leaves
  `CREDENTIAL_FIELDS`; the field also leaves the `EncryptedProject` type.
- `packages/db/src/drizzle/repositories/projects.ts` — the `stripe` branches in
  `findProjectCredentials`, `writeProjectCredential`, `clearProjectCredential`.
- `packages/shared/src/dashboard.ts` — `"stripe"` leaves `CredentialStore`;
  `UpdateStripeCredentialsRequest` is deleted.
- `apps/api/src/routes/health.ts` — the Stripe entry reports connection state
  instead of `configured`.
- `apps/api/src/routes/dashboard/projects.ts:131` — the settings guard message
  no longer names `stripeCredentials`.

Rewired to the connected client rather than deleted:

- `apps/api/src/services/refunds/refund-transaction.ts:126-142` —
  `stripe.refunds.create` keeps its `refund_<purchaseId>` idempotency key.
- `apps/api/src/workers/scheduled-actions.ts:157-176` —
  `stripe.subscriptions.update`.

Both must fail with a clear "project has no Stripe connection" error rather
than a null dereference.

Dashboard:

- `apps/dashboard/src/routes/_authed/projects/$projectId/stores.tsx` — the
  `stripe` entry stops being a credential card.
- `apps/dashboard/src/components/stores/store-credential-card.tsx:263-284` —
  the secret-key and webhook-secret inputs are removed.
- New `stripe-connect-card.tsx` — connect button, or when connected: account
  id, livemode badge, country, capability state, disconnect action.
- `apps/dashboard/src/components/products/store-identifier-fields.tsx:92-94` —
  the "Web" price-id field gates on connection state instead of
  `credentials.stripe.configured`.
- `apps/dashboard/src/components/project-setup/step-platforms.tsx:134-159` —
  the dead `acct_…` input and its no-op OAuth button become a real connect
  action; `stripeAcct` leaves the setup form type and mock data.
- i18n: `stores.stripe.fields.*` are replaced by connect/disconnect strings.

Tests touching the removed surface —
`apps/api/tests/dashboard-credentials.test.ts`,
`apps/api/tests/webhook-verify.test.ts`, and the project-credential cases in
the Stripe webhook suites — are updated rather than deleted; their coverage
moves to the Connect equivalents.

## 12. Rollout

This is a breaking change for any project already using Stripe.

On deploy, `projects.stripeCredentials` is dropped. Every project's Stripe
integration goes dark until an OWNER completes the Connect flow: no webhooks
arrive, so subscription state, entitlements and revenue events freeze at their
last known values. Refunds and scheduled cancellations for those projects fail
with an explicit error.

What survives: `products.storeIds.stripe` holds `price_…` ids that live on the
same Stripe account the customer will reconnect, so product mappings and the
`findProductByStoreId` lookup in `stripe-webhook.ts:597-609` keep working
untouched once reconnected.

Operator checklist, in order: register the Connect platform in Stripe and note
the live and test `ca_` client ids; add the platform webhook endpoint with
"listen to Connect events" enabled and capture its `whsec_`; set the
environment group from §6; deploy; notify customers to reconnect.

## 13. Error handling

| Condition | Response |
|---|---|
| Platform env unconfigured | 503 from connect route; dashboard card disabled with operator note |
| Non-OWNER attempts connect/disconnect | 403 |
| Active connection already exists | 409 |
| `?mode=test` requested but no test client id configured | 400 |
| `state` nonce missing, expired, or reused | 400, no row written |
| User declines on Stripe's consent screen | 302 back with a readable message |
| `oauth.token` fails | 502, nothing written, error logged without the code |
| Connect webhook signature invalid | 401 |
| Connect webhook missing `event.account` | 400 |
| `event.account` matches no active connection | 202 `{ status: "unknown_account" }` |
| Connected call made for a project with no connection | domain error naming the project, never a null dereference |

Nothing in this design logs an OAuth code, access token, or refresh token.

## 14. Testing

Unit: nonce generation, single-use consumption, and expiry; the callback's
handling of `access_denied`, a reused nonce, and an `oauth.token` failure;
`getConnectedStripe` mode selection by `livemode` and its null path;
`chargesEnabled` across missing connection, disabled charges, and inactive
`card_payments`.

Webhook: signature verification against the Connect secret; `event.account`
routing to the right project; absent-account rejection; unknown-account 202;
idempotent replay of the same `event.id`;
`account.application.deauthorized` soft-deleting the connection.

Integration (`*.integration.test.ts`, testcontainers, real Postgres + Redis):
connect → row written with capabilities → connected-account event routed and
processed → disconnect → subsequent event for the same account returns
`unknown_account`. Plus the partial unique index actually rejecting a second
active connection for one project.

Migration: `0086` applies cleanly on a database holding populated
`stripeCredentials` rows, and the column is gone afterwards.

## 15. What comes next

**B2 — offerings on the web.** Bind the paywall page to an offering rather
than a single product. `/v1/offerings` already returns `storeIds.stripe`
(`apps/api/src/routes/v1/offerings.ts:40-49`), so a web consumer needs no
server change to read price ids; the Rust core drops the field
(`packages/core-rs/src/offerings/types.rs:29-33`) but funnels never go through
the core. Known snags to design around: there is no `$rov_web` package slot,
`PACKAGE_ID_RE` rejects the `$rov_two_month`/`$rov_three_month`/`$rov_six_month`
slots the SDKs already map, and the paywall product picker at
`properties-panel.tsx:581-597` writes a product *identifier* into a field named
`productId`.

**B3 — payment on the page.** Payment Element plus Express Checkout Element
for Apple Pay and Google Pay, confirmed with `redirect: "if_required"`;
`paymentMethodDomains` registration on the connected account for every host
that serves a funnel; the session → purchase → claim-token chain; and
subscriber convergence, where the payment creates a synthetic subscriber
immediately and the claim merges it into the installed one via
`reassignAllAssets` (`apps/api/src/services/subscriber-transfer.ts:64`).

Three defects sit in B3's path and are fixed there, not here: the dashboard
writes `settingsJson` in camelCase while the API reads snake_case, so
`dev_mode` is never true and store URLs never resolve; `/advance` returns
`{ next: "paywall" }` with no page id, which dead-ends the runner; and
`buildClaimResponse` returns a hardcoded `entitlements: []`
(`apps/api/src/routes/v1/funnel-claim.ts:95`).
