# Web SDK (`@rovenue/web-sdk`)

**Date:** 2026-09-05
**Roadmap:** §7 SDK platform coverage — "Web SDK (TS: Stripe checkout + entitlement reads)"
**Status:** design approved, key mechanisms empirically probed

## The roadmap item's premise is half wrong

The item reads *"funnel/web payment backend exists"*. A web payment backend exists, but **the Web SDK cannot use it**, and a second claim hides behind the first.

`apps/api/src/routes/public/funnel-payment.ts` is a *funnel on-page* payment flow. Its session identity lives in the URL path because the public funnel CORS is `origin: "*"` and sends no credentials; its whole shape assumes an anonymous visitor on a page Rovenue serves. An SDK-authenticated app on a customer's own domain is a different caller with a different identity model.

And `checkout.sessions` appears **nowhere** in the API. There is no Stripe Checkout endpoint to call.

What *does* exist, and is directly reusable, is the entire `/v1` surface behind public-API-key Bearer auth: `me/entitlements` (already reshaped as the SDK contract), `placements`, `offerings`, `events`, `identify`, `subscribers`, `virtual-currencies`, `billing-portal`, `experiments`, `config`, `sdk/sessions`, `funnel-claim`. `@rovenue/paywall-renderer` already renders the builder's paywall tree on the web; only the dashboard consumes it today.

So the Web SDK is mostly a typed client over an existing surface. Three things are genuinely missing, and the first is not the one the roadmap names.

## 1. The auth model, stated plainly

This belongs first because it constrains everything else, and because shipping a browser SDK makes it visible in a way the native SDKs did not.

`appUserContext` reads `X-Rovenue-App-User-Id` and calls `resolveOrCreateSubscriber`, which **creates the subscriber on first sight**. The client *asserts* who it is; nothing proves it. Combined with a public API key, anyone holding a valid `rovenueId` can read that subscriber's entitlements.

This is the same model RevenueCat's public SDK key uses, and it holds for one reason: `rovenueId` is an unguessable cuid2. It is not weakened by the web — but on the web the key and the header are visible in devtools, so the property the model depends on has to be stated rather than assumed:

> **The app user id must never be an email address, a sequential id, or anything else a stranger could guess.** The SDK's default identity is the generated `rovenueId`; `identify()` is client-local (merging goes through the secret-key `/v1/subscribers/transfer`), so an application that supplies its own id is opting into responsibility for its unguessability.

The docs page states this. The SDK does not silently accept an obviously-guessable id: `identify()` warns (does not throw) when handed a value that looks like an email address.

## 2. Browser access to `/v1`

`/v1` is unreachable from a browser today, and this is the first real blocker.

The global CORS middleware (`apps/api/src/app.ts`) allows a fixed origin list — the dashboard plus dev servers. A customer's app is not on it. `allowHeaders` also omits `X-Rovenue-App-User-Id` and `X-Rovenue-Platform`, so even a listed origin would fail preflight on the SDK's own identity headers.

### Why the obvious fix does not work

A CORS preflight is an `OPTIONS` request that carries **no `Authorization` header**, by definition. The server therefore cannot know which project is asking at the moment it must decide whether to allow the origin. **Per-project CORS is impossible from the Bearer key alone.** The project reference has to be somewhere preflight can see: the URL.

An earlier draft of this design proposed reusing the project's verified `custom_domains` rows as the origin allow-list, on the strength of `billing-portal` reusing them for its return-URL check. That was wrong twice over: it cannot solve the preflight problem at all, and the record means the wrong thing — `custom_domains` proves a project controls a domain *for hosting funnels over https*, which is not the same as an app origin permitted to call the API. Requiring funnel-hosting DNS verification in order to make an API call is a category error.

### What we build instead

Allowed origins are declared **on the API key** — the shape Stripe publishable keys, Firebase, and Google Maps browser keys all use. `api_keys` gains `allowedOrigins text[] not null default '{}'`. An empty list means the key is not enabled for browser use, so existing keys are unchanged and no native consumer is affected.

The browser surface mounts the existing `/v1` router under a parameterised prefix that carries the public key:

```
/v1/web/:publicKey/*   →  the same v1 router
```

CORS is applied **on that prefix**, not at `app.use("*")`.

### Probe results (2026-09-05, Hono as vendored in this repo)

This mattered enough to test rather than assume, and one result changes where the middleware goes:

| Probe | Result |
|---|---|
| Mounted route with `:publicKey`, real GET | param resolves (`pk_test_123`), 200 |
| Same param read from `app.use("*")` middleware | **not available** (`none`) |
| CORS mounted on `/v1/web/:publicKey/*`, listed origin | 204, `Access-Control-Allow-Origin: https://app.customer.com`, `Vary: Origin` |
| Same, unlisted origin | 204, allow-origin `null` → browser blocks |
| Same, unknown public key | 204, allow-origin `null` |

So the param is invisible to app-level middleware, and mounting CORS at `app.use("*")` — where it lives today — cannot work for this. `Vary: Origin` is emitted automatically, which caching correctness depends on.

### What origin restriction does and does not buy

It is **not** an authorization boundary. A non-browser client ignores CORS entirely; `curl` with the public key is unaffected. What it prevents is *another website's JavaScript* using the key inside a visitor's browser. That is a real but narrow benefit, and the design does not lean on it for anything else. Authorization rests on the unguessable `rovenueId`, the project scoping of the key, rate limits, and key revocation.

Origins are matched exactly — scheme, host and port. No wildcards: a `https://*.example.com` entry invites a subdomain-takeover to become an API key. Dashboard UI for editing the list lives beside the existing API-key management.

## 3. `POST /v1/checkout`

A Stripe Checkout Session endpoint, taking its security shape from `billing-portal`, which already passed a security review in this repo:

- Subscriber identity comes **only** from `appUserContext`. The body schema is `.strict()` with no customer, price or amount field, so a client cannot smuggle one in even under a plausible name — an unknown key 400s before the handler runs.
- The browser names a **package**; the server resolves it through the project's published paywall to a Stripe Price on the connected account via `resolvePricesForPackages`, exactly as the funnel does. The amount is never in the request.
- `success_url` / `cancel_url` are allow-listed against the project's verified `custom_domains`. Here that record *is* semantically right: these are pages the project hosts, which is what `custom_domains` attests.

Two things `billing-portal` does not have to solve, and this endpoint does:

**First-purchase customer creation.** `billing-portal` resolves an *existing* Stripe customer. A first web purchase has none, so the endpoint creates one and binds it to the subscriber. Two tabs racing must not produce two customers: the binding runs inside `withLock` (`lib/redis-lock`), which the funnel payment path already uses for this class of race.

**Idempotency.** A double-submitted checkout must not create two sessions. The endpoint honours the `Idempotency-Key` header already present in the API's `allowHeaders`, and passes it through to Stripe.

### Webhook convergence is nearly free

The Stripe webhook already handles `customer.subscription.created`, `customer.subscription.updated`, `invoice.paid` and `payment_intent.succeeded` — which is exactly what a subscription-mode Checkout Session emits. The only new work is binding: the session carries subscriber metadata so the webhook resolves it to the right subscriber, the SDK analogue of the funnel's `FUNNEL_METADATA_KEY`. Entitlements then land in `subscriber_access` through the existing path, with no second write path and no dual-write.

## 4. The package

`packages/sdk-web`, published as `@rovenue/web-sdk`, in three layers:

**Core** — framework-agnostic. The typed `/v1` client, a last-known-entitlements cache, and the event queue. No React, no DOM assumptions beyond what is guarded.

**React** — a thin layer of hooks over the core (`useEntitlements`, `usePlacement`, …), exported from a separate entry point so a non-React consumer never pulls it in.

**Paywall binding** — feeds `@rovenue/paywall-renderer` from SDK data, so builder paywalls render on the web without a second renderer. The renderer already exists and the dashboard already uses it; this is wiring, not a new implementation.

Wire identity is `rovenueId`, never `current_user_scope` — the inverse has already caused orphan-subscriber routing in this codebase.

### Server-side rendering

Next.js and Remix execute SDK code on the server, where `localStorage` does not exist and there is no viewer. The core must therefore:

- never touch `window`, `document` or `localStorage` at module scope — only inside methods, behind a capability check;
- fall back to an in-memory cache when storage is unavailable, rather than throwing;
- be safe to *construct* on the server, while network calls that assume a viewer are the consumer's choice.

A test runs the core's import and construction under a Node environment with no DOM to keep this honest.

### Events must survive the tab closing

"At-least-once" is a claim, not a design, unless the flush path handles unload. The queue flushes with `navigator.sendBeacon` (falling back to `fetch(..., { keepalive: true })`) on `visibilitychange → hidden` and `pagehide`, and retains unsent events in storage so the next session replays them. The server already dedups by deterministic event id, which is what makes replay safe.

### Packaging

Dual ESM + CJS with correct `exports` conditions and separate entry points for core, React and paywall; `"sideEffects": false` so the React layer tree-shakes out of a core-only consumer; no Node built-ins; a bundle-size budget asserted in CI on the core entry point, so a careless dependency shows up as a failing test rather than a slow page.

## Verification

Each is a command with an expected result:

1. A preflight to `/v1/web/<pk>/me/entitlements` from a listed origin returns the origin and `Vary: Origin`; from an unlisted origin returns no allow-origin header; with an unknown key returns no allow-origin header.
2. A key with an empty `allowedOrigins` is not usable from any browser origin, and is unchanged for native callers.
3. `POST /v1/checkout` with a `price`, `amount` or `customer` field in the body returns 400 before the handler runs.
4. Two concurrent checkout calls for one subscriber produce one Stripe customer.
5. The same `Idempotency-Key` twice produces one session.
6. A completed Checkout Session results in the subscriber's entitlement appearing in `subscriber_access`, through the existing webhook path.
7. The core imports and constructs under Node with no DOM, and falls back to the in-memory cache.
8. A queued event survives a simulated `pagehide` and is delivered.
9. The core entry point stays under the bundle-size budget.

## Out of scope

- On-page Stripe Elements. The funnel's payment flow stays the funnel's; duplicating it under a second auth model is how two payment paths drift.
- Unity and Capacitor/Cordova façades — separate roadmap items.
- `origin: "*"` on `/v1`. The public key is visible in the browser; removing the origin restriction entirely gives up the one thing it does buy.
- Changing the native SDKs' auth model. This design states it; it does not alter it.
