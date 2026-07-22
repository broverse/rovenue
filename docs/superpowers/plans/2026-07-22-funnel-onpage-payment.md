# Funnel On-Page Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a web funnel's paywall take card, Apple Pay and Google Pay on the page itself, charged through the customer's connected Stripe account, and hand the resulting entitlement to the app on claim.

**Architecture:** The paywall's look and its package selection already exist (Phase B renderer). This plan fills in what happens behind `onPurchase`: the server resolves the selected package to a real Stripe Price on the connected account, creates the Subscription or PaymentIntent itself so the amount never comes from the browser, the page confirms it with Stripe Elements without leaving, and a confirm endpoint re-reads Stripe before minting the claim token. A synthetic subscriber is created at payment and merged into the installed one at claim.

**Tech Stack:** Hono + TypeScript (strict), Drizzle on PostgreSQL, Redis, `stripe` v15 server SDK, `@stripe/stripe-js` v4 + `@stripe/react-stripe-js` v3 in the React/Vite dashboard, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-22-funnel-onpage-payment-design.md`

## Global Constraints

- TypeScript strict. Zod for API input. Responses are `{ data: T }` or `{ error: { code, message } }` — use `ok()` from `apps/api/src/lib/response.ts`, or throw `HTTPException`.
- **The charged amount must never come from the request body.** It is always derived server-side from the Stripe Price. A test proves this (Task 6).
- **Every Stripe call on a connected account goes through the `AccountScopedStripe` facade** (`apps/api/src/lib/stripe-account-scoped.ts`). The raw platform client is deliberately unreachable from `getConnectedStripe`; adding a resource means adding it to the facade and to `withAccount`, never bypassing them.
- Public funnel routes are CORS `origin: "*"` with no credentials (`apps/api/src/routes/public/funnels.ts:116-119`). Session identity travels in the URL path, never a cookie.
- Postgres access via Drizzle repositories only. All ids cuid2 via `createId()`. Timestamps `timestamptz`.
- `audit()` runs inside the caller's transaction. Funnel lifecycle events go through `emitFunnelEvent(tx, kind, sessionId, payload)` (`apps/api/src/services/funnel/outbox.ts`) inside the same transaction as the domain write — that is the transactional-outbox invariant.
- In `apps/api` tests, env vars assigned at the top of a file are dead code (import hoisting parses `lib/env` first). Use `vi.hoisted()`. `vi.mock(..., importOriginal)` factories are cached per file and do NOT re-run on `vi.resetModules()`; control per-test behaviour with a direct `vi.fn()`.
- Dashboard component tests use `@testing-library/react` with `renderWithRouter` from `apps/dashboard/tests/render` (note: `tests/`, not `src/tests/`), and assertions need `waitFor` because the router resolves its initial match asynchronously.
- Postgres runs on host port **5433**, Redis on host port **6380** (not 6379). `apps/api/tests/setup.ts` already defaults `REDIS_URL` to 6380.
- Integration tests put a bare `process.env.DATABASE_URL ??=` as the **first statement in the file, above every import** — the `@rovenue/db` client is a lazy singleton that captures the URL on first touch.
- Never `git add -A`. Stage explicitly and run `git status --short` before committing; another author commits to this repo in parallel.
- Conventional commits.

---

### Task 1: Extend the account-scoped Stripe facade

**Files:**
- Modify: `apps/api/src/lib/stripe-account-scoped.ts`
- Test: `apps/api/src/lib/stripe-account-scoped.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AccountScopedStripe` gains `prices.retrieve`, `customers.create`, `paymentIntents.create`, `paymentIntents.retrieve`, `subscriptions.create`, `subscriptions.retrieve`, `paymentMethodDomains.create`, `paymentMethodDomains.list`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/lib/stripe-account-scoped.test.ts`. Extend `stubClient()` first so it exposes the new resources:

```ts
function stubClientWide() {
  const fns = {
    pricesRetrieve: vi.fn(async () => ({ id: "price_1" })),
    customersCreate: vi.fn(async () => ({ id: "cus_1" })),
    paymentIntentsCreate: vi.fn(async () => ({ id: "pi_1" })),
    paymentIntentsRetrieve: vi.fn(async () => ({ id: "pi_1" })),
    subscriptionsCreate: vi.fn(async () => ({ id: "sub_1" })),
    subscriptionsRetrieve: vi.fn(async () => ({ id: "sub_1" })),
    domainsCreate: vi.fn(async () => ({ id: "pmd_1" })),
    domainsList: vi.fn(async () => ({ data: [] })),
  };
  const stripe = {
    prices: { retrieve: fns.pricesRetrieve },
    customers: { create: fns.customersCreate },
    paymentIntents: { create: fns.paymentIntentsCreate, retrieve: fns.paymentIntentsRetrieve },
    subscriptions: { create: fns.subscriptionsCreate, retrieve: fns.subscriptionsRetrieve },
    paymentMethodDomains: { create: fns.domainsCreate, list: fns.domainsList },
  } as unknown as Stripe;
  return { stripe, ...fns };
}

describe("withAccount — payment resources", () => {
  it("binds stripeAccount to prices.retrieve", async () => {
    const { stripe, pricesRetrieve } = stubClientWide();
    await withAccount(stripe, "acct_x").prices.retrieve("price_1");
    expect(pricesRetrieve).toHaveBeenCalledWith("price_1", {
      stripeAccount: "acct_x",
    });
  });

  it("binds stripeAccount to customers.create", async () => {
    const { stripe, customersCreate } = stubClientWide();
    await withAccount(stripe, "acct_x").customers.create({ email: "a@b.c" });
    expect(customersCreate).toHaveBeenCalledWith(
      { email: "a@b.c" },
      { stripeAccount: "acct_x" },
    );
  });

  it("binds stripeAccount to paymentIntents.create and .retrieve", async () => {
    const { stripe, paymentIntentsCreate, paymentIntentsRetrieve } = stubClientWide();
    const acct = withAccount(stripe, "acct_x");
    await acct.paymentIntents.create({ amount: 100, currency: "usd" });
    await acct.paymentIntents.retrieve("pi_1");
    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      { amount: 100, currency: "usd" },
      { stripeAccount: "acct_x" },
    );
    expect(paymentIntentsRetrieve).toHaveBeenCalledWith("pi_1", {
      stripeAccount: "acct_x",
    });
  });

  it("binds stripeAccount to subscriptions.create and .retrieve", async () => {
    const { stripe, subscriptionsCreate, subscriptionsRetrieve } = stubClientWide();
    const acct = withAccount(stripe, "acct_x");
    await acct.subscriptions.create({ customer: "cus_1", items: [] });
    await acct.subscriptions.retrieve("sub_1");
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      { customer: "cus_1", items: [] },
      { stripeAccount: "acct_x" },
    );
    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_1", {
      stripeAccount: "acct_x",
    });
  });

  it("binds stripeAccount to paymentMethodDomains", async () => {
    const { stripe, domainsCreate, domainsList } = stubClientWide();
    const acct = withAccount(stripe, "acct_x");
    await acct.paymentMethodDomains.create({ domain_name: "app.rovenue.io" });
    await acct.paymentMethodDomains.list({ domain_name: "app.rovenue.io" });
    expect(domainsCreate).toHaveBeenCalledWith(
      { domain_name: "app.rovenue.io" },
      { stripeAccount: "acct_x" },
    );
    expect(domainsList).toHaveBeenCalledWith(
      { domain_name: "app.rovenue.io" },
      { stripeAccount: "acct_x" },
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/stripe-account-scoped.test.ts`
Expected: FAIL — `Property 'prices' does not exist on type 'AccountScopedStripe'`.

- [ ] **Step 3: Extend the interface and `withAccount`**

In `apps/api/src/lib/stripe-account-scoped.ts`, add to the `AccountScopedStripe` interface:

```ts
  readonly prices: {
    retrieve(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Price>>;
  };
  readonly customers: {
    create(
      params: Stripe.CustomerCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Customer>>;
  };
  readonly paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
    retrieve(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
  };
  readonly subscriptions: {
    update(
      id: string,
      params: Stripe.SubscriptionUpdateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Subscription>;
    create(
      params: Stripe.SubscriptionCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Subscription>>;
    retrieve(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Subscription>>;
  };
  readonly paymentMethodDomains: {
    create(
      params: Stripe.PaymentMethodDomainCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentMethodDomain>>;
    list(
      params: Stripe.PaymentMethodDomainListParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.ApiList<Stripe.PaymentMethodDomain>>>;
  };
```

Note `subscriptions` already existed with `update`; keep it and add the two new methods to the same object rather than declaring `subscriptions` twice.

In `withAccount`'s returned object, add the matching bindings, keeping the existing `{ ...options, ...bound }` spread order so the account cannot be overridden:

```ts
    prices: {
      retrieve: (id, options) =>
        stripe.prices.retrieve(id, { ...options, ...bound }),
    },
    customers: {
      create: (params, options) =>
        stripe.customers.create(params, { ...options, ...bound }),
    },
    paymentIntents: {
      create: (params, options) =>
        stripe.paymentIntents.create(params, { ...options, ...bound }),
      retrieve: (id, options) =>
        stripe.paymentIntents.retrieve(id, { ...options, ...bound }),
    },
    subscriptions: {
      update: (id, params, options) =>
        stripe.subscriptions.update(id, params, { ...options, ...bound }),
      create: (params, options) =>
        stripe.subscriptions.create(params, { ...options, ...bound }),
      retrieve: (id, options) =>
        stripe.subscriptions.retrieve(id, { ...options, ...bound }),
    },
    paymentMethodDomains: {
      create: (params, options) =>
        stripe.paymentMethodDomains.create(params, { ...options, ...bound }),
      list: (params, options) =>
        stripe.paymentMethodDomains.list(params, { ...options, ...bound }),
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/stripe-account-scoped.test.ts` and `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/stripe-account-scoped.ts apps/api/src/lib/stripe-account-scoped.test.ts
git commit -m "feat(api): add payment resources to the account-scoped Stripe facade"
```

---

### Task 2: Price resolver

**Files:**
- Create: `apps/api/src/services/stripe/price-resolver.ts`
- Test: `apps/api/src/services/stripe/price-resolver.test.ts`

**Interfaces:**
- Consumes: `getConnectedStripe(projectId)` (returns `{ account, accountId, livemode } | null`), the facade's `prices.retrieve` from Task 1.
- Produces:
  ```ts
  export interface ResolvedPrice {
    packageIdentifier: string;
    priceId: string;
    unitAmount: number;      // minor units
    currency: string;        // lowercase ISO-4217
    interval: "day" | "week" | "month" | "year" | null;  // null = one-time
    intervalCount: number | null;
    trialDays: number | null;
  }
  export async function resolvePricesForPackages(
    projectId: string,
    packages: Array<{ packageIdentifier: string; stripePriceId: string | null }>,
  ): Promise<Record<string, ResolvedPrice>>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/stripe/price-resolver.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnectedStripe = vi.hoisted(() => vi.fn());
const pricesRetrieve = vi.hoisted(() => vi.fn());
const redisGet = vi.hoisted(() => vi.fn(async () => null));
const redisSet = vi.hoisted(() => vi.fn(async () => "OK"));

vi.mock("../../lib/stripe-platform", () => ({ getConnectedStripe }));
vi.mock("../../lib/redis", () => ({
  redis: { get: redisGet, set: redisSet },
}));

import { resolvePricesForPackages } from "./price-resolver";

const RECURRING = {
  id: "price_m",
  unit_amount: 4999,
  currency: "usd",
  recurring: { interval: "month", interval_count: 1, trial_period_days: 7 },
};
const ONE_TIME = {
  id: "price_o",
  unit_amount: 9900,
  currency: "try",
  recurring: null,
};

beforeEach(() => {
  getConnectedStripe.mockReset().mockResolvedValue({
    account: { prices: { retrieve: pricesRetrieve } },
    accountId: "acct_1",
    livemode: true,
  });
  pricesRetrieve.mockReset();
  redisGet.mockReset().mockResolvedValue(null);
  redisSet.mockReset().mockResolvedValue("OK");
});

describe("resolvePricesForPackages", () => {
  it("returns real amount, currency and interval for a recurring price", async () => {
    pricesRetrieve.mockResolvedValue(RECURRING);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(out["$rov_monthly"]).toEqual({
      packageIdentifier: "$rov_monthly",
      priceId: "price_m",
      unitAmount: 4999,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      trialDays: 7,
    });
  });

  it("reports a one-time price with a null interval", async () => {
    pricesRetrieve.mockResolvedValue(ONE_TIME);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_lifetime", stripePriceId: "price_o" },
    ]);
    expect(out["$rov_lifetime"]).toMatchObject({
      interval: null,
      intervalCount: null,
      trialDays: null,
      unitAmount: 9900,
    });
  });

  it("omits a package with no Stripe price id", async () => {
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: null },
    ]);
    expect(out).toEqual({});
    expect(pricesRetrieve).not.toHaveBeenCalled();
  });

  it("omits a package whose price cannot be read, without failing the rest", async () => {
    pricesRetrieve
      .mockRejectedValueOnce(new Error("No such price"))
      .mockResolvedValueOnce(RECURRING);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_gone", stripePriceId: "price_gone" },
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(out["$rov_gone"]).toBeUndefined();
    expect(out["$rov_monthly"]).toBeDefined();
  });

  it("returns {} when the project has no Stripe connection", async () => {
    getConnectedStripe.mockResolvedValue(null);
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(out).toEqual({});
  });

  it("serves a cached price without calling Stripe", async () => {
    redisGet.mockResolvedValue(
      JSON.stringify({
        packageIdentifier: "ignored",
        priceId: "price_m",
        unitAmount: 4999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        trialDays: null,
      }),
    );
    const out = await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(pricesRetrieve).not.toHaveBeenCalled();
    // The cached blob is keyed by price, so the package identifier comes
    // from the request, not from whatever was cached.
    expect(out["$rov_monthly"].packageIdentifier).toBe("$rov_monthly");
  });

  it("caches a freshly read price under account and price id", async () => {
    pricesRetrieve.mockResolvedValue(RECURRING);
    await resolvePricesForPackages("p1", [
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]);
    expect(redisSet).toHaveBeenCalledWith(
      "stripe:price:acct_1:price_m",
      expect.any(String),
      "EX",
      300,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/stripe/price-resolver.test.ts`
Expected: FAIL — cannot resolve `./price-resolver`.

- [ ] **Step 3: Implement the resolver**

Create `apps/api/src/services/stripe/price-resolver.ts`:

```ts
import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import { getConnectedStripe } from "../../lib/stripe-platform";

// =============================================================
// Stripe price resolution for web paywalls
// =============================================================
//
// A package carries no amount — the only link to a real price is
// `product.storeIds.stripe`, a price id on the CONNECTED account. On a
// page that takes money the displayed price and the charged price must
// be the same number by construction, so both come from here.
//
// Reading the Price also tells us recurring-vs-one-time, so nothing has
// to store that separately.

const log = logger.child("stripe-price-resolver");

const CACHE_TTL_SECONDS = 300;

export interface ResolvedPrice {
  packageIdentifier: string;
  priceId: string;
  /** Minor units, exactly as Stripe reports it. */
  unitAmount: number;
  /** Lowercase ISO-4217, as Stripe reports it. */
  currency: string;
  /** null for a one-time price. */
  interval: "day" | "week" | "month" | "year" | null;
  intervalCount: number | null;
  trialDays: number | null;
}

function cacheKey(accountId: string, priceId: string): string {
  return `stripe:price:${accountId}:${priceId}`;
}

/**
 * Resolve packages to real prices. A package with no Stripe price id, or
 * whose price cannot be read, is OMITTED rather than failing the whole
 * paywall — the page disables purchase for that package instead of
 * charging an unknown amount.
 */
export async function resolvePricesForPackages(
  projectId: string,
  packages: Array<{ packageIdentifier: string; stripePriceId: string | null }>,
): Promise<Record<string, ResolvedPrice>> {
  const wanted = packages.filter((p) => p.stripePriceId);
  if (wanted.length === 0) return {};

  const connected = await getConnectedStripe(projectId);
  if (!connected) return {};

  const out: Record<string, ResolvedPrice> = {};

  for (const pkg of wanted) {
    const priceId = pkg.stripePriceId as string;
    const key = cacheKey(connected.accountId, priceId);

    try {
      const cached = await redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as ResolvedPrice;
        // The cache is keyed by price, so the identifier belongs to this
        // request, not to whichever package populated the entry.
        out[pkg.packageIdentifier] = {
          ...parsed,
          packageIdentifier: pkg.packageIdentifier,
        };
        continue;
      }
    } catch (err) {
      log.warn("price cache read failed; falling through to Stripe", {
        projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const price = await connected.account.prices.retrieve(priceId);
      if (price.unit_amount == null) {
        log.warn("price has no unit_amount; omitting", { projectId, priceId });
        continue;
      }
      const resolved: ResolvedPrice = {
        packageIdentifier: pkg.packageIdentifier,
        priceId,
        unitAmount: price.unit_amount,
        currency: price.currency,
        interval: price.recurring?.interval ?? null,
        intervalCount: price.recurring?.interval_count ?? null,
        trialDays: price.recurring?.trial_period_days ?? null,
      };
      out[pkg.packageIdentifier] = resolved;
      await redis.set(key, JSON.stringify(resolved), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
      // One unreadable price must not take the whole paywall down.
      log.warn("price lookup failed; omitting package", {
        projectId,
        priceId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/stripe/price-resolver.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stripe/price-resolver.ts apps/api/src/services/stripe/price-resolver.test.ts
git commit -m "feat(api): resolve real Stripe prices for paywall packages"
```

---

### Task 3: Serve prices with the public funnel bundle

**Files:**
- Modify: `apps/api/src/routes/public/funnels.ts` (the `hydrateFunnelPaywalls` region and the `GET /funnels/:slug` response)
- Test: `apps/api/tests/funnel-public-prices.test.ts`

**Interfaces:**
- Consumes: `resolvePricesForPackages` (Task 2).
- Produces: `GET /public/funnels/:slug` response gains `prices: Record<paywallId, Record<packageIdentifier, ResolvedPrice>>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/funnel-public-prices.test.ts`. Mock `@rovenue/db` so `funnelRepo.findBySlug`, `funnelVersionRepo.findById`, `paywallRepo.findPaywallsByIds` and `offeringRepo.findOfferingById` return a funnel with one paywall page referencing `pw_1`, whose offering has one package whose product has `storeIds.stripe = "price_m"`. Mock `../src/services/stripe/price-resolver` with a `vi.fn()`. Mock `../src/lib/redis` with an in-memory store (the route caches the runtime config). Assert:

```ts
it("serves a prices map keyed by paywall id then package identifier", async () => {
  resolvePricesForPackages.mockResolvedValue({
    "$rov_monthly": {
      packageIdentifier: "$rov_monthly",
      priceId: "price_m",
      unitAmount: 4999,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      trialDays: null,
    },
  });
  const app = await buildApp();
  const res = await app.request("/public/funnels/onboarding");
  const body = (await res.json()) as {
    data: { prices: Record<string, Record<string, { unitAmount: number }>> };
  };
  expect(body.data.prices.pw_1["$rov_monthly"].unitAmount).toBe(4999);
});

it("passes the package's stripe price id, not the product identifier", async () => {
  const app = await buildApp();
  await app.request("/public/funnels/onboarding");
  expect(resolvePricesForPackages).toHaveBeenCalledWith(
    "proj_1",
    expect.arrayContaining([
      { packageIdentifier: "$rov_monthly", stripePriceId: "price_m" },
    ]),
  );
});

it("serves an empty prices map when the funnel has no paywall pages", async () => {
  // funnel whose pages contain no `paywall` type
  const app = await buildApp();
  const res = await app.request("/public/funnels/plain");
  const body = (await res.json()) as { data: { prices: Record<string, unknown> } };
  expect(body.data.prices).toEqual({});
  expect(resolvePricesForPackages).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnel-public-prices.test.ts`
Expected: FAIL — `body.data.prices` is undefined.

- [ ] **Step 3: Resolve prices alongside the paywall hydration**

In `apps/api/src/routes/public/funnels.ts`, extend `HydratedPaywallEntry` and the hydration function. After the existing loop that builds `result`, add price resolution per paywall:

```ts
import { resolvePricesForPackages, type ResolvedPrice } from "../../services/stripe/price-resolver";

// …

/**
 * Real prices for every hydrated paywall's packages, keyed
 * paywallId -> packageIdentifier. Separate from the paywalls map so a
 * Stripe outage degrades to "no prices" rather than "no paywall".
 */
async function resolveFunnelPrices(
  projectId: string,
  paywalls: Record<string, HydratedPaywallEntry>,
): Promise<Record<string, Record<string, ResolvedPrice>>> {
  const out: Record<string, Record<string, ResolvedPrice>> = {};
  for (const [paywallId, entry] of Object.entries(paywalls)) {
    const packages = (entry.offering?.packages ?? []).map((p) => ({
      packageIdentifier: p.packageIdentifier,
      stripePriceId:
        (p.storeIds as { stripe?: string } | undefined)?.stripe ?? null,
    }));
    if (packages.length === 0) continue;
    out[paywallId] = await resolvePricesForPackages(projectId, packages);
  }
  return out;
}
```

Then, in the `GET /funnels/:slug` handler, after the paywalls map is built, resolve prices and include both in the response body:

```ts
      const paywalls = await hydrateFunnelPaywalls(funnel.id, pages);
      const prices = await resolveFunnelPrices(funnel.projectId, paywalls);
      return c.json(ok({ ...config, paywalls, prices }));
```

Prices are deliberately **not** written into the cached runtime config — the config cache has a 300s TTL of its own and prices have their own cache in Task 2; mixing them would make a price change wait for whichever TTL is longer.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnel-public-prices.test.ts` and `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS, 3 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public/funnels.ts apps/api/tests/funnel-public-prices.test.ts
git commit -m "feat(api): serve resolved Stripe prices with the public funnel bundle"
```

---

### Task 4: Fix the settings casing mismatch

**Files:**
- Modify: `apps/api/src/routes/dashboard/funnels.ts` (the `draft_settings_json` write path, around line 231)
- Create: `apps/api/src/services/funnel/settings-normalize.ts`
- Test: `apps/api/src/services/funnel/settings-normalize.test.ts`

**Interfaces:**
- Consumes: `settingsSchema` from `packages/shared/src/funnel/settings-schema.ts`.
- Produces: `normalizeFunnelSettings(raw: unknown): Record<string, unknown>`.

**Why:** the dashboard writes `devMode` / `universalLinkDomain` / `deepLinkScheme` / `iosUrl` / `androidUrl`; the API reads `dev_mode` / `universal_link_domain` / `deep_link_scheme` / `app_store_url` / `play_store_url`. Nothing translates, so `dev_mode` is never true and deep links never resolve.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/funnel/settings-normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeFunnelSettings } from "./settings-normalize";

describe("normalizeFunnelSettings", () => {
  it("translates the dashboard's camelCase keys to the API's snake_case", () => {
    expect(
      normalizeFunnelSettings({
        devMode: true,
        universalLinkDomain: "go.acme.com",
        deepLinkScheme: "acme",
        iosUrl: "https://apps.apple.com/app/id1",
        androidUrl: "https://play.google.com/store/apps/details?id=x",
      }),
    ).toEqual({
      dev_mode: true,
      universal_link_domain: "go.acme.com",
      deep_link_scheme: "acme",
      app_store_url: "https://apps.apple.com/app/id1",
      play_store_url: "https://play.google.com/store/apps/details?id=x",
    });
  });

  it("passes already-snake_case settings through unchanged", () => {
    const already = { dev_mode: false, deep_link_scheme: "acme" };
    expect(normalizeFunnelSettings(already)).toEqual(already);
  });

  it("prefers an explicit snake_case key over its camelCase twin", () => {
    expect(
      normalizeFunnelSettings({ dev_mode: false, devMode: true }),
    ).toEqual({ dev_mode: false });
  });

  it("keeps unrecognised keys so nothing is silently dropped", () => {
    expect(normalizeFunnelSettings({ somethingNew: 1 })).toEqual({
      somethingNew: 1,
    });
  });

  it("returns {} for a non-object", () => {
    expect(normalizeFunnelSettings(null)).toEqual({});
    expect(normalizeFunnelSettings("nope")).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/funnel/settings-normalize.test.ts`
Expected: FAIL — cannot resolve `./settings-normalize`.

- [ ] **Step 3: Implement the normalizer**

Create `apps/api/src/services/funnel/settings-normalize.ts`:

```ts
// =============================================================
// Funnel settings key normalization
// =============================================================
//
// The dashboard authored settings in camelCase while every reader in the
// API uses the snake_case names in
// packages/shared/src/funnel/settings-schema.ts. Nothing translated, so
// `dev_mode` was never true at runtime and deep links never resolved.
// Normalizing on WRITE fixes new saves; rows written before this keep
// their camelCase keys until their funnel is next saved, which is why
// readers must keep tolerating both for now.

const CAMEL_TO_SNAKE: Record<string, string> = {
  devMode: "dev_mode",
  universalLinkDomain: "universal_link_domain",
  deepLinkScheme: "deep_link_scheme",
  iosUrl: "app_store_url",
  androidUrl: "play_store_url",
};

/**
 * Rewrites known camelCase settings keys to their snake_case names.
 * Unrecognised keys pass through untouched — this is a rename, not a
 * whitelist, so a future setting is never silently dropped. An explicit
 * snake_case key always wins over its camelCase twin.
 */
export function normalizeFunnelSettings(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const target = CAMEL_TO_SNAKE[key];
    if (!target) {
      out[key] = value;
      continue;
    }
    // Don't let the camelCase twin clobber an explicit snake_case value.
    if (!(target in input)) out[target] = value;
  }

  return out;
}
```

- [ ] **Step 4: Apply it on the write path**

In `apps/api/src/routes/dashboard/funnels.ts`, change the settings assignment (around line 231) from:

```ts
    if (body.draft_settings_json !== undefined) {
      patch.draftSettingsJson = body.draft_settings_json;
    }
```

to:

```ts
    if (body.draft_settings_json !== undefined) {
      // The dashboard sends camelCase; every reader in the API uses the
      // snake_case names from settings-schema.ts. Translate here so
      // `dev_mode` and the deep-link fields actually reach the runtime.
      patch.draftSettingsJson = normalizeFunnelSettings(
        body.draft_settings_json,
      );
    }
```

with `import { normalizeFunnelSettings } from "../../services/funnel/settings-normalize";` at the top.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/funnel/settings-normalize.test.ts tests/funnels-publish-gate.test.ts` and `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/funnel/settings-normalize.ts apps/api/src/services/funnel/settings-normalize.test.ts apps/api/src/routes/dashboard/funnels.ts
git commit -m "fix(api): normalize funnel settings keys on write so dev_mode reaches the runtime"
```

---

### Task 5: `/advance` returns the paywall page id

**Files:**
- Modify: `packages/shared/src/funnel/evaluator.ts` (`resolveGoto`, lines 50-67)
- Modify: `apps/api/src/routes/public/funnels.ts` (the `/advance` handler's response, around line 409)
- Test: `apps/api/src/services/funnel/branching-evaluator.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveGoto` returns `{ next: "page", pageId }` for a paywall target whenever a paywall page exists.

**Why:** the evaluator holds the concrete page id in two of its three paywall branches and discards it, so `/advance` answers `{ next: "paywall" }`, the session's `currentPageId` never moves to the paywall, and the runner dead-ends.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/funnel/branching-evaluator.test.ts`:

```ts
it("returns the paywall page id on sequential fall-through", () => {
  const pages = [
    { id: "pg_info", type: "info", config: {} },
    { id: "pg_pay", type: "paywall", config: {} },
  ];
  expect(evaluate(pages, "pg_info", {})).toEqual({
    next: "page",
    pageId: "pg_pay",
  });
});

it("returns the paywall page id for an explicit goto by id", () => {
  const pages = [
    { id: "pg_info", type: "info", config: {}, default_next: "pg_pay" },
    { id: "pg_other", type: "info", config: {} },
    { id: "pg_pay", type: "paywall", config: {} },
  ];
  expect(evaluate(pages, "pg_info", {})).toEqual({
    next: "page",
    pageId: "pg_pay",
  });
});

it("resolves the literal `paywall` goto to the funnel's paywall page", () => {
  const pages = [
    { id: "pg_info", type: "info", config: {}, default_next: "paywall" },
    { id: "pg_pay", type: "paywall", config: {} },
  ];
  expect(evaluate(pages, "pg_info", {})).toEqual({
    next: "page",
    pageId: "pg_pay",
  });
});

it("keeps the id-less form only when the funnel has no paywall page", () => {
  // The publish validator rejects this (MISSING_PAYWALL), so it is
  // unreachable in practice — the branch stays so the type is total.
  const pages = [
    { id: "pg_info", type: "info", config: {}, default_next: "paywall" },
  ];
  expect(evaluate(pages, "pg_info", {})).toEqual({ next: "paywall" });
});
```

Match the existing file's import and `evaluate` call shape — read the top of that file first.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/funnel/branching-evaluator.test.ts`
Expected: FAIL — the first three return `{ next: "paywall" }`.

- [ ] **Step 3: Keep the id in `resolveGoto`**

In `packages/shared/src/funnel/evaluator.ts`, replace `resolveGoto` with:

```ts
function firstPaywallId(
  pagesOrder: string[],
  pagesById: PageGraph,
): string | null {
  for (const id of pagesOrder) {
    if (pagesById.get(id)?.type === "paywall") return id;
  }
  return null;
}

function resolveGoto(
  goto: string | "paywall" | "end" | "sequential",
  fromId: string,
  pagesOrder: string[],
  pagesById: PageGraph,
): EvalResult {
  if (goto === "paywall") {
    // The literal goto names no page. Resolve it to the funnel's paywall
    // page so the session's currentPageId can actually move there; the
    // id-less form survives only for a funnel with no paywall page,
    // which the publish validator already rejects.
    const paywallId = firstPaywallId(pagesOrder, pagesById);
    return paywallId ? { next: "page", pageId: paywallId } : { next: "paywall" };
  }
  if (goto === "end") return { next: "end" };
  if (goto === "sequential") {
    const idx = pagesOrder.indexOf(fromId);
    if (idx === -1 || idx === pagesOrder.length - 1) return { next: "end" };
    // A paywall page is a page like any other — it has an id and the
    // client needs it to render the paywall.
    return { next: "page", pageId: pagesOrder[idx + 1] };
  }
  return { next: "page", pageId: goto };
}
```

The two `pagesById.get(...)?.type === "paywall"` special cases are gone: a paywall page now resolves through the same path as every other page.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/funnel/branching-evaluator.test.ts src/services/funnel/branching-validator.test.ts` and `pnpm --filter @rovenue/shared test`
Expected: PASS. If an existing test asserted `{ next: "paywall" }` for a funnel that HAS a paywall page, update it — that expectation is the bug.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/funnel/evaluator.ts apps/api/src/services/funnel/branching-evaluator.test.ts
git commit -m "fix(shared): advance to the paywall page by id instead of dead-ending"
```

---

### Task 6: `POST /public/funnel-sessions/:sessionId/payment-intent`

**Files:**
- Create: `apps/api/src/routes/public/funnel-payment.ts`
- Modify: `apps/api/src/app.ts` (mount)
- Test: `apps/api/tests/funnel-payment-intent.test.ts`

**Interfaces:**
- Consumes: `resolvePricesForPackages` (Task 2), `requireConnectedStripe` / `chargesEnabled` (`apps/api/src/lib/stripe-platform.ts`), the facade from Task 1.
- Produces: `funnelPaymentRoute`; response `{ client_secret, mode: "payment" | "setup", publishable_key, stripe_account }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/funnel-payment-intent.test.ts` using the `vi.resetModules()` + `process.env` + dynamic `import("../src/app")` harness. Mock `@rovenue/db` (session, funnel, version, paywall, offering, purchase repos), `../src/lib/stripe-platform`, `../src/services/stripe/price-resolver`, and `../src/lib/redis`. The cases:

```ts
it("409s when the project cannot take charges", async () => {
  chargesEnabled.mockResolvedValue(false);
  const res = await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
  expect(res.status).toBe(409);
  expect(JSON.stringify(await res.json())).toContain("STRIPE_NOT_CONNECTED");
});

it("400s for a package that is not in the paywall's offering", async () => {
  const res = await post({ package_identifier: "$rov_smuggled", email: "a@b.c" });
  expect(res.status).toBe(400);
  expect(subscriptionsCreate).not.toHaveBeenCalled();
  expect(paymentIntentsCreate).not.toHaveBeenCalled();
});

it("creates a subscription for a recurring price and returns its client secret", async () => {
  const res = await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
  expect(subscriptionsCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      customer: "cus_1",
      items: [{ price: "price_m" }],
      payment_behavior: "default_incomplete",
    }),
  );
  const body = await res.json();
  expect(body.data.mode).toBe("payment");
  expect(body.data.client_secret).toBe("pi_secret");
});

it("uses setup mode when the price carries a trial", async () => {
  // trialDays: 7 -> no payment is captured now
  const body = await post({ package_identifier: "$rov_trial", email: "a@b.c" }).then((r) => r.json());
  expect(subscriptionsCreate).toHaveBeenCalledWith(
    expect.objectContaining({ trial_period_days: 7 }),
  );
  expect(body.data.mode).toBe("setup");
});

it("creates a payment intent for a one-time price", async () => {
  await post({ package_identifier: "$rov_lifetime", email: "a@b.c" });
  expect(paymentIntentsCreate).toHaveBeenCalledWith(
    expect.objectContaining({ amount: 9900, currency: "try", customer: "cus_1" }),
  );
});

// THE contract test for this task.
it("ignores an amount supplied by the client", async () => {
  await post({
    package_identifier: "$rov_lifetime",
    email: "a@b.c",
    amount: 1,
    unitAmount: 1,
    currency: "xxx",
  } as Record<string, unknown>);
  expect(paymentIntentsCreate).toHaveBeenCalledWith(
    expect.objectContaining({ amount: 9900, currency: "try" }),
  );
});

it("writes the presented context and session id into Stripe metadata", async () => {
  await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
  const params = subscriptionsCreate.mock.calls[0][0];
  expect(params.metadata.rovenue_funnel_session_id).toBe("sess_1");
  expect(JSON.parse(params.metadata.rovenue_presented_context).paywallId).toBe("pw_1");
});

it("records a pending purchase row", async () => {
  await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
  expect(upsertPurchase).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ status: "pending", amountCents: 4999, currency: "usd" }),
  );
});

it("409s when the session is already paid", async () => {
  findSessionById.mockResolvedValue({ id: "sess_1", state: "paid" });
  const res = await post({ package_identifier: "$rov_monthly", email: "a@b.c" });
  expect(res.status).toBe(409);
});

it("400s on a missing or malformed email", async () => {
  const res = await post({ package_identifier: "$rov_monthly", email: "not-an-email" });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnel-payment-intent.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/public/funnel-payment.ts`. Structure:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import { chargesEnabled, requireConnectedStripe } from "../../lib/stripe-platform";
import { resolvePricesForPackages } from "../../services/stripe/price-resolver";

// =============================================================
// Funnel on-page payment
// =============================================================
//
// The browser never says what to charge. It names a package; the server
// resolves that package through the funnel's published paywall to a
// Stripe Price on the connected account and derives the amount from
// there. An `amount` in the request body is ignored.
//
// Session identity is in the URL path because the public funnel CORS is
// `origin: "*"` and sends no credentials — a cookie would not survive.

const log = logger.child("route:funnel-payment");

const bodySchema = z.object({
  package_identifier: z.string().min(1),
  email: z.string().email(),
});

export const funnelPaymentRoute = new Hono().post(
  "/funnel-sessions/:sessionId/payment-intent",
  endpointRateLimit({ name: "funnel:payment-intent", max: 30 }),
  async (c) => {
    const sid = c.req.param("sessionId");
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "Invalid payment request" });
    }
    const { package_identifier: packageIdentifier, email } = parsed.data;

    const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    if (session.state !== "in_progress") {
      throw new HTTPException(409, { message: "Session is not payable" });
    }

    if (!(await chargesEnabled(session.projectId))) {
      throw new HTTPException(409, {
        message: JSON.stringify({ code: "STRIPE_NOT_CONNECTED" }),
      });
    }

    // Resolve the package through the funnel's PUBLISHED paywall. Doing
    // it this way is what stops a client naming an arbitrary price: the
    // identifier must appear in the offering this funnel actually
    // references.
    const context = await resolvePaywallContext(session, packageIdentifier);
    const prices = await resolvePricesForPackages(session.projectId, [
      { packageIdentifier, stripePriceId: context.stripePriceId },
    ]);
    const price = prices[packageIdentifier];
    if (!price) {
      throw new HTTPException(400, { message: "Package has no usable price" });
    }

    const { account } = await requireConnectedStripe(session.projectId);
    const customer = await account.customers.create({ email });

    const metadata = {
      rovenue_funnel_session_id: sid,
      rovenue_project_id: session.projectId,
      rovenue_funnel_id: session.funnelId,
      rovenue_presented_context: JSON.stringify(context.presentedContext),
    };

    let clientSecret: string | null;
    let mode: "payment" | "setup";
    let stripeSubscriptionId: string | null = null;
    let stripePaymentIntentId: string | null = null;

    if (price.interval) {
      const subscription = await account.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.priceId }],
        payment_behavior: "default_incomplete",
        ...(price.trialDays ? { trial_period_days: price.trialDays } : {}),
        expand: ["latest_invoice.payment_intent", "pending_setup_intent"],
        metadata,
      });
      stripeSubscriptionId = subscription.id;
      const setup = subscription.pending_setup_intent as
        | { client_secret?: string | null }
        | null;
      const invoice = subscription.latest_invoice as
        | { payment_intent?: { id?: string; client_secret?: string | null } | null }
        | null;
      if (setup?.client_secret) {
        // A trial captures nothing now — the card is only stored.
        clientSecret = setup.client_secret;
        mode = "setup";
      } else {
        clientSecret = invoice?.payment_intent?.client_secret ?? null;
        stripePaymentIntentId = invoice?.payment_intent?.id ?? null;
        mode = "payment";
      }
    } else {
      const intent = await account.paymentIntents.create({
        amount: price.unitAmount,
        currency: price.currency,
        customer: customer.id,
        automatic_payment_methods: { enabled: true },
        metadata,
      });
      stripePaymentIntentId = intent.id;
      clientSecret = intent.client_secret;
      mode = "payment";
    }

    if (!clientSecret) {
      log.error("stripe returned no client secret", { sessionId: sid });
      throw new HTTPException(502, { message: "Stripe did not return a client secret" });
    }

    await drizzle.funnelPurchaseRepo.upsertPending(drizzle.db, {
      sessionId: sid,
      projectId: session.projectId,
      productId: context.productId,
      amountCents: price.unitAmount,
      currency: price.currency,
      stripeCustomerId: customer.id,
      stripeSubscriptionId,
      stripePaymentIntentId,
    });

    const publishableKey = env.STRIPE_PLATFORM_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new HTTPException(503, { message: "Stripe Connect is not configured" });
    }

    return c.json(
      ok({
        client_secret: clientSecret,
        mode,
        publishable_key: publishableKey,
        stripe_account: (await requireConnectedStripe(session.projectId)).accountId,
      }),
    );
  },
);
```

Implement `resolvePaywallContext(session, packageIdentifier)` in the same file: load the published version, find the paywall page, load the referenced paywall and its offering, find the package by `packageIdentifier`, and return `{ productId, stripePriceId, presentedContext: { placementId, paywallId } }`. Throw `HTTPException(400)` when the identifier is not in the offering — that 400 is what the "smuggled package" test pins.

Add `upsertPending` to `packages/db/src/drizzle/repositories/funnel-purchases.ts` (the row is unique per session, and changing package before paying must not 500):

```ts
export async function upsertPending(
  db: Db,
  row: Omit<NewFunnelPurchase, "status">,
): Promise<FunnelPurchase> {
  const [saved] = await db
    .insert(funnelPurchases)
    .values({ ...row, status: "pending" })
    .onConflictDoUpdate({
      target: funnelPurchases.sessionId,
      set: { ...row, status: "pending" },
    })
    .returning();
  return saved;
}
```

`funnel_purchases` has no `stripe_payment_intent_id` column; add it in the migration from Task 10 (nullable text) so both writes land in one migration.

Mount in `apps/api/src/app.ts` next to the other public routes:

```ts
  .route("/public", funnelPaymentRoute)
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnel-payment-intent.test.ts` and `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS, 10 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public/funnel-payment.ts apps/api/src/app.ts packages/db/src/drizzle/repositories/funnel-purchases.ts apps/api/tests/funnel-payment-intent.test.ts
git commit -m "feat(api): create funnel payment intents server-side on the connected account"
```

---

### Task 7: Completion service and the confirm endpoint

**Files:**
- Create: `apps/api/src/services/funnel/complete-purchase.ts`
- Modify: `apps/api/src/routes/public/funnel-payment.ts` (add the confirm route)
- Test: `apps/api/src/services/funnel/complete-purchase.test.ts`, `apps/api/tests/funnel-confirm.test.ts`

**Interfaces:**
- Consumes: Task 6's route file, `generateClaimToken` / `hashToken` (`apps/api/src/services/funnel/token.ts`), `emitFunnelEvent` (`apps/api/src/services/funnel/outbox.ts`).
- Produces:
  ```ts
  export async function completeFunnelPurchase(input: {
    sessionId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string | null;
    stripePaymentIntentId: string | null;
  }): Promise<
    | { alreadyIssued: false; token: string }
    | { alreadyIssued: true }
  >;
  ```

**Note the return shape.** Only the token's *hash* is stored, so the plaintext
exists exactly once — in the response to whichever caller won. A second call
cannot return it and must not pretend to, which is why `token` is absent from
the `alreadyIssued: true` variant rather than being an empty string. The
discriminated union makes that unmissable at the call site.

**Why a shared service:** both the confirm endpoint and the webhook backstop must perform the identical transition, and either may win.

- [ ] **Step 1: Write the failing service test**

Create `apps/api/src/services/funnel/complete-purchase.test.ts` asserting: it marks the purchase paid, transitions the session to `paid`, mints one claim token, emits `funnel.session.paid` and `funnel.claim_token.issued` inside the same transaction, and — called twice for the same session — returns the first token with `alreadyIssued: true` and mints no second row.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/funnel/complete-purchase.test.ts`
Expected: FAIL — cannot resolve `./complete-purchase`.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/funnel/complete-purchase.ts`:

```ts
import { drizzle } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { emitFunnelEvent } from "./outbox";
import { generateClaimToken, hashToken } from "./token";

// =============================================================
// Completing a paid funnel session
// =============================================================
//
// Two callers race here on purpose: the browser's /confirm and the
// Connect webhook (for the buyer who closed the tab). Either may win, so
// this must be idempotent — and because only the token's HASH is stored,
// the plaintext exists exactly once, in the winner's return value. The
// loser gets `alreadyIssued: true` and no token rather than a fake one.

const log = logger.child("funnel-complete-purchase");

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CompleteResult =
  | { alreadyIssued: false; token: string }
  | { alreadyIssued: true };

export async function completeFunnelPurchase(input: {
  sessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  stripePaymentIntentId: string | null;
}): Promise<CompleteResult> {
  const plaintext = generateClaimToken();

  return drizzle.db.transaction(async (tx) => {
    const session = await drizzle.funnelSessionRepo.findById(tx, input.sessionId);
    if (!session) throw new Error(`funnel session ${input.sessionId} not found`);

    const purchase = await drizzle.funnelPurchaseRepo.findBySession(
      tx,
      input.sessionId,
    );
    if (!purchase) {
      throw new Error(`no purchase for funnel session ${input.sessionId}`);
    }
    if (purchase.status === "paid") {
      log.info("funnel session already completed; not minting a second token", {
        sessionId: input.sessionId,
      });
      return { alreadyIssued: true };
    }

    // Anchor a synthetic subscriber on the Stripe customer. The Connect
    // webhook's resolveSubscriber falls back to the same `stripe:<id>`
    // shape, so both paths converge on one row instead of fabricating
    // two identities for the same buyer. The claim merges it into the
    // installed subscriber later.
    const subscriber = await drizzle.subscriberRepo.upsertSubscriber(tx, {
      projectId: session.projectId,
      rovenueId: `stripe:${input.stripeCustomerId}`,
      appUserId: `stripe:${input.stripeCustomerId}`,
      createAttributes: { stripe_customer_id: input.stripeCustomerId },
    });

    await drizzle.funnelPurchaseRepo.markPaid(tx, purchase.id, {
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripePaymentIntentId: input.stripePaymentIntentId,
      subscriberId: subscriber.id,
    });
    await drizzle.funnelSessionRepo.setState(tx, input.sessionId, "paid");

    const tokenRow = await drizzle.funnelClaimTokenRepo.insert(tx, {
      tokenHash: hashToken(plaintext),
      sessionId: input.sessionId,
      projectId: session.projectId,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });

    const payload = {
      funnel_id: session.funnelId,
      version_id: session.funnelVersionId,
      project_id: session.projectId,
      purchase_id: purchase.id,
      token_id: tokenRow.id,
    };
    await emitFunnelEvent(tx, "funnel.session.paid", input.sessionId, payload);
    await emitFunnelEvent(
      tx,
      "funnel.claim_token.issued",
      input.sessionId,
      payload,
    );

    return { alreadyIssued: false, token: plaintext };
  });
}
```

`funnel_purchases` needs a `subscriber_id` column for the anchor; add it to the
Task 10 migration alongside `stripe_payment_intent_id`, and mirror both in
`packages/db/src/drizzle/schema.ts`.

- [ ] **Step 4: Add the confirm route**

Append to `apps/api/src/routes/public/funnel-payment.ts`:

```ts
  .post(
    "/funnel-sessions/:sessionId/confirm",
    endpointRateLimit({ name: "funnel:confirm", max: 30 }),
    async (c) => {
      const sid = c.req.param("sessionId");
      const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
      if (!session) throw new HTTPException(404, { message: "Session not found" });

      const purchase = await drizzle.funnelPurchaseRepo.findBySession(drizzle.db, sid);
      if (!purchase) throw new HTTPException(409, { message: "No payment started" });

      // The browser's word is not evidence. Ask Stripe.
      const { account } = await requireConnectedStripe(session.projectId);
      const settled = await isSettled(account, purchase);
      if (!settled) {
        throw new HTTPException(409, { message: "Payment is not complete" });
      }

      const result = await completeFunnelPurchase({
        sessionId: sid,
        stripeCustomerId: purchase.stripeCustomerId as string,
        stripeSubscriptionId: purchase.stripeSubscriptionId,
        stripePaymentIntentId: purchase.stripePaymentIntentId,
      });

      // The plaintext exists exactly once. A repeat call says so plainly
      // rather than inventing a token the client cannot use.
      if (result.alreadyIssued) {
        return c.json(ok({ already_issued: true as const }));
      }

      return c.json(
        ok({ already_issued: false as const, ...buildClaimLinks(session, result.token) }),
      );
    },
  );
```

`isSettled` retrieves the subscription (accept `active` or `trialing`) or the payment intent (accept `succeeded`). `buildClaimLinks` reuses the deep-link / universal-link construction already in `apps/api/src/routes/public/funnels.ts` — extract it into `apps/api/src/services/funnel/claim-links.ts` and have both call sites use it rather than duplicating the string building.

- [ ] **Step 5: Write the route tests**

Create `apps/api/tests/funnel-confirm.test.ts` asserting: 409 when Stripe says the intent is not succeeded; 200 with a token when it is; `trialing` counts as settled; `succeeded` one-time counts as settled; two calls return the same token and mint one row; 409 when no payment was started.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/funnel/complete-purchase.test.ts tests/funnel-confirm.test.ts` and `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/funnel/complete-purchase.ts apps/api/src/services/funnel/claim-links.ts apps/api/src/routes/public/funnel-payment.ts apps/api/src/routes/public/funnels.ts apps/api/src/services/funnel/complete-purchase.test.ts apps/api/tests/funnel-confirm.test.ts
git commit -m "feat(api): confirm funnel payments against Stripe and mint the claim token"
```

---

### Task 8: Webhook backstop

**Files:**
- Modify: `apps/api/src/services/stripe/stripe-webhook.ts`
- Test: `apps/api/src/services/stripe/stripe-webhook.funnel.test.ts`

**Interfaces:**
- Consumes: `completeFunnelPurchase` (Task 7).
- Produces: nothing new.

**Why:** if the buyer closes the tab after paying, `confirm` is never called. The Connect webhook already receives the event for that account.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/stripe/stripe-webhook.funnel.test.ts`:

```ts
it("completes the funnel session when the event carries a session id", async () => {
  // invoice.paid whose subscription metadata has
  // rovenue_funnel_session_id: "sess_1"
  await processStripeEvent({ projectId: "proj_1", event, account });
  expect(completeFunnelPurchase).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "sess_1" }),
  );
});

it("ignores an event with no funnel session id", async () => {
  await processStripeEvent({ projectId: "proj_1", event: plainEvent, account });
  expect(completeFunnelPurchase).not.toHaveBeenCalled();
});

it("is a no-op when confirm already completed the session", async () => {
  completeFunnelPurchase.mockResolvedValue({ token: "", alreadyIssued: true });
  await expect(
    processStripeEvent({ projectId: "proj_1", event, account }),
  ).resolves.toMatchObject({ status: "processed" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/stripe/stripe-webhook.funnel.test.ts`
Expected: FAIL — `completeFunnelPurchase` is never called.

- [ ] **Step 3: Wire the backstop**

In the subscription/invoice handlers, after the existing purchase sync, read `rovenue_funnel_session_id` from the subscription metadata and, when present, call `completeFunnelPurchase`. It is idempotent, so a race with `confirm` is safe either way.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/stripe/` and `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stripe/stripe-webhook.ts apps/api/src/services/stripe/stripe-webhook.funnel.test.ts
git commit -m "feat(api): complete a funnel session from the Connect webhook when confirm never runs"
```

---

### Task 9: Claim-time convergence — merge the synthetic subscriber and return real entitlements

**Files:**
- Modify: `apps/api/src/routes/v1/funnel-claim.ts` (the claim transaction and `buildClaimResponse`, around lines 78-96 and 181-217)
- Test: `apps/api/tests/funnel-claim-convergence.test.ts`

**Interfaces:**
- Consumes: `reassignAllAssets` (`apps/api/src/services/subscriber-transfer.ts:64`), `drizzle.funnelPurchaseRepo.findBySession`, `drizzle.accessRepo`.
- Produces: `buildClaimResponse` returns the merged subscriber's real access ids.

**Why both in one task:** Task 7 creates a synthetic subscriber at payment time, anchored on the Stripe customer, because the buyer has not installed the app yet. The purchase, its access and its revenue events all hang off that row. Claim is where it has to become the installed subscriber — and returning entitlements without doing the merge would return the *installed* subscriber's access, which is empty, so the two changes are the same fix.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/funnel-claim-convergence.test.ts`:

```ts
it("merges the synthetic subscriber into the claiming one", async () => {
  findPurchaseBySession.mockResolvedValue({
    id: "pur_1",
    subscriberId: "sub_synthetic",
  });
  resolveSubscriber.mockResolvedValue({ id: "sub_installed" });

  await claim({ token, anon_id: "a1" });

  expect(reassignAllAssets).toHaveBeenCalledWith(
    expect.anything(),
    "proj_1",
    expect.objectContaining({ id: "sub_synthetic" }),
    expect.objectContaining({ id: "sub_installed" }),
  );
});

it("does not merge when the purchase has no synthetic subscriber", async () => {
  // dev-stub purchases predate the payment flow and have none
  findPurchaseBySession.mockResolvedValue({ id: "pur_1", subscriberId: null });
  await claim({ token, anon_id: "a1" });
  expect(reassignAllAssets).not.toHaveBeenCalled();
});

it("does not merge a subscriber into itself", async () => {
  findPurchaseBySession.mockResolvedValue({
    id: "pur_1",
    subscriberId: "sub_installed",
  });
  resolveSubscriber.mockResolvedValue({ id: "sub_installed" });
  await claim({ token, anon_id: "a1" });
  expect(reassignAllAssets).not.toHaveBeenCalled();
});

it("returns the claiming subscriber's active access ids", async () => {
  findAllAccessBySubscriber.mockResolvedValue([
    { accessId: "pro", isActive: true },
    { accessId: "legacy", isActive: false },
  ]);
  const body = await claim({ token, anon_id: "a1" }).then((r) => r.json());
  expect(body.data.entitlements).toEqual(["pro"]);
});

it("returns an empty array when there is no active access", async () => {
  findAllAccessBySubscriber.mockResolvedValue([]);
  const body = await claim({ token, anon_id: "a1" }).then((r) => r.json());
  expect(body.data.entitlements).toEqual([]);
});

it("reads access AFTER the merge, not before", async () => {
  // Ordering matters: the entitlements being claimed are the ones the
  // merge just moved across. Reading first would always return [].
  const order: string[] = [];
  reassignAllAssets.mockImplementation(async () => {
    order.push("merge");
  });
  findAllAccessBySubscriber.mockImplementation(async () => {
    order.push("read");
    return [{ accessId: "pro", isActive: true }];
  });
  findPurchaseBySession.mockResolvedValue({ id: "pur_1", subscriberId: "sub_synthetic" });
  resolveSubscriber.mockResolvedValue({ id: "sub_installed" });

  await claim({ token, anon_id: "a1" });

  expect(order).toEqual(["merge", "read"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnel-claim-convergence.test.ts`
Expected: FAIL — `reassignAllAssets` is never called and `entitlements` is `[]`.

- [ ] **Step 3: Merge inside the claim transaction**

In `apps/api/src/routes/v1/funnel-claim.ts`, inside the existing transaction that performs `tryClaim` and `setState(sessionId, "completed")`, after the claim succeeds and before building the response:

```ts
      // The purchase was made before this person had an app install, so
      // it hangs off a synthetic subscriber anchored on the Stripe
      // customer. Move everything — purchases, access, revenue events,
      // experiment assignments, credits — onto the subscriber that is
      // actually claiming, and soft-delete the synthetic as merged.
      const purchase = await drizzle.funnelPurchaseRepo.findBySession(
        tx,
        tokenRow.sessionId,
      );
      if (purchase?.subscriberId && purchase.subscriberId !== subscriber.id) {
        await reassignAllAssets(
          tx,
          tokenRow.projectId,
          { id: purchase.subscriberId, label: "funnel purchase" },
          { id: subscriber.id, label: "claiming subscriber" },
        );
      }
```

with `import { reassignAllAssets } from "../../services/subscriber-transfer";` at the top.

- [ ] **Step 4: Return the real entitlements**

Change `buildClaimResponse` so it reads the subscriber's access rows instead of returning a literal:

```ts
async function buildClaimResponse(
  sessionId: string,
  subscriberId: string,
): Promise<{
  subscriber_id: string;
  entitlements: string[];
  funnel_answers: Record<string, unknown>;
}> {
  const answers = await drizzle.funnelAnswerRepo.listBySession(
    drizzle.db,
    sessionId,
  );
  const funnel_answers: Record<string, unknown> = {};
  for (const a of answers) {
    const payload = a.answerJson as { value: unknown } | null;
    funnel_answers[a.questionId] = payload?.value;
  }

  // Read AFTER the merge above — these are the entitlements the merge
  // just moved onto this subscriber. Reading before would always be [].
  const access = await drizzle.accessRepo.findAllAccessBySubscriber(
    drizzle.db,
    subscriberId,
  );
  const entitlements = access
    .filter((row) => row.isActive)
    .map((row) => row.accessId);

  return { subscriber_id: subscriberId, entitlements, funnel_answers };
}
```

`findAllAccessBySubscriber(db, subscriberId)` already exists
(`packages/db/src/drizzle/repositories/access.ts:102`) and returns every row,
active and inactive — hence the `isActive` filter above. No repository change
is needed.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnel-claim-convergence.test.ts` and `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS, 6 tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/funnel-claim.ts apps/api/tests/funnel-claim-convergence.test.ts
git commit -m "fix(api): merge the funnel purchase's subscriber on claim and return real entitlements"
```

---

### Task 10: Apple Pay domain registration

**Files:**
- Create: `apps/api/src/services/stripe/apple-pay-domain.ts`
- Create: `packages/db/drizzle/migrations/0089_funnel_payment.sql` (+ its `meta/_journal.json` entry)
- Modify: `packages/db/src/drizzle/schema.ts`, `packages/db/src/drizzle/repositories/project-stripe-connections.ts`, `apps/api/src/routes/stripe-oauth.ts`
- Test: `apps/api/src/services/stripe/apple-pay-domain.test.ts`

**Interfaces:**
- Consumes: the facade's `paymentMethodDomains` (Task 1).
- Produces: `registerApplePayDomain(projectId): Promise<"registered" | "failed" | "skipped">`.

- [ ] **Step 1: Write the migration**

`0089_funnel_payment.sql` adds three columns and its journal entry (`idx: 89`, `tag: "0089_funnel_payment"`, `version: "7"`, `breakpoints: true`, `when` greater than the previous entry). **The migrator resolves which files run from the journal — a hand-written `.sql` without an entry is silently never applied.**

```sql
ALTER TABLE "project_stripe_connections"
  ADD COLUMN IF NOT EXISTS "apple_pay_domain_status" text NOT NULL DEFAULT 'unregistered';
ALTER TABLE "project_stripe_connections"
  ADD COLUMN IF NOT EXISTS "apple_pay_domain_checked_at" timestamptz;
ALTER TABLE "funnel_purchases"
  ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text;
```

Mirror all three in `packages/db/src/drizzle/schema.ts`.

- [ ] **Step 2: Write the failing test**

Assert: registers the configured domain on the connected account and records `registered`; records `failed` and does not throw when Stripe rejects; returns `skipped` with no Stripe call when the project has no connection; does not re-register a domain already listed.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/stripe/apple-pay-domain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement and call it on connect**

`registerApplePayDomain` lists existing domains first, creates when absent, and records the outcome through a new `updateApplePayDomainStatus(db, id, status)` repository function. Call it from the OAuth callback after the connection row is written, wrapped so a failure never breaks the connect flow — Apple Pay being unavailable must not stop a customer connecting.

- [ ] **Step 5: Run the tests and the migration**

Run: `pnpm db:migrate && pnpm --filter @rovenue/api exec vitest run src/services/stripe/apple-pay-domain.test.ts tests/stripe-connect-routes.test.ts`
Expected: migration applies; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/migrations/0089_funnel_payment.sql packages/db/drizzle/migrations/meta/_journal.json packages/db/src/drizzle/schema.ts packages/db/src/drizzle/repositories/project-stripe-connections.ts apps/api/src/services/stripe/apple-pay-domain.ts apps/api/src/services/stripe/apple-pay-domain.test.ts apps/api/src/routes/stripe-oauth.ts
git commit -m "feat(api): register the funnel domain for Apple Pay on connect"
```

---

### Task 11: Runner payment step

**Files:**
- Create: `apps/dashboard/src/runner/payment-step.tsx`
- Modify: `apps/dashboard/src/runner/funnel-runner.tsx`, `apps/dashboard/src/runner/runner-api.ts`
- Test: `apps/dashboard/src/runner/payment-step.test.tsx`

**Interfaces:**
- Consumes: `POST /public/funnel-sessions/:sid/payment-intent` and `/confirm` (Tasks 6-7), the `prices` map (Task 3).
- Produces: `<PaymentStep sessionId packageIdentifier onPaid onCancel />`.

- [ ] **Step 1: Write the failing test**

Assert with `@testing-library/react` + `renderWithRouter` + `waitFor`: it asks for an email before creating an intent when the funnel collected none; it renders Express Checkout and Payment Element once a client secret arrives; a declined confirmation keeps the user on the step and shows Stripe's message; a successful confirmation calls `onPaid` with the token. Mock `@stripe/react-stripe-js` so no network or iframe is involved.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/runner/payment-step.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the step**

`payment-step.tsx` calls `createPaymentIntent(sessionId, { package_identifier, email })`, then mounts:

```tsx
<Elements
  stripe={loadStripe(res.publishable_key, { stripeAccount: res.stripe_account })}
  options={{ clientSecret: res.client_secret }}
>
  <ExpressCheckoutElement onConfirm={handleExpress} />
  <PaymentElement />
</Elements>
```

Confirmation uses `stripe.confirmPayment({ elements, redirect: "if_required" })` — or `confirmSetup` when `mode === "setup"` — then calls `confirmFunnelPayment(sessionId)` and hands the returned token to `onPaid`. **The user never leaves the page**; `redirect: "if_required"` is what guarantees that.

Add `createPaymentIntent` and `confirmFunnelPayment` to `runner-api.ts` following the existing plain-`fetch`, no-credentials style.

- [ ] **Step 4: Wire it into the runner**

In `funnel-runner.tsx`, replace `priceView={undefined}` with the formatted prices for this paywall (`Intl.NumberFormat(locale, { style: "currency", currency }).format(unitAmount / 100)` for `price`, and the interval for `period`), and replace `onPurchase={() => void handleAdvance()}` with one that opens `<PaymentStep>` for the selected package. Delete the `currentPage.type === "paywall"` shortcut in `handleAdvance` — the dev-stub claim path is no longer the paywall's route through.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/runner/` and `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/runner/payment-step.tsx apps/dashboard/src/runner/payment-step.test.tsx apps/dashboard/src/runner/funnel-runner.tsx apps/dashboard/src/runner/runner-api.ts
git commit -m "feat(dashboard): collect payment on the funnel paywall page"
```

---

### Task 12: End-to-end integration test

**Files:**
- Create: `apps/api/tests/funnel-payment.integration.test.ts`

- [ ] **Step 1: Write the test**

Against the real Postgres (5433) and Redis (6380), with Stripe stubbed only at the `stripe-account-scoped` boundary. `process.env.DATABASE_URL ??=` must be the first statement in the file, above every import. Prove in one run:

1. `POST /payment-intent` with a package that is in the funnel's paywall offering creates a subscription on the connected account and writes a `pending` purchase row with the amount from the Price.
2. The same call with an unknown package identifier 400s and writes nothing.
3. `POST /confirm` while Stripe still reports `incomplete` 409s and leaves the session `in_progress`.
4. `POST /confirm` once Stripe reports `active` flips the purchase to `paid`, the session to `paid`, and returns a token; exactly one `funnel_claim_tokens` row exists.
5. Calling `/confirm` again returns without minting a second token.
6. The claim endpoint then merges the synthetic subscriber into an installed one and returns non-empty `entitlements`.
7. The tab-closed variant: skip `/confirm` entirely, deliver the webhook, and assert the session reaches `paid` with one token.

Clean up in `afterAll` using ids unique to the run.

- [ ] **Step 2: Run it twice**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnel-payment.integration.test.ts` twice in the same session.
Expected: PASS both times with identical counts, proving it leaves no state that breaks a rerun.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/funnel-payment.integration.test.ts
git commit -m "test(api): end-to-end funnel on-page payment integration test"
```

---

## Operator runbook (post-merge, before deploy)

1. Serve Stripe's payment-method-domain verification file from `app.rovenue.io` at the well-known path Stripe checks. **Without it, registration reports the domain unverified and Apple Pay silently does not appear** — the card form still works, so this fails quietly and must be asserted after deploy.
2. Set `STRIPE_PLATFORM_PUBLISHABLE_KEY` and `STRIPE_PLATFORM_PUBLISHABLE_KEY_TEST`. They were declared in B1 and never read; the payment step cannot mount without them.
3. Run `pnpm db:migrate` for `0089_funnel_payment`.
4. Run the Apple Pay reconcile for accounts connected before this ships.

Existing funnels keep working untouched until republished: a paywall page only takes payment when it references a paywall with a builder config and the project can take charges.
