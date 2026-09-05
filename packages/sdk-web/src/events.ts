import { createId } from "@paralleldrive/cuid2";
import type { SdkStorage } from "./storage";

// =============================================================
// Event queue
// =============================================================
//
// At-least-once delivery, which means three things and not one:
//
//   1. **Delete only after the server acknowledges.** Peek, post, then drop.
//      Removing an event on send turns a network blip into lost telemetry,
//      and telemetry that is silently lossy is worse than none — it produces
//      dashboards that look fine and are wrong.
//   2. **Survive the page.** Unacknowledged events go back to storage, so the
//      next page load replays them.
//   3. **Flush on the way out.** A timer alone loses whatever was queued in
//      the last interval, which on a paywall page is the interesting part.
//
// Replay is safe because each event carries a stable id the server dedupes
// on. That id is minted ONCE, when the event is tracked — regenerating it per
// attempt would turn every retry into a new event and double-count.
//
// ## Why not sendBeacon
//
// `navigator.sendBeacon` is the usual answer for flushing on unload, and it
// does not work here: it cannot set request headers, and this API
// authenticates from `Authorization`. (Identity itself would have been fine —
// `/v1/events` takes the subscriber in the body.) `fetch(..., { keepalive:
// true })` carries headers and survives unload, so it is the only path rather
// than the fallback. Its 64 KB body cap is far above one event envelope.

const QUEUE_KEY = "rovenue.events";
/** Wire format version the server expects (EVENT_WIRE_VERSION). */
const EVENT_WIRE_VERSION = 1;
/** Events kept when the queue cannot drain. Oldest are dropped first. */
const MAX_QUEUED_EVENTS = 200;

export interface TrackInput {
  eventType: string;
  occurredAt?: string;
  subscriberId?: string;
  productId?: string;
  amount?: string;
  currency?: string;
  eventSourceUrl?: string;
  paywallContext?: Record<string, unknown>;
}

export interface QueuedEvent extends TrackInput {
  version: typeof EVENT_WIRE_VERSION;
  eventId: string;
  occurredAt: string;
}

export interface EventQueue {
  track(input: TrackInput): void;
  /** Attempts every queued event once. Retains whatever is not acknowledged. */
  flush(): Promise<void>;
  /** Drops every queued event. Used when the identity they belong to goes. */
  clear(): void;
  /** Registers the unload listeners. No-op where there is no DOM. */
  start(): void;
  stop(): void;
}

export interface CreateEventQueueOptions {
  storage: SdkStorage;
  /** Resolves true when the server accepted the event. */
  post: (event: QueuedEvent) => Promise<boolean>;
  now?: () => Date;
}

export function createEventQueue(opts: CreateEventQueueOptions): EventQueue {
  const { storage, post } = opts;
  const now = opts.now ?? (() => new Date());

  function read(): QueuedEvent[] {
    const raw = storage.get(QUEUE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // Storage is viewer-editable. A malformed queue is dropped rather than
      // fed to the sender, which would throw on every flush forever.
      return Array.isArray(parsed) ? (parsed as QueuedEvent[]) : [];
    } catch {
      return [];
    }
  }

  function write(events: QueuedEvent[]): void {
    // Bounded: a viewer who is offline for a week must not accumulate an
    // unbounded queue in storage. Oldest go first — the newest events are
    // the ones still worth attributing.
    const bounded = events.slice(-MAX_QUEUED_EVENTS);
    storage.set(QUEUE_KEY, JSON.stringify(bounded));
  }

  let flushing = false;
  let detach: (() => void) | null = null;

  const queue: EventQueue = {
    track(input) {
      const event: QueuedEvent = {
        ...input,
        version: EVENT_WIRE_VERSION,
        // Minted once, here. Reused verbatim on every retry so the server's
        // dedup can recognise the replay.
        eventId: createId(),
        occurredAt: input.occurredAt ?? now().toISOString(),
      };
      write([...read(), event]);
    },

    async flush() {
      // A flush triggered by pagehide can overlap the timer's. Two senders
      // over one storage queue would each read the same events and post them
      // twice.
      if (flushing) return;
      flushing = true;
      try {
        const pending = read();
        if (pending.length === 0) return;

        const retained: QueuedEvent[] = [];
        for (const event of pending) {
          let accepted = false;
          try {
            accepted = await post(event);
          } catch {
            accepted = false;
          }
          // Every event is attempted, not just up to the first failure: one
          // permanently-rejected event must not strand every later one
          // behind it.
          if (!accepted) retained.push(event);
        }
        // Re-read rather than writing the snapshot back. `post` awaits, and
        // anything track() persisted during those awaits is in storage now;
        // writing `retained` alone would silently drop it — losing exactly
        // the paywall_view that a visibilitychange flush overlapped, which is
        // the at-least-once guarantee this module claims.
        const seen = new Set(pending.map((e) => e.eventId));
        const arrivedDuringFlush = read().filter((e) => !seen.has(e.eventId));
        write([...retained, ...arrivedDuringFlush]);
      } finally {
        flushing = false;
      }
    },

    clear() {
      write([]);
    },

    start() {
      // No DOM: server-side rendering. Tracking still works and is replayed
      // by whichever browser session picks the queue up.
      const doc = globalThis.document;
      const win = globalThis.window;
      if (!doc && !win) return;

      const onHide = () => {
        if (!doc || doc.visibilityState === "hidden") void queue.flush();
      };
      const onPageHide = () => {
        void queue.flush();
      };

      doc?.addEventListener("visibilitychange", onHide);
      win?.addEventListener("pagehide", onPageHide);
      detach = () => {
        doc?.removeEventListener("visibilitychange", onHide);
        win?.removeEventListener("pagehide", onPageHide);
      };
    },

    stop() {
      detach?.();
      detach = null;
    },
  };

  return queue;
}
