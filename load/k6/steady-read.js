// =============================================================
// Profile: steady SDK read traffic
// =============================================================
//
// What an app does all day. Every cold start calls /v1/me/entitlements, and
// every paywall impression calls /v1/placements/:identifier — between them
// they are the overwhelming majority of requests a Rovenue install serves.
//
// Uses a CONSTANT ARRIVAL RATE, not a fixed pool of virtual users. The
// difference decides whether the test can see a regression at all: with
// fixed VUs, each one waits for its response before sending the next, so a
// server that gets slower simply receives less traffic and the numbers stay
// flat. An open model keeps the offered load constant no matter how the
// server responds, which is how real clients behave — they do not wait their
// turn.
//
// Run:
//   k6 run -e BASE_URL=http://localhost:3000 -e API_KEY=rov_pub_... \
//          -e PLACEMENT=onboarding load/k6/steady-read.js
//   RATE=500 to change the offered load.

import http from "k6/http";
import { check, group } from "k6";
import { BASE_URL, sdkHeaders, sloThresholds, userId } from "./lib/env.js";

const RATE = Number(__ENV.RATE || 100);
const PLACEMENT = __ENV.PLACEMENT || "onboarding";

export const options = {
  scenarios: {
    steady_read: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: __ENV.DURATION || "2m",
      // Headroom over rate * expected latency. k6 warns rather than fails if
      // it runs out, and that warning is itself a finding: it means the
      // server could not keep up with the offered load.
      preAllocatedVUs: Math.max(50, RATE),
      maxVUs: Math.max(200, RATE * 4),
    },
  },
  thresholds: sloThresholds,
};

export default function () {
  const base = BASE_URL();
  const headers = sdkHeaders(userId());

  group("entitlements", () => {
    const res = http.get(`${base}/v1/me/entitlements`, { headers });
    check(res, {
      "entitlements 200": (r) => r.status === 200,
      // An entitlements response that is not an envelope means the request
      // fell through to an error handler. Status alone would not catch it.
      "entitlements has data": (r) => r.body.includes('"data"'),
    });
  });

  group("placement", () => {
    const res = http.get(
      `${base}/v1/placements/${encodeURIComponent(PLACEMENT)}`,
      { headers },
    );
    // An unknown placement returns an EMPTY ENVELOPE, never a 404 — so 200
    // here does not prove the placement exists. That is deliberate in the
    // API and worth knowing when reading the results: a run against a
    // nonexistent identifier measures the audience walk finding nothing.
    check(res, { "placement 200": (r) => r.status === 200 });
  });
}
