// =============================================================
// GET /v1/config/stream — real-Redis integration test
// =============================================================
//
// Tasks 1-4 pinned per-subscriber invalidation matching and the coalescing
// window with mocked Redis / mocked evaluation. This file is the only one
// that proves the pieces are actually wired together over the AMBIENT
// docker-compose stack (real Postgres on :5433, real Redis on :6380): that
// an attribute write made over HTTP causes `publishSubscriberInvalidation`
// to fire, that the SSE route's real `ioredis` subscriber receives it, and
// that the resulting push carries a real re-evaluation of real DB state.
//
// Seeding follows the inline-`getDb()` convention documented in
// `access-reconciliation.integration.test.ts` — there is no
// withTestDb/seedProject helper in this codebase. Project, audience, and
// feature flag rows are inserted directly with Drizzle, never produced by
// calling the write path under test, so a passing "default before / rule
// value after" assertion means the matching rule actually ran rather than
// the test agreeing with itself.
//
// Every test uses its own project (and therefore its own apiKey/audience/
// flag/subscribers), so even though the SSE route listens on the single
// process-wide `rovenue:experiments:invalidate` Redis channel — the same
// channel every other config-stream consumer in this test run publishes to
// — `shouldWakeStream`'s projectId check keeps one test's traffic from
// waking another's stream. That, plus running this file's tests
// sequentially (no `test.concurrent`), is this file's answer to the
// "three existing real-infra files collide on a shared channel/DB" note in
// the task brief: nothing here needs a channel suffix because the existing
// per-project scoping already isolates it.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  apiKeys,
  audiences,
  featureFlags,
  getDb,
  projects,
} from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";
import { subscribersRoute } from "./subscribers";
import { configStreamRoute, CONFIG_STREAM_COALESCE_MS } from "./config-stream";

// ---------------------------------------------------------------------------
// App under test — configStreamRoute carries its own apiKeyAuth("any") on
// the GET handler; subscribersRoute does not, so it needs the same
// middleware applied at mount time (mirrors
// subscribers-attributes.integration.test.ts).
// ---------------------------------------------------------------------------
function buildApp(): Hono {
  const app = new Hono();
  app.route("/", configStreamRoute);
  app.use("/v1/subscribers/*", apiKeyAuth("any"));
  app.route("/v1/subscribers", subscribersRoute);
  app.onError(errorHandler);
  return app;
}

const app = buildApp();

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();
let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${RUN_ID}_${seq}`;
}

interface SeededProject {
  projectId: string;
  publicKey: string;
  audienceId: string;
  /** BOOLEAN flag: default false, RULE value true for subscribers matching
   *  the audience's `{ plan: "pro" }` rule. */
  flagKey: string;
}

/**
 * A project with one public API key, one audience matching
 * `{ plan: "pro" }`, and one enabled BOOLEAN flag whose sole rule targets
 * that audience. Every test gets its own — no fixture is shared, so a
 * message meant for one test's project can never be mistaken for another's.
 */
async function seedProjectWithProAudienceFlag(): Promise<SeededProject> {
  const db = getDb();
  const s = nextSuffix();
  const projectId = `prj_cfgstream_${s}`;
  const publicKey = `rov_pub_cfgstream_${s}`;
  const audienceId = `aud_cfgstream_${s}`;
  const flagKey = `flag_cfgstream_${s}`;

  await db.insert(projects).values({
    id: projectId,
    name: `Config Stream Test ${s}`,
  });
  await db.insert(apiKeys).values({
    projectId,
    label: "test-public-key",
    keyPublic: publicKey,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });
  await db.insert(audiences).values({
    id: audienceId,
    projectId,
    name: `Pro users ${s}`,
    // Plain equality — sift's default operator, no `$`-prefixed operator
    // needed for a single scalar match.
    rules: { plan: "pro" },
  });
  await db.insert(featureFlags).values({
    projectId,
    key: flagKey,
    type: "BOOLEAN",
    env: "PROD",
    isEnabled: true,
    defaultValue: false,
    rules: [{ audienceId, value: true }],
  });

  return { projectId, publicKey, audienceId, flagKey };
}

// ---------------------------------------------------------------------------
// SSE frame reading
// ---------------------------------------------------------------------------

interface SseEvent {
  event: string;
  data: string;
}

interface SseReader {
  /** Next raw SSE frame (any event type), or null if none arrives within
   *  `timeoutMs`. Does not throw on timeout — used to prove absence. */
  next(timeoutMs: number): Promise<SseEvent | null>;
  /** Next frame of a specific event type, skipping others (e.g. keepalive
   *  `ping`s). Throws if none arrives within `timeoutMs`. */
  nextOfType(type: string, timeoutMs: number): Promise<SseEvent>;
  /** Cancels the underlying reader, which trips config-stream.ts's
   *  `stream.onAbort` (unsubscribe + quit the dedicated Redis connection,
   *  clear the keepalive interval) via hono's StreamingApi cancel hook. */
  close(): Promise<void>;
}

function createSseReader(res: Response): SseReader {
  if (!res.body) throw new Error("SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: SseEvent[] = [];
  let streamDone = false;
  // A single shared in-flight read so overlapping `next()` calls never
  // issue concurrent reader.read() calls against the same reader.
  let pendingPull: Promise<void> | null = null;

  function drainBuffer(): void {
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
      }
      queue.push({ event, data: dataLines.join("\n") });
    }
  }

  function ensurePull(): Promise<void> {
    if (!pendingPull) {
      pendingPull = (async () => {
        const { value, done } = await reader.read();
        if (done) {
          streamDone = true;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        drainBuffer();
      })().finally(() => {
        pendingPull = null;
      });
    }
    return pendingPull;
  }

  async function next(timeoutMs: number): Promise<SseEvent | null> {
    const deadline = Date.now() + timeoutMs;
    while (queue.length === 0) {
      if (streamDone) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const pull = ensurePull();
      const timedOut = await Promise.race([
        pull.then(() => false as const),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), remaining)),
      ]);
      if (timedOut) return null;
      // else loop: the pull may have produced 0+ frames or set streamDone.
    }
    return queue.shift() ?? null;
  }

  async function nextOfType(type: string, timeoutMs: number): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for SSE event "${type}"`);
      }
      const ev = await next(remaining);
      if (ev === null) {
        throw new Error(`timed out waiting for SSE event "${type}"`);
      }
      if (ev.event === type) return ev;
    }
  }

  return {
    next,
    nextOfType,
    async close() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

interface OpenStream {
  sse: SseReader;
  controller: AbortController;
}

async function openConfigStream(
  publicKey: string,
  subscriberId: string,
): Promise<OpenStream> {
  const controller = new AbortController();
  const res = await app.request(
    `/v1/config/stream?subscriberId=${encodeURIComponent(subscriberId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${publicKey}` },
      signal: controller.signal,
    },
  );
  if (res.status !== 200) {
    throw new Error(`stream open failed: ${res.status} ${await res.text()}`);
  }
  return { sse: createSseReader(res), controller };
}

async function closeStream(stream: OpenStream): Promise<void> {
  await stream.sse.close();
  stream.controller.abort();
}

interface ConfigFrame {
  flags: Record<string, unknown>;
  experiments: unknown[];
  projectId: string;
}

function parseConfigFrame(ev: SseEvent): ConfigFrame {
  return JSON.parse(ev.data) as ConfigFrame;
}

async function postAttributes(
  publicKey: string,
  subscriberId: string,
  attributes: Record<string, string | null>,
): Promise<void> {
  const res = await app.request(
    `/v1/subscribers/${encodeURIComponent(subscriberId)}/attributes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${publicKey}`,
      },
      body: JSON.stringify({ attributes }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`attribute write failed: ${res.status} ${await res.text()}`);
  }
}

// A window "comfortably longer" than the coalesce delay, per the task
// brief — generous enough that a slow CI box would still fail loudly on a
// real regression rather than passing on a timing fluke.
const GENEROUS_WAIT_MS = CONFIG_STREAM_COALESCE_MS * 4 + 1_000;

describe("config stream real-time audience updates", () => {
  it("an attribute write pushes fresh config to that subscriber's open stream", async () => {
    const { publicKey, flagKey } = await seedProjectWithProAudienceFlag();
    const subscriberId = `sub_a_${nextSuffix()}`;

    const stream = await openConfigStream(publicKey, subscriberId);
    try {
      // 2. Initial frame: A does not match the audience yet, so the flag
      // must read its DEFAULT. Asserting this (not just the after-value)
      // is what makes the "now true" assertion below meaningful — without
      // it this test would also pass against a flag that was always true.
      const initial = parseConfigFrame(
        await stream.sse.nextOfType("initial", GENEROUS_WAIT_MS),
      );
      expect(initial.flags[flagKey]).toBe(false);

      // 3. Attribute write that puts A in the audience.
      await postAttributes(publicKey, subscriberId, { plan: "pro" });

      // 4. The push must arrive and reflect the RULE value now that A
      // matches `{ plan: "pro" }`.
      const pushed = parseConfigFrame(
        await stream.sse.nextOfType("invalidate", GENEROUS_WAIT_MS),
      );
      expect(pushed.flags[flagKey]).toBe(true);
    } finally {
      await closeStream(stream);
    }
  });

  it("an attribute write for one subscriber does not push to another's stream", async () => {
    const { publicKey, flagKey } = await seedProjectWithProAudienceFlag();
    const subscriberA = `sub_a_${nextSuffix()}`;
    const subscriberB = `sub_b_${nextSuffix()}`;

    const streamA = await openConfigStream(publicKey, subscriberA);
    const streamB = await openConfigStream(publicKey, subscriberB);
    try {
      // Prove BOTH streams are live before writing anything: B receiving
      // nothing later is only meaningful if B's stream demonstrably works.
      const initialA = parseConfigFrame(
        await streamA.sse.nextOfType("initial", GENEROUS_WAIT_MS),
      );
      const initialB = parseConfigFrame(
        await streamB.sse.nextOfType("initial", GENEROUS_WAIT_MS),
      );
      expect(initialA.flags[flagKey]).toBe(false);
      expect(initialB.flags[flagKey]).toBe(false);

      await postAttributes(publicKey, subscriberA, { plan: "pro" });

      // Race both waits concurrently so B's "nothing arrived" window
      // covers exactly the same wall-clock span as A's "something
      // arrived" wait, rather than starting only after A's wait completes.
      const [pushedToA, pushedToB] = await Promise.all([
        streamA.sse.nextOfType("invalidate", GENEROUS_WAIT_MS),
        streamB.sse.next(GENEROUS_WAIT_MS),
      ]);

      // Positive: the invalidation pipeline was demonstrably live in THIS
      // test run — A's write actually caused a push to A.
      expect(parseConfigFrame(pushedToA).flags[flagKey]).toBe(true);
      // Negative: B, whose own stream we already proved was live via its
      // `initial` frame, received nothing at all — this is the scoping
      // property. Without it, every write would wake every open stream.
      expect(pushedToB).toBeNull();
    } finally {
      await closeStream(streamA);
      await closeStream(streamB);
    }
  });

  it("a burst of writes produces one push, carrying the final state", async () => {
    const { publicKey, flagKey } = await seedProjectWithProAudienceFlag();
    const subscriberId = `sub_c_${nextSuffix()}`;

    const stream = await openConfigStream(publicKey, subscriberId);
    try {
      const initial = parseConfigFrame(
        await stream.sse.nextOfType("initial", GENEROUS_WAIT_MS),
      );
      expect(initial.flags[flagKey]).toBe(false);

      // Three writes back to back. The first two keep A out of the
      // audience; only the last one flips `plan` to "pro" — so a stray
      // push carrying an intermediate state would show up as `false`
      // here rather than `true`, and more than one push would fail the
      // length assertion below regardless of value.
      await postAttributes(publicKey, subscriberId, { wave: "1" });
      await postAttributes(publicKey, subscriberId, { wave: "2" });
      await postAttributes(publicKey, subscriberId, { plan: "pro" });

      // Collect every `invalidate` frame that arrives within a window
      // comfortably longer than the coalesce delay, rather than stopping
      // at the first one — that is the only way "exactly one" can fail.
      const collected: ConfigFrame[] = [];
      const deadline = Date.now() + GENEROUS_WAIT_MS;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const ev = await stream.sse.next(remaining);
        if (ev === null) break;
        if (ev.event === "invalidate") collected.push(parseConfigFrame(ev));
      }

      expect(collected).toHaveLength(1);
      expect(collected[0]?.flags[flagKey]).toBe(true);
    } finally {
      await closeStream(stream);
    }
  });
});
