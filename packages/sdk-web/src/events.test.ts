import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventQueue, type QueuedEvent } from "./events";
import { createMemoryStorage } from "./storage";

// "At-least-once" is a claim, not a design, unless three things hold:
//
//   1. an event is deleted only AFTER the server acknowledges it. Deleting
//      on send turns a network blip into lost telemetry.
//   2. what was not acknowledged survives into the next session. A queue
//      that only lives in memory loses everything when the tab closes.
//   3. the flush actually runs on the way out. A timer alone loses whatever
//      was queued in the last interval.
//
// Replay is safe because each event carries a stable id the server dedupes
// on — which is only true if the id does NOT change between attempts.

const RETAINED = { eventType: "paywall_view" };

function makeQueue(
  post: (event: QueuedEvent) => Promise<boolean>,
  storage = createMemoryStorage(),
) {
  return { queue: createEventQueue({ storage, post }), storage };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("delivery", () => {
  it("posts a tracked event", async () => {
    const post = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => true);
    const { queue } = makeQueue(post);
    queue.track(RETAINED);
    await queue.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({
      eventType: "paywall_view",
    });
  });

  it("stamps the wire version and an ISO timestamp", async () => {
    const post = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => true);
    const { queue } = makeQueue(post);
    queue.track(RETAINED);
    await queue.flush();
    const sent = post.mock.calls[0]![0];
    expect(sent.version).toBe(1);
    expect(() => new Date(sent.occurredAt).toISOString()).not.toThrow();
  });

  it("deletes an event only after the server acknowledges it", async () => {
    const post = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => false);
    const { queue, storage } = makeQueue(post);
    queue.track(RETAINED);
    await queue.flush();

    // Still queued: a rejected send must not consume the event.
    const retained = JSON.parse(storage.get("rovenue.events") ?? "[]");
    expect(retained).toHaveLength(1);
  });

  it("drops the event once the server accepts it", async () => {
    const { queue, storage } = makeQueue(async () => true);
    queue.track(RETAINED);
    await queue.flush();
    expect(JSON.parse(storage.get("rovenue.events") ?? "[]")).toHaveLength(0);
  });

  it("replays a retained event in the next session", async () => {
    const storage = createMemoryStorage();
    const failing = makeQueue(async () => false, storage);
    failing.queue.track(RETAINED);
    await failing.queue.flush();

    // A new queue over the same storage — the SDK constructed again on the
    // next page load.
    const post = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => true);
    const next = makeQueue(post, storage);
    await next.queue.flush();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({
      eventType: "paywall_view",
    });
  });

  it("keeps the event id stable across attempts, so replay dedupes", async () => {
    const storage = createMemoryStorage();
    const firstPost = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => false);
    const first = makeQueue(firstPost, storage);
    first.queue.track(RETAINED);
    await first.queue.flush();

    const secondPost = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => true);
    const second = makeQueue(secondPost, storage);
    await second.queue.flush();

    const a = firstPost.mock.calls[0]![0].eventId;
    const b = secondPost.mock.calls[0]![0].eventId;
    expect(a).toBe(b);
  });

  it("does not lose later events when an earlier one fails", async () => {
    const storage = createMemoryStorage();
    const post = vi
      .fn<(e: QueuedEvent) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { queue } = makeQueue(post, storage);
    queue.track({ eventType: "a" });
    queue.track({ eventType: "b" });
    await queue.flush();

    // The first was retained and the second delivered; a naive
    // stop-on-first-failure would have stranded "b" behind "a".
    const retained = JSON.parse(storage.get("rovenue.events") ?? "[]");
    expect(retained.map((e: QueuedEvent) => e.eventType)).toEqual(["a"]);
  });
});

describe("flush on the way out", () => {
  it("flushes when the page is hidden", async () => {
    const listeners: Record<string, Array<() => void>> = {};
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: () => {},
    });
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: () => {},
    });

    const post = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => true);
    const { queue } = makeQueue(post);
    queue.start();
    queue.track(RETAINED);

    listeners.visibilitychange?.forEach((fn) => fn());
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("flushes on pagehide", async () => {
    const listeners: Record<string, Array<() => void>> = {};
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: () => {},
    });

    const post = vi.fn<(e: QueuedEvent) => Promise<boolean>>(async () => true);
    const { queue } = makeQueue(post);
    queue.start();
    queue.track(RETAINED);

    listeners.pagehide?.forEach((fn) => fn());
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("start() is safe with no DOM at all", () => {
    // Server-side rendering: constructing and starting must not throw.
    expect(() => makeQueue(async () => true).queue.start()).not.toThrow();
  });
});
