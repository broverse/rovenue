// =============================================================
// Prometheus metrics registry
// =============================================================
//
// A dedicated (non-global) prom-client Registry so importing this
// module twice in tests never collides with the default registry.
// Exposed as text via GET /metrics on the INTERNAL listener only.

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
} from "prom-client";

export const registry = new Registry();

// Node/process/event-loop/GC gauges.
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by the API",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Incremented each time the webhook replay guard catches a Redis error
// and fails open (availability over dedup). Alert if this climbs — it
// means the replay dedup window is ineffective while Redis is degraded.
export const webhookReplayGuardFailOpenTotal = new Counter({
  name: "rovenue_webhook_replay_guard_failopen_total",
  help: "Number of times the webhook replay guard failed open due to a Redis error",
  labelNames: ["source"] as const,
  registers: [registry],
});

// Incremented by the webhook reaper each sweep with the count of stale
// PROCESSING rows it reclaimed (crashed/lost BullMQ jobs). Non-zero
// values indicate API pods are dying mid-processing.
export const webhookEventsReclaimedTotal = new Counter({
  name: "rovenue_webhook_events_reclaimed_total",
  help: "Number of stale PROCESSING webhook_events rows reclaimed by the reaper",
  registers: [registry],
});
