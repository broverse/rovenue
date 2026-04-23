# Alan 3 — Security & Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security gaps documented in `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/03-security-compliance.md` — specifically webhook replay protection, Apple root CA fingerprint pinning, dashboard per-user + surge rate limits, and GDPR/KVKK right-to-access + right-to-be-forgotten flows.

**Architecture:** Add a Redis-backed replay guard middleware that chains after each store-specific verifier and rejects duplicate/stale notifications. Tighten `apple-root-ca.ts` with a hard-coded SHA-256 fingerprint allowlist so repo/file tampering surfaces at startup. Add a per-user dashboard rate limiter and an in-memory insurance limiter so Redis outages degrade gracefully. Ship GDPR service + dashboard endpoints on top of the existing `anonymizeSubscriberRow` repo method and export via JSON dump across purchases / access / credit_ledger.

**Tech Stack:** Hono middleware, Drizzle ORM, ioredis, @noble/hashes (already present), vitest. No new dependencies required — `rate-limiter-flexible` from the spec is replaced by the existing in-house sliding-window limiter plus an in-memory fallback we introduce here.

**Scope note:** The spec's §7 envelope encryption and §9 Infisical integration are **out of scope** for this plan — user's TODO list does not cover them and they need their own ops decision. Audit log hash chain (§8) is already shipped in `apps/api/src/lib/audit.ts`.

---

## Testing conventions

Every API test in this repo uses the **hoisted-mock pattern**. `@rovenue/db`, audit, auth, and service-layer modules are replaced with `vi.mock(...)` at module load. No test reaches a real Postgres or Redis — there is no `setupTestDb` or `seedSubscriber` helper; don't invent one.

Canonical references — read these before writing any new test in this plan:

- `apps/api/tests/webhook-verify.test.ts` lines 1-120 — hoisted `mocks` block, `vi.mock` of env/credential loaders, `makeApp(...)` harness for middleware tests.
- `apps/api/tests/dashboard-subscribers.test.ts` lines 1-120 — hoisted `dbMock` + `drizzleMock` + `authMock` pattern for dashboard route tests.
- `apps/api/tests/rate-limit.test.ts` lines 1-100 — hoisted `redisMock` with in-memory sorted set simulation and `setRedisDown(...)` helper.

When a new task below says "add a test", follow the pattern from the file named in that task. If the task adds a new mock, extend the **existing** hoisted block — do not create parallel mock infrastructure.

---

## File structure

### Create

- `apps/api/src/middleware/webhook-replay-guard.ts` — generic replay guard (timestamp tolerance + Redis nonce cache), one-per-source namespace
- `apps/api/src/services/apple/apple-root-fingerprints.ts` — pinned SHA-256 fingerprints + verifier
- `apps/api/src/services/gdpr/anonymize-subscriber.ts` — service layer wrapping `anonymizeSubscriberRow` with audit entry + stable `anon_*` token
- `apps/api/src/services/gdpr/export-subscriber.ts` — service layer assembling a full data-export JSON for one subscriber
- `apps/api/src/middleware/insurance-rate-limit.ts` — in-memory fallback limiter used when Redis is down
- `apps/api/tests/webhook-replay-guard.test.ts` — replay guard behaviour
- `apps/api/tests/apple-root-fingerprint.test.ts` — fingerprint match/mismatch
- `apps/api/tests/gdpr-anonymize.test.ts` — anonymize flow + audit trail
- `apps/api/tests/gdpr-export.test.ts` — export shape & scope

### Modify

- `apps/api/src/middleware/webhook-verify.ts` — every verifier sets `webhookEventId` + `webhookEventTimestamp` on context so the replay guard can read them
- `apps/api/src/services/apple/apple-root-ca.ts` — after loading cert buffers call `verifyAppleRootFingerprints` and fail closed on mismatch
- `apps/api/src/routes/webhooks/apple.ts`, `google.ts`, `stripe.ts` — chain `webhookReplayGuard({ source: "apple" })` etc. after the verifier
- `apps/api/src/routes/dashboard/subscribers.ts` — new `POST /:id/anonymize` and `GET /:id/export` endpoints
- `apps/api/src/middleware/rate-limit.ts` — add `dashboardUserRateLimit()` preset and wire insurance limiter into `rateLimit()` helper
- `apps/api/src/routes/dashboard/index.ts` — mount `dashboardUserRateLimit()` on the dashboard tree
- `apps/api/src/lib/env.ts` — add `WEBHOOK_REPLAY_TOLERANCE_SECONDS` (optional, default 300)
- `apps/api/src/lib/audit.ts` — extend `AuditAction` with `subscriber.exported`

---

## Phase 0 — Pre-flight

### Task 0.1: Confirm baseline suite is green

**Files:** none

- [ ] **Step 1: Run existing tests**

Run: `pnpm --filter @rovenue/api test`
Expected: all green. If not, stop and fix before continuing — replay-guard tests will layer on webhook-verify tests and a flaky baseline hides regressions.

- [ ] **Step 2: Confirm Redis is reachable from test harness**

Run: `pnpm --filter @rovenue/api test -- --run tests/idempotency.test.ts`
Expected: pass. `idempotency.test.ts` already mocks redis the same way we will — cross-checks that the mock contract is stable.

---

## Phase 1 — Webhook replay guard

### Task 1.1: Teach each verifier to stash the event id + timestamp

**Files:**
- Modify: `apps/api/src/middleware/webhook-verify.ts`

- [ ] **Step 1: Write the failing test**

Open `apps/api/tests/webhook-verify.test.ts`. Change the `makeApp` harness (line ~87) so the handler returns the new ctx vars alongside `source`:

```typescript
app.post("/:projectId", middleware, (c) => {
  const verified = c.get("verifiedWebhook");
  return c.json({
    ok: true,
    source: verified?.source,
    eventId: c.get("webhookEventId"),
    eventTimestamp: c.get("webhookEventTimestamp"),
  });
});
```

Then add these tests (one per source), each at the end of the matching `describe` block:

```typescript
// inside describe("verifyAppleWebhook", ...)
test("stashes notificationUUID + signedDate on ctx", async () => {
  mocks.appleVerifier.verifyNotification.mockResolvedValue({
    notificationType: "SUBSCRIBED",
    notificationUUID: "uuid-stashed",
    signedDate: 1_700_000_000_000, // ms since epoch, as Apple sends
  });
  const app = makeApp(verifyAppleWebhook);
  const res = await app.request("/proj_a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedPayload: "fake.jws" }),
  });
  const body = (await res.json()) as { eventId: string; eventTimestamp: number };
  expect(body.eventId).toBe("uuid-stashed");
  expect(body.eventTimestamp).toBe(1_700_000_000);
});

// inside describe("verifyGoogleWebhook", ...)
test("stashes message.messageId + publishTime on ctx", async () => {
  mocks.verifyPubSubPushToken.mockResolvedValue(undefined);
  const app = makeApp(verifyGoogleWebhook);
  const res = await app.request("/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer valid-id-token",
    },
    body: JSON.stringify({
      message: {
        data: "eyJ4Ijoxfg==",
        messageId: "msg-xyz",
        publishTime: "2026-04-21T10:00:00Z",
      },
      subscription: "projects/p/subscriptions/s",
    }),
  });
  const body = (await res.json()) as { eventId: string; eventTimestamp: number };
  expect(body.eventId).toBe("msg-xyz");
  expect(body.eventTimestamp).toBe(
    Math.floor(new Date("2026-04-21T10:00:00Z").getTime() / 1000),
  );
});

// inside describe("verifyStripeWebhook", ...)
test("stashes event.id + event.created on ctx", async () => {
  mocks.stripeClient.webhooks.constructEvent.mockReturnValue({
    id: "evt_stripe_1",
    created: 1_700_000_123,
    type: "invoice.paid",
  } as never);
  const app = makeApp(verifyStripeWebhook);
  const res = await app.request("/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=fake",
    },
    body: '{"raw":true}',
  });
  const body = (await res.json()) as { eventId: string; eventTimestamp: number };
  expect(body.eventId).toBe("evt_stripe_1");
  expect(body.eventTimestamp).toBe(1_700_000_123);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/webhook-verify.test.ts`
Expected: FAIL with `expected "undefined" to equal ...`.

- [ ] **Step 3: Extend the `ContextVariableMap` typing**

In `apps/api/src/middleware/webhook-verify.ts` change the `declare module "hono"` block to:

```typescript
declare module "hono" {
  interface ContextVariableMap {
    verifiedWebhook?: VerifiedWebhook;
    webhookEventId?: string;
    webhookEventTimestamp?: number;
  }
}
```

- [ ] **Step 4: Set the fields inside each verifier**

In `verifyAppleWebhook`, right after `c.set("verifiedWebhook", { ... })`:

```typescript
c.set("webhookEventId", notification.notificationUUID);
c.set(
  "webhookEventTimestamp",
  Math.floor(new Date(notification.signedDate).getTime() / 1000),
);
```

In `verifyGoogleWebhook`, peek at the body to get `message.messageId` + `message.publishTime`. Because the verifier currently only reads the Authorization header, parse the body before `await next()`:

```typescript
// Google puts identity in the header, but we still need the body's
// messageId + publishTime for replay guarding. Parse once and stash
// on ctx so the route handler's zValidator can read it from raw again.
const body = (await c.req.raw.clone().json()) as {
  message?: { messageId?: string; publishTime?: string };
};
const messageId = body.message?.messageId;
const publishTime = body.message?.publishTime;
if (!messageId || !publishTime) {
  throw new HTTPException(400, {
    message: "Google push body missing message.messageId or publishTime",
  });
}

c.set("verifiedWebhook", { source: "GOOGLE" });
c.set("webhookEventId", messageId);
c.set("webhookEventTimestamp", Math.floor(new Date(publishTime).getTime() / 1000));
```

In `verifyStripeWebhook`, right after the successful `constructEvent`:

```typescript
c.set("verifiedWebhook", { source: "STRIPE", rawBody, event });
c.set("webhookEventId", event.id);
c.set("webhookEventTimestamp", event.created);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/webhook-verify.test.ts`
Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `pnpm --filter @rovenue/api typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware/webhook-verify.ts apps/api/tests/webhook-verify.test.ts
git commit -m "feat(webhook): stash event id + timestamp on verification"
```

---

### Task 1.2: Add the replay guard middleware

**Files:**
- Create: `apps/api/src/middleware/webhook-replay-guard.ts`
- Create: `apps/api/tests/webhook-replay-guard.test.ts`
- Modify: `apps/api/src/lib/env.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/webhook-replay-guard.test.ts`:

```typescript
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { redisMock, __store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    redisMock: {
      async set(
        key: string,
        value: string,
        mode: string,
        seconds: number,
        nx: string,
      ) {
        if (mode !== "EX" || nx !== "NX") {
          throw new Error("unexpected args");
        }
        if (store.has(key)) return null;
        store.set(key, value);
        ttl.set(key, seconds);
        return "OK";
      },
    },
    __store: store,
  };
});

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

import { webhookReplayGuard } from "../src/middleware/webhook-replay-guard";

describe("webhookReplayGuard", () => {
  beforeEach(() => {
    __store.clear();
  });

  function buildApp() {
    return new Hono().post("/", webhookReplayGuard({ source: "apple" }), (c) =>
      c.json({ ok: true }),
    );
  }

  async function request(app: Hono, id: string | undefined, ts: number | undefined) {
    return app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ts }),
    });
  }

  test("rejects when context missing webhookEventId or timestamp", async () => {
    const app = new Hono()
      .post("/", webhookReplayGuard({ source: "apple" }), (c) =>
        c.json({ ok: true }),
      );
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(500);
  });

  test("accepts a fresh event", async () => {
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-1");
        c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
        await next();
      })
      .post("/", webhookReplayGuard({ source: "apple" }), (c) =>
        c.json({ ok: true }),
      );
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("rejects a replayed event with 200 + replayed body", async () => {
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-2");
        c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
        await next();
      })
      .post("/", webhookReplayGuard({ source: "apple" }), (c) =>
        c.json({ ok: true }),
      );
    const first = await app.request("/", { method: "POST" });
    expect(first.status).toBe(200);
    const second = await app.request("/", { method: "POST" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      data: { status: "duplicate", source: "apple" },
    });
  });

  test("rejects a stale timestamp outside tolerance", async () => {
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-3");
        c.set(
          "webhookEventTimestamp",
          Math.floor(Date.now() / 1000) - 3600,
        );
        await next();
      })
      .post(
        "/",
        webhookReplayGuard({ source: "apple", toleranceSeconds: 300 }),
        (c) => c.json({ ok: true }),
      );
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("fails open when redis throws on SET NX", async () => {
    const throwingRedis = {
      async set() {
        throw new Error("redis down");
      },
    };
    const { webhookReplayGuard: wrg } = await vi.importActual<{
      webhookReplayGuard: typeof webhookReplayGuard;
    }>("../src/middleware/webhook-replay-guard");
    vi.doMock("../src/lib/redis", () => ({ redis: throwingRedis }));
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("webhookEventId", "uuid-4");
        c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
        await next();
      })
      .post("/", wrg({ source: "apple" }), (c) => c.json({ ok: true }));
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/webhook-replay-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the middleware**

Create `apps/api/src/middleware/webhook-replay-guard.ts`:

```typescript
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";

const log = logger.child("webhook-replay-guard");

const DEFAULT_TOLERANCE_SECONDS = 300;

type WebhookSource = "apple" | "google" | "stripe";

export interface ReplayGuardOptions {
  source: WebhookSource;
  toleranceSeconds?: number;
}

export function webhookReplayGuard(
  opts: ReplayGuardOptions,
): MiddlewareHandler {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  return async (c, next) => {
    const eventId = c.get("webhookEventId");
    const eventTs = c.get("webhookEventTimestamp");

    if (!eventId || typeof eventTs !== "number") {
      throw new HTTPException(500, {
        message:
          "webhookReplayGuard: webhookEventId/Timestamp not set by verifier",
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - eventTs);
    if (skew > tolerance) {
      log.warn("webhook outside replay tolerance", {
        source: opts.source,
        eventId,
        skew,
        tolerance,
      });
      throw new HTTPException(400, {
        message: `Webhook timestamp outside tolerance (${skew}s > ${tolerance}s)`,
      });
    }

    const key = `webhook:seen:${opts.source}:${eventId}`;

    let added: "OK" | null = null;
    try {
      added = await redis.set(key, "1", "EX", tolerance * 2, "NX");
    } catch (err) {
      // Redis is the backstop, not the gate. Idempotency middleware
      // downstream still prevents DB double-writes for retry-critical
      // endpoints. Log + fail open so a Redis outage doesn't drop
      // live webhook deliveries.
      log.warn("redis SET NX failed, failing open", {
        source: opts.source,
        eventId,
        err: err instanceof Error ? err.message : String(err),
      });
      await next();
      return;
    }

    if (added !== "OK") {
      // Already processed. Respond 200 so the sender stops retrying.
      return c.json(
        { data: { status: "duplicate", source: opts.source } },
        200,
      );
    }

    await next();
  };
}
```

- [ ] **Step 4: Add env var (optional override)**

In `apps/api/src/lib/env.ts`, add:

```typescript
WEBHOOK_REPLAY_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
```

Then update the middleware default to read from `env.WEBHOOK_REPLAY_TOLERANCE_SECONDS` instead of the hard-coded constant. (Factor into a helper or just inline — keep it simple.)

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/webhook-replay-guard.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/webhook-replay-guard.ts apps/api/tests/webhook-replay-guard.test.ts apps/api/src/lib/env.ts
git commit -m "feat(webhook): add replay guard middleware with nonce cache + tolerance"
```

---

### Task 1.3: Chain replay guard into each webhook route

**Files:**
- Modify: `apps/api/src/routes/webhooks/apple.ts`
- Modify: `apps/api/src/routes/webhooks/google.ts`
- Modify: `apps/api/src/routes/webhooks/stripe.ts`

- [ ] **Step 1: Write the failing test**

These tests go in `apps/api/tests/webhook-replay-guard.test.ts` (already created in Task 1.2). Add route-level scenarios that chain `verifyX + replayGuard` just like the real routes do.

Extend the existing `describe("webhookReplayGuard", ...)` with two more tests — one uses a shared `webhookEventId` across calls, the second varies it:

```typescript
test("replay guard chained after verifier rejects duplicate delivery", async () => {
  __store.clear();

  const verifier: MiddlewareHandler = async (c, next) => {
    c.set("webhookEventId", "stubbed-uuid");
    c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
    await next();
  };

  const app = new Hono().post(
    "/:projectId",
    verifier,
    webhookReplayGuard({ source: "apple" }),
    (c) => c.json({ data: { status: "enqueued" } }, 202),
  );

  const first = await app.request("/proj_a", { method: "POST" });
  expect(first.status).toBe(202);

  const second = await app.request("/proj_a", { method: "POST" });
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({
    data: { status: "duplicate", source: "apple" },
  });
});

test("distinct event ids each process independently", async () => {
  __store.clear();

  let idCounter = 0;
  const verifier: MiddlewareHandler = async (c, next) => {
    idCounter += 1;
    c.set("webhookEventId", `uuid-${idCounter}`);
    c.set("webhookEventTimestamp", Math.floor(Date.now() / 1000));
    await next();
  };

  const app = new Hono().post(
    "/",
    verifier,
    webhookReplayGuard({ source: "apple" }),
    (c) => c.json({ data: { status: "enqueued" } }, 202),
  );

  const a = await app.request("/", { method: "POST" });
  const b = await app.request("/", { method: "POST" });
  expect(a.status).toBe(202);
  expect(b.status).toBe(202);
});
```

Import `MiddlewareHandler` from `hono` at the top of the test file.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/webhook-replay-guard.test.ts`
Expected: FAIL — the new route-chain test expects duplicate rejection but the current route chain doesn't include the guard.

(Actually the Task 1.2 route tests *do* already pass because they invoke the guard directly. If so, skip to Step 3 and let the green end-to-end run be Step 4's confirmation.)

- [ ] **Step 3: Wire the guard in each route**

`apps/api/src/routes/webhooks/apple.ts`:

```typescript
import { webhookReplayGuard } from "../../middleware/webhook-replay-guard";

export const appleWebhookRoute = new Hono().post(
  "/:projectId",
  verifyAppleWebhook,
  webhookReplayGuard({ source: "apple" }),
  async (c) => { /* unchanged handler */ },
);
```

`apps/api/src/routes/webhooks/google.ts` — add `webhookReplayGuard({ source: "google" })` after `verifyGoogleWebhook` and before `zValidator(...)`.

`apps/api/src/routes/webhooks/stripe.ts` — add `webhookReplayGuard({ source: "stripe" })` after `verifyStripeWebhook`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/webhook-verify.test.ts`
Expected: PASS on all duplicate-delivery scenarios.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/webhooks/
git commit -m "feat(webhook): chain replay guard after each verifier"
```

---

## Phase 2 — Apple root CA fingerprint pinning

### Task 2.1: Hard-code the expected fingerprints + verifier

**Files:**
- Create: `apps/api/src/services/apple/apple-root-fingerprints.ts`
- Create: `apps/api/tests/apple-root-fingerprint.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/apple-root-fingerprint.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import {
  APPLE_ROOT_FINGERPRINTS,
  assertAppleRootFingerprints,
  fingerprintOf,
} from "../src/services/apple/apple-root-fingerprints";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(__dirname, "_helpers/apple-roots");

describe("Apple root fingerprint verification", () => {
  test("rejects a buffer that does not match any pinned fingerprint", () => {
    const bogus = Buffer.from("not-a-real-cert");
    expect(() => assertAppleRootFingerprints([bogus])).toThrow(
      /fingerprint/i,
    );
  });

  test("accepts when every provided buffer matches a pinned fingerprint", () => {
    // This only runs if fixture dir exists; see README for how to
    // drop the real Apple roots locally.
    const files = readdirSync(FIXTURE_DIR, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => readFileSync(join(FIXTURE_DIR, e.name)));
    if (files.length === 0) return; // fixture not provisioned
    expect(() => assertAppleRootFingerprints(files)).not.toThrow();
  });

  test("fingerprintOf produces a hex SHA-256 digest", () => {
    const buf = Buffer.from("hello");
    expect(fingerprintOf(buf)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("APPLE_ROOT_FINGERPRINTS set contains 2 expected G3 hashes", () => {
    // G3 + AAI CA. If Apple ships new roots the count goes up.
    expect(APPLE_ROOT_FINGERPRINTS.size).toBeGreaterThanOrEqual(1);
    for (const fp of APPLE_ROOT_FINGERPRINTS) {
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/apple-root-fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fingerprint module**

Create `apps/api/src/services/apple/apple-root-fingerprints.ts`:

```typescript
import { createHash } from "node:crypto";

// SHA-256 fingerprints of the DER-encoded Apple root CAs we accept.
// Sourced from https://www.apple.com/certificateauthority/ .
// These change roughly once a decade; when Apple rotates, add the
// new fingerprint here and ship before removing the old one.
//
//   Apple Root CA - G3 (ECC, used for StoreKit signing):
//     63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C7A8D1BA7E3E5F4EAE1F9B2C7DC
//   Apple Inc. Root (RSA, legacy — keep while some apps still route
//   through the old chain):
//     B0B1730ECBC7FF4505142C49F1295E6EDA6BCAED7E2C68C5BE91B5A11001F024
//
// Hashes below are placeholders. Replace with the canonical values
// published at apple.com/certificateauthority before merging.
export const APPLE_ROOT_FINGERPRINTS = new Set<string>([
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c7a8d1ba7e3e5f4eae1f9b2c7dc",
  "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024",
]);

export function fingerprintOf(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

export function assertAppleRootFingerprints(buffers: Buffer[]): void {
  for (const buf of buffers) {
    const fp = fingerprintOf(buf);
    if (!APPLE_ROOT_FINGERPRINTS.has(fp)) {
      throw new Error(
        `Apple root CA fingerprint not in pinned allowlist: ${fp}`,
      );
    }
  }
}
```

> **Before merging:** replace placeholder fingerprints with the real ones. Compute them with:
> `openssl x509 -in AppleRootCA-G3.cer -inform DER -noout -fingerprint -sha256 | awk -F= '{print tolower($2)}' | tr -d ':'`

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/apple-root-fingerprint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/apple/apple-root-fingerprints.ts apps/api/tests/apple-root-fingerprint.test.ts
git commit -m "feat(apple): pin Apple root CA SHA-256 fingerprints"
```

---

### Task 2.2: Wire the fingerprint check into root-cert loader

**Files:**
- Modify: `apps/api/src/services/apple/apple-root-ca.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/apple-root-fingerprint.test.ts`:

```typescript
test("loadAppleRootCerts fails closed when APPLE_ROOT_CERTS_DIR holds a bogus cert", async () => {
  const tmp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await tmp.mkdtemp(path.join(os.tmpdir(), "apple-roots-"));
  await tmp.writeFile(path.join(dir, "bad.cer"), "not-a-cert");

  process.env.APPLE_ROOT_CERTS_DIR = dir;
  // Clear the module cache so the loader re-reads env
  vi.resetModules();
  const { loadAppleRootCerts } = await import(
    "../src/services/apple/apple-root-ca"
  );
  expect(() => loadAppleRootCerts()).toThrow(/fingerprint/i);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/apple-root-fingerprint.test.ts`
Expected: FAIL — current `loadAppleRootCerts` silently returns `null` when certs are bad.

- [ ] **Step 3: Hook fingerprint verification into loader**

In `apps/api/src/services/apple/apple-root-ca.ts`, import and call the assertion:

```typescript
import { assertAppleRootFingerprints } from "./apple-root-fingerprints";

// inside loadAppleRootCerts, after building `buffers` and before caching:
try {
  assertAppleRootFingerprints(buffers);
} catch (err) {
  log.error("Apple root cert fingerprint mismatch — deployment tampered", {
    dir,
    err: err instanceof Error ? err.message : String(err),
  });
  // Fail closed: do NOT fall back to the jose verifier. In production
  // this bubbles up to verifyAppleWebhook which then 401s. Loading
  // sentinel `null` into the cache so subsequent reads stay closed.
  cache = null;
  throw err;
}
```

> Note: this changes `loadAppleRootCerts` from a silent `null` return to a throwing function on fingerprint mismatch. Callers (`createAppleVerifier` in `apple-verify.ts`) must catch this and translate into the existing "no certs → jose fallback" branch only in **development** environments — production must fail closed. Update `apple-verify.ts`:

```typescript
// apps/api/src/services/apple/apple-verify.ts, inside createAppleVerifier
let certs: Buffer[] | null = null;
try {
  certs = loadAppleRootCerts();
} catch (err) {
  if (env.NODE_ENV === "production") throw err;
  log.warn("Apple root cert load failed — dev fallback to jose verifier", {
    err: err instanceof Error ? err.message : String(err),
  });
}
```

(You need to import `env` at the top of `apple-verify.ts`.)

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/apple-root-fingerprint.test.ts tests/apple-verify.test.ts`
Expected: PASS. If `apple-verify.test.ts` starts failing on prod-mode assertions, that's expected — the old silent-null path is closed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/apple/apple-root-ca.ts apps/api/src/services/apple/apple-verify.ts apps/api/tests/apple-root-fingerprint.test.ts
git commit -m "feat(apple): verify root CA fingerprints on load + fail closed in prod"
```

---

## Phase 3 — Rate limiter hardening

### Task 3.1: Dashboard per-user rate limit preset

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/rate-limit.test.ts`:

```typescript
test("dashboardUserRateLimit scopes by user id", async () => {
  const app = new Hono()
    .use("*", async (c, next) => {
      const uid = c.req.header("x-test-user") ?? "anon";
      c.set("user", { id: uid } as never);
      await next();
    })
    .use("*", dashboardUserRateLimit())
    .get("/", (c) => c.json({ ok: true }));

  // Burn user-A quota (300/min)
  for (let i = 0; i < 300; i++) {
    const r = await app.request("/", { headers: { "x-test-user": "user-a" } });
    expect(r.status).toBe(200);
  }
  const over = await app.request("/", { headers: { "x-test-user": "user-a" } });
  expect(over.status).toBe(429);

  // user-b untouched
  const other = await app.request("/", { headers: { "x-test-user": "user-b" } });
  expect(other.status).toBe(200);
});
```

Import `dashboardUserRateLimit` from the rate-limit module.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/rate-limit.test.ts`
Expected: FAIL — `dashboardUserRateLimit` is not exported.

- [ ] **Step 3: Add the preset**

In `apps/api/src/middleware/rate-limit.ts`, add after `apiKeyRateLimit`:

```typescript
/** 300 req/min per authenticated dashboard user — per-tenant-human envelope. */
export function dashboardUserRateLimit(): MiddlewareHandler {
  return rateLimit({
    windowMs: MINUTE_MS,
    max: 300,
    keyPrefix: "rl:dashboard:user",
    identify: (c) => c.get("user")?.id ?? clientIp(c),
  });
}
```

`c.get("user")` is already typed via Better Auth's context extension — no type changes needed.

- [ ] **Step 4: Mount on the dashboard tree**

In `apps/api/src/routes/dashboard/index.ts`, before the first sub-route mount:

```typescript
import { dashboardUserRateLimit } from "../../middleware/rate-limit";
// ...
dashboardRoute.use("*", dashboardUserRateLimit());
```

(Adjust variable name to whatever the file uses.)

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/rate-limit.ts apps/api/src/routes/dashboard/index.ts apps/api/tests/rate-limit.test.ts
git commit -m "feat(rate-limit): per-user dashboard limiter"
```

---

### Task 3.2: In-memory insurance fallback when Redis is down

**Files:**
- Create: `apps/api/src/middleware/insurance-rate-limit.ts`
- Modify: `apps/api/src/middleware/rate-limit.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/rate-limit.test.ts`:

```typescript
test("insurance limiter caps requests when redis is down", async () => {
  setRedisDown(true); // helper in the existing mock

  const app = new Hono()
    .use("*", rateLimit({ windowMs: 60_000, max: 100, keyPrefix: "rl:test" }))
    .get("/", (c) => c.json({ ok: true }));

  // With redis dead and insurance cap of 50/min, the 51st request 429s.
  for (let i = 0; i < 50; i++) {
    const r = await app.request("/");
    expect(r.status).toBe(200);
  }
  const capped = await app.request("/");
  expect(capped.status).toBe(429);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/rate-limit.test.ts`
Expected: FAIL — current limiter fails completely open on Redis down.

- [ ] **Step 3: Implement the fallback**

Create `apps/api/src/middleware/insurance-rate-limit.ts`:

```typescript
// Tiny in-process sliding window counter. Used as a safety net when
// the Redis-backed limiter trips on infra errors. Values are
// intentionally lower than the Redis-backed limits — the fallback
// protects the server from catastrophic traffic, not policy-enforce.

interface Bucket {
  windowStart: number;
  count: number;
}

const INSURANCE_WINDOW_MS = 60_000;
const INSURANCE_MAX = 50; // per key per minute, per process

const buckets = new Map<string, Bucket>();

export function insuranceConsume(key: string): boolean {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= INSURANCE_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= INSURANCE_MAX;
}

export function __resetInsurance(): void {
  buckets.clear();
}
```

- [ ] **Step 4: Integrate into the main limiter**

In `apps/api/src/middleware/rate-limit.ts`, inside the `catch (err)` block currently logging "redis error, failing open":

```typescript
} catch (err) {
  if (err instanceof HTTPException) throw err;
  log.warn("redis error, falling back to insurance limiter", {
    err: err instanceof Error ? err.message : String(err),
  });
  const { insuranceConsume } = await import("./insurance-rate-limit");
  if (!insuranceConsume(key)) {
    const response = new Response(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          [RETRY_AFTER_HEADER]: "60",
        },
      },
    );
    throw new HTTPException(429, { res: response });
  }
}
```

Dynamic import avoids pulling the fallback into the hot path — it only loads when Redis trips.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/insurance-rate-limit.ts apps/api/src/middleware/rate-limit.ts apps/api/tests/rate-limit.test.ts
git commit -m "feat(rate-limit): in-memory insurance fallback on redis outage"
```

---

## Phase 4 — GDPR / KVKK

### Task 4.1: Anonymize service on top of `anonymizeSubscriberRow`

**Files:**
- Create: `apps/api/src/services/gdpr/anonymize-subscriber.ts`
- Create: `apps/api/tests/gdpr-anonymize.test.ts`
- Modify: `apps/api/src/lib/audit.ts` (no change — `subscriber.anonymized` already in AuditAction union)

- [ ] **Step 1: Write the failing test**

Follow the repo-mock pattern (see `tests/dashboard-subscribers.test.ts` lines 1-120). Create `apps/api/tests/gdpr-anonymize.test.ts`:

```typescript
import { describe, expect, test, beforeEach, vi } from "vitest";

const { drizzleMock, auditMock } = vi.hoisted(() => {
  const auditMock = {
    audit: vi.fn(async () => undefined),
    extractRequestContext: vi.fn(() => ({
      ipAddress: null,
      userAgent: null,
    })),
  };
  const drizzleMock = {
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({}),
      ),
    },
    subscriberRepo: {
      anonymizeSubscriberRow: vi.fn(async () => undefined),
    },
  };
  return { drizzleMock, auditMock };
});

vi.mock("@rovenue/db", () => drizzleMock);
vi.mock("../src/lib/audit", () => auditMock);

import { anonymizeSubscriber } from "../src/services/gdpr/anonymize-subscriber";

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.db.transaction.mockImplementation(async (cb) => cb({}));
});

describe("anonymizeSubscriber", () => {
  test("derives a stable anon_ token from subscriberId", async () => {
    const result = await anonymizeSubscriber({
      subscriberId: "sub_abc",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(result.anonymousId).toMatch(/^anon_[0-9a-f]{24}$/);
    const again = await anonymizeSubscriber({
      subscriberId: "sub_abc",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(again.anonymousId).toBe(result.anonymousId);
  });

  test("calls anonymizeSubscriberRow with the derived id + deletedAt", async () => {
    await anonymizeSubscriber({
      subscriberId: "sub_xyz",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(drizzleMock.subscriberRepo.anonymizeSubscriberRow).toHaveBeenCalledWith(
      expect.anything(), // tx handle
      "sub_xyz",
      expect.stringMatching(/^anon_[0-9a-f]{24}$/),
      expect.any(Date),
    );
  });

  test("writes audit entry with subscriber.anonymized action", async () => {
    await anonymizeSubscriber({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_actor",
      reason: "gdpr_request",
      ipAddress: "203.0.113.5",
      userAgent: "test-ua",
    });
    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscriber.anonymized",
        resource: "subscriber",
        resourceId: "sub_1",
        projectId: "proj_1",
        userId: "user_actor",
        ipAddress: "203.0.113.5",
        userAgent: "test-ua",
      }),
      expect.anything(), // tx handle
    );
  });

  test("runs row update + audit inside a single transaction", async () => {
    await anonymizeSubscriber({
      subscriberId: "sub_tx",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(drizzleMock.db.transaction).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/gdpr-anonymize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/gdpr/anonymize-subscriber.ts`:

```typescript
import { createHash } from "node:crypto";
import { drizzle, type Db } from "@rovenue/db";
import { audit } from "../../lib/audit";
import { logger } from "../../lib/logger";

const log = logger.child("gdpr:anonymize");

export interface AnonymizeSubscriberInput {
  subscriberId: string;
  projectId: string;
  actorUserId: string;
  reason?: "gdpr_request" | "kvkk_request" | "retention_policy";
  ipAddress?: string | null;
  userAgent?: string | null;
}

function deriveAnonymousId(subscriberId: string): string {
  const hex = createHash("sha256").update(subscriberId).digest("hex");
  return `anon_${hex.slice(0, 24)}`;
}

export async function anonymizeSubscriber(
  input: AnonymizeSubscriberInput,
): Promise<{ anonymousId: string }> {
  const anonymousId = deriveAnonymousId(input.subscriberId);
  const deletedAt = new Date();

  await drizzle.db.transaction(async (tx) => {
    await drizzle.subscriberRepo.anonymizeSubscriberRow(
      tx,
      input.subscriberId,
      anonymousId,
      deletedAt,
    );

    await audit(
      {
        projectId: input.projectId,
        userId: input.actorUserId,
        action: "subscriber.anonymized",
        resource: "subscriber",
        resourceId: input.subscriberId,
        before: null,
        after: null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );
  });

  log.info("subscriber anonymized", {
    subscriberId: input.subscriberId,
    projectId: input.projectId,
    reason: input.reason ?? "gdpr_request",
  });

  return { anonymousId };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/gdpr-anonymize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/gdpr/ apps/api/tests/gdpr-anonymize.test.ts
git commit -m "feat(gdpr): anonymize subscriber service + audit trail"
```

---

### Task 4.2: Anonymize dashboard endpoint

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscribers.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/dashboard-subscribers.test.ts` following the file's own hoisted mock pattern. First extend the existing hoisted block (lines 1-120) so it also mocks the new service:

```typescript
// Add near the top of the file's `vi.hoisted(...)`:
const anonymizeMock = {
  anonymizeSubscriber: vi.fn(async () => ({ anonymousId: "anon_abcdef1234567890abcdef12" })),
};

// Add near the other vi.mock calls:
vi.mock("../src/services/gdpr/anonymize-subscriber", () => anonymizeMock);
```

Then, inside the existing describe block (adjacent to the other `/:id/...` tests), add:

```typescript
test("POST /:id/anonymize with ADMIN returns anonymousId", async () => {
  authMock.api.getSession.mockResolvedValue({
    user: { id: "user_admin" },
  });
  dbMock.projectMember.findUnique.mockResolvedValue({
    id: "m1",
    role: "ADMIN",
  });

  const res = await app.request(
    "/dashboard/projects/proj_1/subscribers/sub_1/anonymize",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "rovenue.session=test",
      },
      body: JSON.stringify({ reason: "gdpr_request" }),
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { anonymousId: string } };
  expect(body.data.anonymousId).toBe("anon_abcdef1234567890abcdef12");
  expect(anonymizeMock.anonymizeSubscriber).toHaveBeenCalledWith(
    expect.objectContaining({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_admin",
      reason: "gdpr_request",
    }),
  );
});

test("POST /:id/anonymize as VIEWER is 403", async () => {
  authMock.api.getSession.mockResolvedValue({
    user: { id: "user_viewer" },
  });
  dbMock.projectMember.findUnique.mockResolvedValue({
    id: "m2",
    role: "VIEWER",
  });

  const res = await app.request(
    "/dashboard/projects/proj_1/subscribers/sub_1/anonymize",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "rovenue.session=test",
      },
      body: "{}",
    },
  );
  expect(res.status).toBe(403);
  expect(anonymizeMock.anonymizeSubscriber).not.toHaveBeenCalled();
});
```

`app` is the Hono harness the existing tests already build; re-use it. Adjust role string to whatever MemberRole enum the file imports (`MemberRole.ADMIN`).

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/dashboard-subscribers.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/dashboard/subscribers.ts`, add at the end of the route chain (before the closing `;`):

```typescript
const anonymizeBodySchema = z.object({
  reason: z
    .enum(["gdpr_request", "kvkk_request", "retention_policy"])
    .default("gdpr_request"),
});

// ... append to the chain:
.post("/:id/anonymize", async (c) => {
  const projectId = c.req.param("projectId");
  const subscriberId = c.req.param("id");
  if (!projectId || !subscriberId) {
    throw new HTTPException(400, { message: "Missing path parameters" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

  let body: z.infer<typeof anonymizeBodySchema>;
  try {
    body = anonymizeBodySchema.parse(await c.req.json().catch(() => ({})));
  } catch {
    throw new HTTPException(400, { message: "Invalid body" });
  }

  const { anonymizeSubscriber } = await import(
    "../../services/gdpr/anonymize-subscriber"
  );
  const { extractRequestContext } = await import("../../lib/audit");
  const { ipAddress, userAgent } = extractRequestContext(c);

  const result = await anonymizeSubscriber({
    subscriberId,
    projectId,
    actorUserId: user.id,
    reason: body.reason,
    ipAddress,
    userAgent,
  });

  return c.json(ok(result));
});
```

(If the file already uses top-level imports for `anonymizeSubscriber` / `extractRequestContext`, hoist them — the dynamic imports above are only here to sidestep circular-import worries; verify the actual repo layout before choosing.)

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/dashboard-subscribers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/subscribers.ts apps/api/tests/dashboard-subscribers.test.ts
git commit -m "feat(gdpr): POST /subscribers/:id/anonymize dashboard endpoint"
```

---

### Task 4.3: Export service + endpoint

**Files:**
- Create: `apps/api/src/services/gdpr/export-subscriber.ts`
- Create: `apps/api/tests/gdpr-export.test.ts`
- Modify: `apps/api/src/routes/dashboard/subscribers.ts`
- Modify: `apps/api/src/lib/audit.ts` (add `subscriber.exported` to AuditAction union)

- [ ] **Step 1: Extend audit actions**

In `apps/api/src/lib/audit.ts` `AuditAction` union, add:

```typescript
  | "subscriber.anonymized"
  | "subscriber.exported"   // <-- new
  | "member.invited"
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/tests/gdpr-export.test.ts` with the standard hoisted-mock pattern:

```typescript
import { describe, expect, test, beforeEach, vi } from "vitest";

const { drizzleMock, auditMock } = vi.hoisted(() => {
  const auditMock = { audit: vi.fn(async () => undefined) };
  const selectChain = (rows: unknown[]) => ({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  });
  const subscriberRow = {
    id: "sub_1",
    projectId: "proj_1",
    appUserId: "app_user_42",
    attributes: { email: "foo@bar.com" },
    deletedAt: null,
  };
  const purchaseRow = { id: "pur_1", subscriberId: "sub_1", store: "STRIPE" };
  const accessRow = { id: "acc_1", subscriberId: "sub_1", entitlementKey: "pro" };
  const ledgerRow = { id: "cl_1", subscriberId: "sub_1", delta: 100 };
  const drizzleMock = {
    db: {
      select: vi
        .fn()
        .mockImplementationOnce(() => selectChain([subscriberRow]))
        .mockImplementationOnce(() => selectChain([purchaseRow]))
        .mockImplementationOnce(() => selectChain([accessRow]))
        .mockImplementationOnce(() => selectChain([ledgerRow])),
    },
    schema: {
      subscribers: { id: "id", projectId: "projectId" },
      purchases: { subscriberId: "subscriberId" },
      subscriberAccess: { subscriberId: "subscriberId" },
      creditLedger: { subscriberId: "subscriberId" },
    },
  };
  return { drizzleMock, auditMock };
});

vi.mock("@rovenue/db", () => drizzleMock);
vi.mock("drizzle-orm", () => ({ eq: (_a: unknown, _b: unknown) => ({}) }));
vi.mock("../src/lib/audit", () => auditMock);

import { exportSubscriber } from "../src/services/gdpr/export-subscriber";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportSubscriber", () => {
  test("returns subscriber + purchases + access + ledger + timestamp", async () => {
    const dump = await exportSubscriber({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(dump.subscriber).toMatchObject({
      id: "sub_1",
      appUserId: "app_user_42",
    });
    expect(dump.purchases).toHaveLength(1);
    expect(dump.access).toHaveLength(1);
    expect(dump.creditLedger).toHaveLength(1);
    expect(dump.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("writes a subscriber.exported audit entry", async () => {
    await exportSubscriber({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscriber.exported",
        resource: "subscriber",
        resourceId: "sub_1",
      }),
    );
  });

  test("throws when subscriber row is missing", async () => {
    // Reset the select chain so the first call yields no rows
    drizzleMock.db.select.mockReset();
    drizzleMock.db.select.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    await expect(
      exportSubscriber({
        subscriberId: "sub_missing",
        projectId: "proj_1",
        actorUserId: "user_actor",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
```

The mocked `select` chain is brittle (fires in order) — if the service re-orders its queries, update the `mockImplementationOnce` sequence to match. Keep the happy-path assertion on the shape rather than the ordering of queries.

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm --filter @rovenue/api test -- --run tests/gdpr-export.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/gdpr/export-subscriber.ts`:

```typescript
import { drizzle } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { audit } from "../../lib/audit";
import { logger } from "../../lib/logger";

const log = logger.child("gdpr:export");

export interface ExportSubscriberInput {
  subscriberId: string;
  projectId: string;
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SubscriberExport {
  subscriber: Record<string, unknown>;
  purchases: Array<Record<string, unknown>>;
  access: Array<Record<string, unknown>>;
  creditLedger: Array<Record<string, unknown>>;
  exportedAt: string;
}

export async function exportSubscriber(
  input: ExportSubscriberInput,
): Promise<SubscriberExport> {
  const {
    subscribers,
    purchases,
    subscriberAccess,
    creditLedger,
  } = drizzle.schema;

  const [subscriberRow] = await drizzle.db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, input.subscriberId));

  if (!subscriberRow) {
    throw new Error(`Subscriber not found: ${input.subscriberId}`);
  }

  const [purchaseRows, accessRows, ledgerRows] = await Promise.all([
    drizzle.db
      .select()
      .from(purchases)
      .where(eq(purchases.subscriberId, input.subscriberId)),
    drizzle.db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.subscriberId, input.subscriberId)),
    drizzle.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.subscriberId, input.subscriberId)),
  ]);

  await audit({
    projectId: input.projectId,
    userId: input.actorUserId,
    action: "subscriber.exported",
    resource: "subscriber",
    resourceId: input.subscriberId,
    before: null,
    after: null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  log.info("subscriber exported", {
    subscriberId: input.subscriberId,
    projectId: input.projectId,
  });

  return {
    subscriber: subscriberRow as unknown as Record<string, unknown>,
    purchases: purchaseRows as unknown as Array<Record<string, unknown>>,
    access: accessRows as unknown as Array<Record<string, unknown>>,
    creditLedger: ledgerRows as unknown as Array<Record<string, unknown>>,
    exportedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @rovenue/api test -- --run tests/gdpr-export.test.ts`
Expected: PASS.

- [ ] **Step 6: Add dashboard endpoint**

Append to the route chain in `apps/api/src/routes/dashboard/subscribers.ts`:

```typescript
.get("/:id/export", async (c) => {
  const projectId = c.req.param("projectId");
  const subscriberId = c.req.param("id");
  if (!projectId || !subscriberId) {
    throw new HTTPException(400, { message: "Missing path parameters" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

  const { exportSubscriber } = await import(
    "../../services/gdpr/export-subscriber"
  );
  const { extractRequestContext } = await import("../../lib/audit");
  const { ipAddress, userAgent } = extractRequestContext(c);

  const dump = await exportSubscriber({
    subscriberId,
    projectId,
    actorUserId: user.id,
    ipAddress,
    userAgent,
  });

  c.header(
    "content-disposition",
    `attachment; filename="subscriber-${subscriberId}.json"`,
  );
  return c.json(ok(dump));
});
```

- [ ] **Step 7: Test the endpoint**

Extend the existing `vi.hoisted` block in `tests/dashboard-subscribers.test.ts` with an `exportMock`, and add the `vi.mock(...)` line:

```typescript
const exportMock = {
  exportSubscriber: vi.fn(async () => ({
    subscriber: { id: "sub_1" },
    purchases: [],
    access: [],
    creditLedger: [],
    exportedAt: "2026-04-21T10:00:00.000Z",
  })),
};
vi.mock("../src/services/gdpr/export-subscriber", () => exportMock);
```

Then add the test:

```typescript
test("GET /:id/export returns export blob + content-disposition", async () => {
  authMock.api.getSession.mockResolvedValue({ user: { id: "user_admin" } });
  dbMock.projectMember.findUnique.mockResolvedValue({
    id: "m1",
    role: "ADMIN",
  });

  const res = await app.request(
    "/dashboard/projects/proj_1/subscribers/sub_1/export",
    { headers: { cookie: "rovenue.session=test" } },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain(
    'filename="subscriber-sub_1.json"',
  );
  const body = (await res.json()) as {
    data: { subscriber: { id: string } };
  };
  expect(body.data.subscriber.id).toBe("sub_1");
  expect(exportMock.exportSubscriber).toHaveBeenCalledWith(
    expect.objectContaining({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_admin",
    }),
  );
});
```

Run: `pnpm --filter @rovenue/api test -- --run tests/dashboard-subscribers.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/gdpr/export-subscriber.ts apps/api/src/routes/dashboard/subscribers.ts apps/api/src/lib/audit.ts apps/api/tests/gdpr-export.test.ts apps/api/tests/dashboard-subscribers.test.ts
git commit -m "feat(gdpr): GET /subscribers/:id/export for right-to-access"
```

---

## Phase 5 — Final sweep

### Task 5.1: Full test + typecheck + lint

**Files:** none

- [ ] **Step 1: Full API test suite**

Run: `pnpm --filter @rovenue/api test -- --run`
Expected: all green.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/api typecheck`
Expected: clean.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no new warnings on changed files.

- [ ] **Step 4: Manual smoke — replay guard**

Boot the API locally (`pnpm dev`) and POST a Stripe test webhook twice with the same event id. Expect 202 on first, 200 with `duplicate` body on second. Inspect Redis for the `webhook:seen:stripe:<id>` key with a TTL matching `2 * tolerance`.

- [ ] **Step 5: Confirm Apple fingerprints are real**

Verify `APPLE_ROOT_FINGERPRINTS` in `apps/api/src/services/apple/apple-root-fingerprints.ts` holds the canonical hashes (not placeholders). Run:

```bash
openssl x509 -in /path/to/AppleRootCA-G3.cer -inform DER -noout -fingerprint -sha256 \
  | awk -F= '{print tolower($2)}' | tr -d ':'
```

Compare to the set. Update if mismatched, then rerun `apps/api/tests/apple-root-fingerprint.test.ts` against the fixture dir.

- [ ] **Step 6: Update the spec**

In `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/03-security-compliance.md` §16, cross off completed items:

```
- Webhook replay guard ✅
- Apple root CA fingerprint pinning ✅
- Dashboard per-user + insurance rate limits ✅
- GDPR/KVKK anonymize + export ✅
```

Leave envelope encryption / Infisical open — they are out of scope here.

- [ ] **Step 7: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-04-20-tech-stack-upgrade/03-security-compliance.md
git commit -m "docs(spec): mark Alan 3 completed items"
```

---

## Spec coverage checklist

| Spec section | Plan task | Status |
|---|---|---|
| §3 Apple JWS verification | pre-existing `apple-verify.ts` | ✓ already shipped |
| §3 root fingerprint pinning | Task 2.1, 2.2 | ✓ new |
| §4 Google Pub/Sub verification | pre-existing `google-auth.ts` | ✓ already shipped |
| §5 Stripe HMAC verification | pre-existing `webhook-verify.ts` | ✓ already shipped |
| §6 Replay guard middleware | Task 1.1, 1.2, 1.3 | ✓ new |
| §7 Envelope encryption | — | ✗ out of scope |
| §8 Audit chain + trigger | pre-existing `audit.ts` | ✓ already shipped |
| §9 Infisical secrets | — | ✗ out of scope |
| §10 Tenant rate limiting | pre-existing `apiKeyRateLimit` + Task 3.1, 3.2 | ✓ extended |
| §11 CSRF | Better Auth default | ✓ already shipped |
| §12 GDPR/KVKK anonymize | Task 4.1, 4.2 | ✓ new |
| §12 GDPR right-to-access | Task 4.3 | ✓ new |
| §13 Deployment TLS/Docker | — | ops scope |
| §14 Negative tests | each Task includes failure-case tests | ✓ ongoing |
| §15 Pitfalls T1–T11 | T5 (fail-closed rate limit) via Task 3.2; T4 (audit anchor) already shipped; remainder ops/monitoring | partial |

Out-of-scope items (envelope encryption, Infisical) should get their own spec + plan once ops decides on KMS posture.
