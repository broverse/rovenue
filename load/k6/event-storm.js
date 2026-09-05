// =============================================================
// Profile: event storm
// =============================================================
//
// A burst of SDK events — the shape a release day produces, when an updated
// build lands on millions of devices within an hour and every one of them
// starts reporting.
//
// This is the write path: /v1/events validates the envelope and writes an
// outbox_events row in the caller's transaction. Nothing here touches Kafka
// directly (the dispatcher does that, asynchronously), so what this profile
// measures is the OLTP cost of accepting events — which is the part that
// backpressures the client.
//
// Ramping arrival rate rather than a step: a step tells you whether the
// service survives N/s, a ramp tells you the N at which it stops surviving,
// which is the number capacity planning actually needs.
//
// Run:
//   k6 run -e BASE_URL=http://localhost:3000 -e API_KEY=rov_pub_... \
//          load/k6/event-storm.js

import http from "k6/http";
import { check } from "k6";
import { BASE_URL, sdkHeaders, sloThresholds, userId } from "./lib/env.js";

const PEAK = Number(__ENV.PEAK || 1000);

export const options = {
  scenarios: {
    event_storm: {
      executor: "ramping-arrival-rate",
      startRate: Math.max(1, Math.floor(PEAK / 20)),
      timeUnit: "1s",
      preAllocatedVUs: Math.max(100, PEAK),
      maxVUs: Math.max(500, PEAK * 4),
      stages: [
        { target: Math.floor(PEAK / 4), duration: "30s" },
        { target: PEAK, duration: "1m" },
        { target: PEAK, duration: "2m" },
        { target: 0, duration: "30s" },
      ],
    },
  },
  thresholds: sloThresholds,
};

export default function () {
  const base = BASE_URL();
  const id = userId();

  const body = JSON.stringify({
    version: 1,
    // A stable per-iteration id. The SDKs send one so retries dedupe
    // downstream; omitting it here would measure a path the SDKs never take.
    eventId: `load_evt_${id}_${Date.now()}`,
    eventType: "app_open",
    occurredAt: new Date().toISOString(),
  });

  const res = http.post(`${base}/v1/events`, body, { headers: sdkHeaders(id) });
  check(res, {
    // 202 is the documented answer: accepted, written to the outbox, not yet
    // in ClickHouse. Treating only 200 as success would fail every request.
    "event accepted": (r) => r.status === 202 || r.status === 200,
  });
}
