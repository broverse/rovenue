import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";
import { getNative } from "../core/native";

const DEBOUNCE_MS = 1000;
const FLUSH_INTERVAL_MS = 30_000;

type Tracker = {
  sub: NativeEventSubscription;
  flushTimer: ReturnType<typeof setInterval>;
  foregroundStartedAt: number | null;
  pendingState: AppStateStatus | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
};

let tracker: Tracker | null = null;

function now(): number {
  return Date.now();
}
function isoNow(): string {
  return new Date().toISOString();
}

function isForeground(s: AppStateStatus): boolean {
  return s === "active";
}

export function startSessionTracker(): void {
  if (tracker) return;
  const onChange = (next: AppStateStatus) => {
    if (!tracker) return;
    tracker.pendingState = next;
    if (tracker.debounceTimer) clearTimeout(tracker.debounceTimer);
    tracker.debounceTimer = setTimeout(() => {
      if (!tracker) return;
      const finalState = tracker.pendingState!;
      const wasForeground = tracker.foregroundStartedAt !== null;
      const willBeForeground = isForeground(finalState);
      if (wasForeground !== willBeForeground) {
        if (willBeForeground) {
          getNative()
            .recordSessionEvent("open", isoNow(), undefined)
            .catch(() => {});
          tracker.foregroundStartedAt = now();
        } else {
          const durationMs = tracker.foregroundStartedAt
            ? Math.max(0, now() - tracker.foregroundStartedAt)
            : undefined;
          getNative()
            .recordSessionEvent("background", isoNow(), durationMs)
            .catch(() => {});
          tracker.foregroundStartedAt = null;
        }
      }
      tracker.debounceTimer = null;
    }, DEBOUNCE_MS);
  };
  const sub = AppState.addEventListener("change", onChange);
  const initialState = AppState.currentState as AppStateStatus;
  const startedAt = isForeground(initialState) ? now() : null;
  tracker = {
    sub,
    flushTimer: setInterval(() => {
      getNative()
        .flushSessionEvents()
        .catch(() => {});
    }, FLUSH_INTERVAL_MS),
    foregroundStartedAt: startedAt,
    pendingState: null,
    debounceTimer: null,
  };
  // initial 'open' event — emit unconditionally on first mount so the
  // backend can join the session against a (subscriberId, app-start) pair.
  getNative()
    .recordSessionEvent("open", isoNow(), undefined)
    .catch(() => {});
}

export function stopSessionTracker(): void {
  if (!tracker) return;
  // emit a 'close' if we were foregrounded
  if (tracker.foregroundStartedAt !== null) {
    const durationMs = Math.max(0, now() - tracker.foregroundStartedAt);
    getNative()
      .recordSessionEvent("close", isoNow(), durationMs)
      .catch(() => {});
    // best-effort final flush
    getNative()
      .flushSessionEvents()
      .catch(() => {});
  }
  if (tracker.debounceTimer) clearTimeout(tracker.debounceTimer);
  clearInterval(tracker.flushTimer);
  tracker.sub.remove();
  tracker = null;
}
