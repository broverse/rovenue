import { useEffect, useRef, useState } from "react";
import type { LiveEventMessage } from "@rovenue/shared";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type LiveEventsStatus = "connecting" | "open" | "error" | "closed";

interface Options {
  projectId: string;
  /** Pause stream consumption — closes the EventSource. */
  paused?: boolean;
  /** Max events retained in memory (FIFO drop). Default 200. */
  maxEvents?: number;
  /** Called whenever a new event arrives. Optional. */
  onEvent?: (event: LiveEventMessage) => void;
}

// =============================================================
// useLiveEventsStream (Phase 4.3)
// =============================================================
//
// Opens an EventSource against the dashboard's SSE endpoint and
// keeps a rolling buffer of the most recent events. Closes the
// connection on `paused` or unmount. The browser's EventSource
// auto-reconnects on transient drops, so we don't roll our own
// retry on top.
//
// Authentication: the dashboard's session cookie is HttpOnly and
// already same-site to the API host in production. We set
// `withCredentials: true` so the cookie rides the SSE handshake
// the same way it does on the rest of the dashboard's fetches.

export function useLiveEventsStream({
  projectId,
  paused,
  maxEvents = 200,
  onEvent,
}: Options) {
  const [status, setStatus] = useState<LiveEventsStatus>("connecting");
  const [events, setEvents] = useState<LiveEventMessage[]>([]);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!projectId || paused) {
      setStatus("closed");
      return;
    }
    setStatus("connecting");
    const url = `${BASE_URL}/dashboard/projects/${projectId}/events/stream`;
    const source = new EventSource(url, { withCredentials: true });

    const onReady = () => setStatus("open");
    const onLive = (e: MessageEvent<string>) => {
      try {
        const message = JSON.parse(e.data) as LiveEventMessage;
        setEvents((prev) => {
          const next = [message, ...prev];
          if (next.length > maxEvents) next.length = maxEvents;
          return next;
        });
        onEventRef.current?.(message);
      } catch {
        // Drop malformed events silently — the server already
        // filtered the obvious cases, this is belt-and-suspenders.
      }
    };
    const onErrorEvt = () => setStatus("error");

    source.addEventListener("ready", onReady);
    source.addEventListener("live", onLive as EventListener);
    source.addEventListener("error", onErrorEvt);

    return () => {
      source.removeEventListener("ready", onReady);
      source.removeEventListener("live", onLive as EventListener);
      source.removeEventListener("error", onErrorEvt);
      source.close();
      setStatus("closed");
    };
  }, [projectId, paused, maxEvents]);

  const clear = () => setEvents([]);
  return { status, events, clear };
}
