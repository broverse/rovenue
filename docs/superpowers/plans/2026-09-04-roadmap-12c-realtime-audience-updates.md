# §12.2 Real-time audience segment updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a subscriber's attributes change, the device's open
`/v1/config/stream` immediately receives freshly-evaluated flags and
experiments — so moving between audience segments is visible in real time
instead of on the next reconnect.

**Architecture:** The `rovenue:experiments:invalidate` Redis message gains an
optional `subscriberIds` field. Absent means project-wide (every existing
publisher unchanged); present means only streams for those subscribers
re-evaluate. Streams match on the resolved subscriber **row id**, not the
`appUserId` they were opened with, so a `/transfer` merge cannot orphan a
stream. Bursts coalesce on a trailing edge.

**Tech Stack:** Hono SSE (`hono/streaming`), ioredis pub/sub, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-roadmap-12-feature-breadth-design.md`
(Sub-project 2)

## Global Constraints

- TDD: a failing test precedes every behaviour change.
- No magic values. `CONFIG_STREAM_COALESCE_MS` is a named exported constant.
- Throttled test runs: `nice -n 19 npx vitest run --maxWorkers=2`.
- The change must be safe under a rolling deploy in **both** directions: an
  old replica ignoring `subscriberIds` over-invalidates (today's behaviour), a
  new replica seeing no `subscriberIds` wakes every stream. Never introduce a
  path where a message under-invalidates.
- No SDK changes. The SDK already consumes `/v1/config/stream` unchanged.
- No new tables, no `subscriber_audience_memberships`, no
  `audience.entered`/`audience.exited` events — those are explicit non-goals.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/lib/config-invalidation.ts` | message type, both publishers |
| `apps/api/src/services/subscriber-config.ts` | returns the resolved id; guarded publish |
| `apps/api/src/routes/v1/config-stream.ts` | subscriber matching + coalescing |
| `apps/api/src/routes/v1/subscribers.ts` | publish after an attribute write |
| `apps/api/src/routes/v1/me.ts` | publish after an attribute write |
| `apps/api/src/services/subscriber-transfer.ts` | publish both row ids |

---

### Task 1: Widen the invalidation message

**Files:**
- Modify: `apps/api/src/lib/config-invalidation.ts`
- Create: `apps/api/src/lib/config-invalidation.test.ts`

**Interfaces:**
- Produces: `export interface ConfigInvalidationMessage { projectId: string;
  subscriberIds?: string[] }`.
- Produces: `publishSubscriberInvalidation(projectId: string, subscriberIds:
  string[]): Promise<void>` — a no-op when `subscriberIds` is empty.
- Produces: `parseConfigInvalidation(payload: string):
  ConfigInvalidationMessage | null` — pure, used by the stream and directly
  unit-testable.
- Unchanged: `publishConfigInvalidation(projectId)` keeps its exact signature
  and meaning. Do not add a parameter to it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/config-invalidation.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const { redisMock } = vi.hoisted(() => ({
  redisMock: { publish: vi.fn(async () => 1) },
}));

vi.mock("./redis", () => ({ redis: redisMock }));

import {
  CONFIG_INVALIDATE_CHANNEL,
  parseConfigInvalidation,
  publishConfigInvalidation,
  publishSubscriberInvalidation,
} from "./config-invalidation";

const PROJECT_ID = "prj_1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publishConfigInvalidation", () => {
  test("publishes a project-wide message with no subscriberIds", async () => {
    await publishConfigInvalidation(PROJECT_ID);

    expect(redisMock.publish).toHaveBeenCalledWith(
      CONFIG_INVALIDATE_CHANNEL,
      JSON.stringify({ projectId: PROJECT_ID }),
    );
  });
});

describe("publishSubscriberInvalidation", () => {
  test("publishes only the named subscribers", async () => {
    await publishSubscriberInvalidation(PROJECT_ID, ["sub_1", "sub_2"]);

    expect(redisMock.publish).toHaveBeenCalledWith(
      CONFIG_INVALIDATE_CHANNEL,
      JSON.stringify({ projectId: PROJECT_ID, subscriberIds: ["sub_1", "sub_2"] }),
    );
  });

  test("publishes nothing for an empty list", async () => {
    await publishSubscriberInvalidation(PROJECT_ID, []);

    // An empty list is not "invalidate everyone" — a caller with nothing
    // to say must not accidentally wake a whole project.
    expect(redisMock.publish).not.toHaveBeenCalled();
  });

  test("swallows a publish failure", async () => {
    redisMock.publish.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      publishSubscriberInvalidation(PROJECT_ID, ["sub_1"]),
    ).resolves.toBeUndefined();
  });
});

describe("parseConfigInvalidation", () => {
  test("parses a project-wide message", () => {
    expect(parseConfigInvalidation(JSON.stringify({ projectId: PROJECT_ID })))
      .toEqual({ projectId: PROJECT_ID });
  });

  test("parses a per-subscriber message", () => {
    expect(
      parseConfigInvalidation(
        JSON.stringify({ projectId: PROJECT_ID, subscriberIds: ["sub_1"] }),
      ),
    ).toEqual({ projectId: PROJECT_ID, subscriberIds: ["sub_1"] });
  });

  test("drops a malformed subscriberIds rather than treating it as targeted", () => {
    // Falling back to project-wide over-invalidates, which is safe.
    // Treating garbage as a target list would silently drop pushes.
    expect(
      parseConfigInvalidation(
        JSON.stringify({ projectId: PROJECT_ID, subscriberIds: "sub_1" }),
      ),
    ).toEqual({ projectId: PROJECT_ID });
  });

  test("returns null for unparseable input", () => {
    expect(parseConfigInvalidation("not json")).toBeNull();
    expect(parseConfigInvalidation(JSON.stringify({}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/lib/config-invalidation.test.ts --maxWorkers=2
```

Expected: FAIL — `publishSubscriberInvalidation` / `parseConfigInvalidation`
are not exported.

- [ ] **Step 3: Implement**

Add to `apps/api/src/lib/config-invalidation.ts`, keeping
`publishConfigInvalidation` exactly as it is:

```ts
/**
 * A config-invalidation message.
 *
 * `subscriberIds` absent means project-wide — that is what every
 * config-CRUD publisher sends, and what an older replica writes during a
 * rolling deploy. Present means only those subscribers' streams need to
 * re-evaluate.
 *
 * The widening is safe in both deploy directions: an old replica reads
 * only `projectId` and treats a targeted message as project-wide, which
 * over-invalidates exactly as it does today. Nothing here can ever cause
 * a stream to be woken LESS often than before.
 */
export interface ConfigInvalidationMessage {
  projectId: string;
  subscriberIds?: string[];
}

/**
 * Notify only the named subscribers' open config streams. Best-effort,
 * like its project-wide sibling: a publish failure means the device picks
 * the change up on its next poll or reconnect.
 */
export async function publishSubscriberInvalidation(
  projectId: string,
  subscriberIds: string[],
): Promise<void> {
  if (subscriberIds.length === 0) return;
  try {
    await redis.publish(
      CONFIG_INVALIDATE_CHANNEL,
      JSON.stringify({ projectId, subscriberIds }),
    );
  } catch (err) {
    log.warn("subscriber invalidation publish failed", {
      projectId,
      count: subscriberIds.length,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function parseConfigInvalidation(
  payload: string,
): ConfigInvalidationMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  const projectId = obj.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  const ids = obj.subscriberIds;
  // Anything that is not a clean string array degrades to project-wide.
  if (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => typeof id === "string")
  ) {
    return { projectId, subscriberIds: ids as string[] };
  }
  return { projectId };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/lib/config-invalidation.test.ts --maxWorkers=2
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/config-invalidation.ts apps/api/src/lib/config-invalidation.test.ts
git commit -m "feat(config): optional subscriberIds on the invalidation message

Absent stays project-wide, so every existing publisher and an older
replica mid-deploy keep their exact current behaviour."
```

---

### Task 2: `evaluateSubscriberConfig` returns the resolved id and publishes when attributes change

**Files:**
- Modify: `apps/api/src/services/subscriber-config.ts`
- Create: `apps/api/src/services/subscriber-config.invalidation.test.ts`

**Interfaces:**
- Consumes: `publishSubscriberInvalidation` (Task 1).
- Produces: `SubscriberConfig` gains `subscriberId: string` — the **resolved
  row id**, i.e. `subscriber.id` after `resolveSubscriberForWrite`, not the
  `appUserId` the caller passed. Both `/v1/config` and the stream get it.

**The loop hazard, stated plainly:** `evaluateSubscriberConfig` is called *by*
the stream. If it published unconditionally, each push would trigger another
evaluation, which would publish again. It is safe today only because the
stream passes `requestAttributes: {}`, making `hasNewAttributes` false. Guard
the publish on the **same** `hasNewAttributes && !deadEnded` condition that
already guards the write, and the test below fails the moment someone makes
the stream forward attributes.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/subscriber-config.invalidation.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const { drizzleMock, resolveMock, publishSubscriberMock } = vi.hoisted(() => ({
  drizzleMock: {
    db: {} as unknown,
    subscriberRepo: { updateSubscriberAttributesById: vi.fn(async () => {}) },
  },
  resolveMock: vi.fn(async () => ({
    subscriber: { id: "sub_row_1", attributes: {} },
    deadEnded: false,
  })),
  publishSubscriberMock: vi.fn(async () => {}),
}));

vi.mock("@rovenue/db", () => ({ drizzle: drizzleMock }));
vi.mock("../lib/resolve-or-create-subscriber", () => ({
  resolveSubscriberForWrite: resolveMock,
}));
vi.mock("../lib/config-invalidation", () => ({
  publishSubscriberInvalidation: publishSubscriberMock,
}));
vi.mock("./flag-engine", () => ({ evaluateAllFlags: vi.fn(async () => ({})) }));
vi.mock("./experiment-engine", () => ({ evaluateExperiments: vi.fn(async () => ({})) }));

import { evaluateSubscriberConfig } from "./subscriber-config";

const BASE = {
  projectId: "prj_1",
  appUserId: "user_external_1",
  env: "PROD" as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock.mockResolvedValue({
    subscriber: { id: "sub_row_1", attributes: {} },
    deadEnded: false,
  });
});

describe("evaluateSubscriberConfig", () => {
  test("returns the resolved row id, not the appUserId", async () => {
    const result = await evaluateSubscriberConfig({
      ...BASE,
      requestAttributes: {},
    });

    // The stream matches invalidations on this. Returning the external id
    // would break matching after a /transfer merge.
    expect(result.subscriberId).toBe("sub_row_1");
  });

  test("publishes an invalidation when attributes actually change", async () => {
    await evaluateSubscriberConfig({
      ...BASE,
      requestAttributes: { plan: "pro" },
    });

    expect(publishSubscriberMock).toHaveBeenCalledWith("prj_1", ["sub_row_1"]);
  });

  test("publishes NOTHING when there are no new attributes", async () => {
    await evaluateSubscriberConfig({ ...BASE, requestAttributes: {} });

    // THE LOOP GUARD. The SSE stream re-evaluates with empty attributes on
    // every push. If this published, each push would cause another push,
    // forever. If this test ever fails, do not "fix" it by filtering in
    // the stream — the guard belongs here.
    expect(publishSubscriberMock).not.toHaveBeenCalled();
  });

  test("publishes nothing for a dead-ended subscriber", async () => {
    resolveMock.mockResolvedValue({
      subscriber: { id: "sub_row_1", attributes: {} },
      deadEnded: true,
    });

    await evaluateSubscriberConfig({
      ...BASE,
      requestAttributes: { plan: "pro" },
    });

    // Nothing was written, so there is nothing to tell anyone about.
    expect(publishSubscriberMock).not.toHaveBeenCalled();
    expect(drizzleMock.subscriberRepo.updateSubscriberAttributesById).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/services/subscriber-config.invalidation.test.ts --maxWorkers=2
```

Expected: FAIL — `subscriberId` is not on the result and nothing publishes.

- [ ] **Step 3: Implement**

In `apps/api/src/services/subscriber-config.ts`:

Add `subscriberId: string;` to the `SubscriberConfig` interface, import
`publishSubscriberInvalidation`, and change the write block plus the return:

```ts
  // Never write onto a dead-ended (e.g. GDPR-erased) row — evaluation still
  // proceeds with the in-memory merge so the device keeps working.
  if (hasNewAttributes && !deadEnded) {
    await drizzle.subscriberRepo.updateSubscriberAttributesById(
      drizzle.db,
      subscriber.id,
      mergedNested,
    );

    // Attributes are what move a subscriber between audience segments, so
    // this is the moment an open stream's config went stale. Guarded on the
    // SAME condition as the write above: the SSE stream calls this function
    // with empty requestAttributes on every push, so an unguarded publish
    // here would make every push trigger another one.
    await publishSubscriberInvalidation(projectId, [subscriber.id]);
  }

  const [flags, experiments] = await Promise.all([
    evaluateAllFlags(projectId, env, subscriber.id, evalAttributes),
    evaluateExperiments(projectId, subscriber.id, evalAttributes),
  ]);

  return { flags, experiments, subscriberId: subscriber.id };
```

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/services/subscriber-config.invalidation.test.ts --maxWorkers=2
```

Expected: PASS (4 tests).

- [ ] **Step 5: Check nothing broke on the consumers**

```bash
nice -n 19 npx tsc --noEmit -p apps/api
nice -n 19 npx vitest run apps/api/src/routes/v1/config apps/api/tests --maxWorkers=2
```

`SubscriberConfig` gained a field, which is additive — `/v1/config`'s response
will now include `subscriberId` unless it destructures. Check the route: if it
spreads the result straight into the response body, decide deliberately
whether to expose it. Prefer destructuring `{ flags, experiments }` in the
route so the wire shape does not change.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/subscriber-config.ts \
        apps/api/src/services/subscriber-config.invalidation.test.ts \
        apps/api/src/routes/v1/config.ts
git commit -m "feat(config): publish a per-subscriber invalidation on attribute writes

Guarded on the same condition as the write itself, which is what keeps
the SSE stream's own re-evaluation from triggering an endless push loop."
```

---

### Task 3: Publish from the two remaining attribute write paths and from transfer

**Files:**
- Modify: `apps/api/src/routes/v1/subscribers.ts` (after the write at ~line 163, and in the `/transfer` handler at ~line 185)
- Modify: `apps/api/src/routes/v1/me.ts` (after the write at ~line 96)
- Modify: `apps/api/src/services/subscriber-transfer.ts`
- Create: `apps/api/src/services/subscriber-transfer.invalidation.test.ts`

**Interfaces:**
- Consumes: `publishSubscriberInvalidation` (Task 1).
- Produces: no new exports. `transferSubscriber`'s existing `TransferResult`
  (`{ fromSubscriberId, toSubscriberId, creditsTransferred }`) already carries
  both ids — publish from inside `transferSubscriber` after its transaction
  commits, not from the route, so every caller of the service is covered.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/subscriber-transfer.invalidation.test.ts`. Mock
`../lib/config-invalidation` and whatever `transferSubscriber` needs, then:

```ts
test("publishes an invalidation for BOTH the retired and surviving rows", async () => {
  await transferSubscriber("prj_1", "user_a", "user_b");

  // A device still holding the retired id must be woken so its next
  // evaluation re-resolves onto the survivor. Publishing only the
  // survivor leaves that device stranded until it reconnects.
  expect(publishSubscriberMock).toHaveBeenCalledWith(
    "prj_1",
    expect.arrayContaining(["sub_from", "sub_to"]),
  );
});
```

Follow the mock scaffolding in whatever transfer test already exists —
`ls apps/api/src/services/subscriber-transfer*` — rather than inventing one.

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/services/subscriber-transfer.invalidation.test.ts --maxWorkers=2
```

Expected: FAIL — nothing publishes.

- [ ] **Step 3: Implement all three call sites**

In `apps/api/src/services/subscriber-transfer.ts`, after the transaction
commits and after the existing access reconciliation:

```ts
  // Both ids: the device that initiated the merge may still be holding the
  // retired one, and its stream needs waking so the next evaluation
  // re-resolves onto the survivor.
  await publishSubscriberInvalidation(projectId, [
    result.fromSubscriberId,
    result.toSubscriberId,
  ]);
```

In `apps/api/src/routes/v1/subscribers.ts`, immediately after the
`updateSubscriberAttributesById` call at ~line 163 (inside the same
`!deadEnded` branch that guards the write):

```ts
        await publishSubscriberInvalidation(projectId, [subscriber.id]);
```

In `apps/api/src/routes/v1/me.ts`, after the update at ~line 96 — that path
writes via `resolveSubscriberForWrite`'s `updateAttributes`, so publish using
the id from `updated`:

```ts
        await publishSubscriberInvalidation(projectId, [updated.id]);
```

Read each site's surrounding guard before inserting. If a write is
conditional, the publish must sit inside the same condition — publishing
after a write that did not happen is a wasted wake-up, and publishing when a
write was skipped for a dead-ended row is wrong.

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/services/subscriber-transfer apps/api/src/routes/v1 --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/subscriber-transfer.ts \
        apps/api/src/services/subscriber-transfer.invalidation.test.ts \
        apps/api/src/routes/v1/subscribers.ts apps/api/src/routes/v1/me.ts
git commit -m "feat(config): invalidate on every attribute write path

Transfer publishes both the retired and surviving row ids so a device
holding the dead id is woken rather than stranded until reconnect."
```

---

### Task 4: Stream-side matching and coalescing

**Files:**
- Modify: `apps/api/src/routes/v1/config-stream.ts`
- Create: `apps/api/src/routes/v1/config-stream.matching.test.ts`

**Interfaces:**
- Consumes: `parseConfigInvalidation`, `ConfigInvalidationMessage` (Task 1);
  `SubscriberConfig.subscriberId` (Task 2).
- Produces: `export const CONFIG_STREAM_COALESCE_MS = 250`.
- Produces: `export function shouldWakeStream(message:
  ConfigInvalidationMessage, projectId: string, resolvedSubscriberId: string |
  null): boolean` — extracted as a pure function precisely so the matching
  rule is testable without opening a real SSE stream.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/config-stream.matching.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { shouldWakeStream } from "./config-stream";

const PROJECT = "prj_1";
const OTHER_PROJECT = "prj_2";
const ME = "sub_me";

describe("shouldWakeStream", () => {
  test("project-wide message wakes every stream in the project", () => {
    expect(shouldWakeStream({ projectId: PROJECT }, PROJECT, ME)).toBe(true);
  });

  test("project-wide message for another project wakes nothing", () => {
    expect(shouldWakeStream({ projectId: OTHER_PROJECT }, PROJECT, ME)).toBe(false);
  });

  test("targeted message wakes the named subscriber", () => {
    expect(
      shouldWakeStream({ projectId: PROJECT, subscriberIds: [ME] }, PROJECT, ME),
    ).toBe(true);
  });

  test("targeted message does NOT wake an unnamed subscriber", () => {
    // The whole point: an attribute write for one subscriber must not
    // cause every other stream in the project to re-evaluate.
    expect(
      shouldWakeStream(
        { projectId: PROJECT, subscriberIds: ["sub_someone_else"] },
        PROJECT,
        ME,
      ),
    ).toBe(false);
  });

  test("a stream that has not resolved an id yet falls back to waking", () => {
    // Before the initial evaluation completes we cannot know whether we
    // are targeted. Waking is a wasted evaluation; not waking would drop
    // a real update. Prefer the wasted work.
    expect(
      shouldWakeStream({ projectId: PROJECT, subscriberIds: [ME] }, PROJECT, null),
    ).toBe(true);
  });

  test("project scoping wins over subscriber matching", () => {
    expect(
      shouldWakeStream(
        { projectId: OTHER_PROJECT, subscriberIds: [ME] },
        PROJECT,
        ME,
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/routes/v1/config-stream.matching.test.ts --maxWorkers=2
```

Expected: FAIL — `shouldWakeStream` is not exported.

- [ ] **Step 3: Implement matching and coalescing**

In `apps/api/src/routes/v1/config-stream.ts`, add above the route:

```ts
/**
 * Trailing-edge window for re-evaluating after an invalidation. A burst of
 * attribute writes for one subscriber collapses into a single push. This
 * bounds push RATE, never correctness: the trailing evaluation always reads
 * current state, so the last push in a burst is always right.
 */
export const CONFIG_STREAM_COALESCE_MS = 250;

/**
 * Whether an invalidation message concerns this stream.
 *
 * `resolvedSubscriberId` is null until the initial evaluation completes.
 * In that window a targeted message wakes the stream anyway — a wasted
 * evaluation is cheap, a dropped update is not.
 */
export function shouldWakeStream(
  message: ConfigInvalidationMessage,
  projectId: string,
  resolvedSubscriberId: string | null,
): boolean {
  if (message.projectId !== projectId) return false;
  if (!message.subscriberIds) return true;
  if (resolvedSubscriberId === null) return true;
  return message.subscriberIds.includes(resolvedSubscriberId);
}
```

Then rework the stream body. Track the resolved id from each evaluation and
replace `onMessage`:

```ts
      let resolvedSubscriberId: string | null = null;

      const evaluate = async () => {
        const config = await evaluateSubscriberConfig({
          projectId,
          appUserId,
          env: featureFlagEnv,
          requestAttributes: {},
        });
        resolvedSubscriberId = config.subscriberId;
        return config;
      };

      const initial = await evaluate();
      await stream.writeSSE({
        event: "initial",
        data: JSON.stringify({ ...initial, projectId }),
      });

      // ... subscriber setup unchanged ...

      let coalesceTimer: NodeJS.Timeout | null = null;

      const pushFreshConfig = async () => {
        coalesceTimer = null;
        try {
          const next = await evaluate();
          await stream.writeSSE({
            event: "invalidate",
            data: JSON.stringify({ ...next, projectId }),
          });
        } catch (err) {
          log.warn("invalidation delivery failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const onMessage = (_channel: string, payload: string) => {
        const message = parseConfigInvalidation(payload);
        if (!message) return;
        if (!shouldWakeStream(message, projectId, resolvedSubscriberId)) return;

        // Trailing edge: an invalidation arriving while one is already
        // pending collapses into it rather than queueing a second push.
        if (coalesceTimer !== null) return;
        coalesceTimer = setTimeout(() => {
          void pushFreshConfig();
        }, CONFIG_STREAM_COALESCE_MS);
      };
      subscriber.on("message", onMessage);
```

Clear the timer in `stream.onAbort` alongside the keepalive:

```ts
      stream.onAbort(() => {
        clearInterval(keepalive);
        if (coalesceTimer !== null) clearTimeout(coalesceTimer);
        // ... existing unsubscribe/quit ...
      });
```

Import `parseConfigInvalidation` and the `ConfigInvalidationMessage` type
alongside the existing `CONFIG_INVALIDATE_CHANNEL` import.

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/routes/v1/config-stream.matching.test.ts --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

Expected: PASS (6 tests), clean type-check.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/config-stream.ts apps/api/src/routes/v1/config-stream.matching.test.ts
git commit -m "feat(config): match invalidations per subscriber and coalesce bursts

Streams match on the resolved row id, so a /transfer merge cannot orphan
one. An unmatched message does zero work: no DB read, no push."
```

---

### Task 5: Real-Redis integration test

**Files:**
- Create: `apps/api/src/routes/v1/config-stream.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4. Produces nothing.

**Why:** the unit tests pin the matching rule and the loop guard in isolation.
Only this one proves that writing attributes over HTTP actually causes a push
to arrive on a live SSE connection — which is the whole feature.

**Test harness — read this before writing the file.** This repo has **no
per-file testcontainers bootstrap and no `withTestDb`/`seedProject` helper**.
`apps/api/tests/setup.ts` points the suite at the ambient docker-compose dev
stack (Postgres host 5433, Redis 6380, Redpanda 19092, ClickHouse 8124) and
tests seed inline with `getDb()` plus direct Drizzle inserts. Follow
`apps/api/src/workers/access-reconciliation.integration.test.ts`, which states
this convention explicitly and is the closest model.

Two consequences:
- Bring the stack up first (`docker compose up -d`). "Docker running" is not
  the same as "the stack is up".
- Seed fixtures with direct SQL/inserts, never by calling the code under test.
  A test that builds its baseline through the same writer it is checking
  asserts only that the writer agrees with itself.

Redis here is the ambient one — this file starts no container, so it does
**not** belong in `CONTAINER_SUITES`. Give it its own pub/sub channel suffix
anyway: three existing real-infra integration files already collide on a
shared queue name and hardcoded DB/Redis.

- [ ] **Step 1: Write the test**

```ts
describe("config stream real-time audience updates", () => {
  test("an attribute write pushes fresh config to that subscriber's open stream", async () => {
    // 1. Seed a project, an audience whose rule matches { plan: "pro" },
    //    and a feature flag with a rule targeting that audience.
    // 2. Open GET /v1/config/stream for subscriber A and read the
    //    `initial` event. Assert the flag evaluates to its DEFAULT --
    //    A does not match the audience yet.
    // 3. POST /v1/subscribers/A/attributes { plan: "pro" }.
    // 4. Await the next `invalidate` event on the stream (with a timeout
    //    generous enough for CONFIG_STREAM_COALESCE_MS). Assert the flag
    //    now evaluates to the RULE value.
  });

  test("an attribute write for one subscriber does not push to another's stream", async () => {
    // Open streams for A and B. Write attributes for A only. Assert B's
    // stream receives no `invalidate` event within a window comfortably
    // longer than the coalesce delay. This is the scoping property --
    // without it the feature is just "wake everyone on every write".
  });

  test("a burst of writes produces one push, carrying the final state", async () => {
    // Write three attribute mutations back to back. Assert exactly one
    // `invalidate` event arrives and its payload reflects the LAST write.
  });
});
```

Fill in each numbered comment with real code. They are the assertions to
write, not placeholders to leave.

- [ ] **Step 2: Run it**

```bash
docker ps   # vitest hangs silently when Docker is down
nice -n 19 npx vitest run apps/api/src/routes/v1/config-stream.integration.test.ts --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 3: Commit and tick the ROADMAP checkbox**

```bash
git add apps/api/src/routes/v1/config-stream.integration.test.ts ROADMAP.md
git commit -m "test(config): prove attribute writes reach an open stream

Covers the scoping property (one subscriber's write must not wake
another's stream) and burst coalescing."
```

Mark "Real-time audience segment updates" done in `ROADMAP.md` §12 with a
one-line note pointing at the per-subscriber invalidation.
