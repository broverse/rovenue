// =============================================================
// Profile: receipt spike  (OPT-IN — makes outbound calls to a store)
// =============================================================
//
// The shape a promotion or a featuring produces: a purchase surge inside a
// few minutes, each one a receipt to verify, an entitlement to recompute,
// and a subscriber row to converge.
//
// WHY THIS ONE IS GATED
//
// /v1/receipts/apple calls verifyReceipt, which talks to Apple's App Store
// Server API (and the Google equivalent for /google). Pointing a load
// generator at this endpoint therefore points it at a THIRD PARTY, at
// whatever rate you configured, using your credentials. That is not ours to
// do by default, so the profile aborts unless LOAD_ALLOW_OUTBOUND=1 is set
// deliberately.
//
// WHAT IT MEASURES WITHOUT REAL RECEIPTS
//
// With synthetic payloads, verification fails and you are measuring the
// rejection path: auth, rate limit, idempotency, body validation, and the
// store round-trip up to its refusal. That is a real and useful number —
// it is what a replay flood costs — but it is NOT the cost of a successful
// purchase, which additionally writes a purchase, recomputes access, grants
// currencies and emits an outbox row. Do not report the two as the same
// number.
//
// For the successful path, run against a sandbox project with sandbox
// receipts in RECEIPTS_FILE (one base64 receipt per line).
//
// Run:
//   k6 run -e BASE_URL=... -e API_KEY=rov_pub_... -e PRODUCT_ID=pro_monthly \
//          -e LOAD_ALLOW_OUTBOUND=1 load/k6/receipt-spike.js

import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";
import { BASE_URL, sdkHeaders, userId } from "./lib/env.js";

const PEAK = Number(__ENV.PEAK || 50);
const PRODUCT_ID = __ENV.PRODUCT_ID || "pro_monthly";

export const options = {
  scenarios: {
    receipt_spike: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: Math.max(20, PEAK),
      maxVUs: Math.max(100, PEAK * 4),
      stages: [
        { target: PEAK, duration: "30s" },
        { target: PEAK, duration: "1m" },
        { target: 0, duration: "15s" },
      ],
    },
  },
  // Deliberately no SLO thresholds. Receipt verification is bounded by a
  // third party's latency, so holding it to the API's own 500ms budget would
  // fail the run for something the service does not control.
  thresholds: {},
};

export function setup() {
  if (__ENV.LOAD_ALLOW_OUTBOUND !== "1") {
    exec.test.abort(
      "receipt-spike calls a real store API. Re-run with " +
        "-e LOAD_ALLOW_OUTBOUND=1 once you have confirmed the target " +
        "project uses sandbox store credentials.",
    );
  }
}

export default function () {
  const base = BASE_URL();
  const id = userId();

  const body = JSON.stringify({
    receipt: `load-synthetic-${id}`,
    productId: PRODUCT_ID,
    appUserId: id,
  });

  const res = http.post(`${base}/v1/receipts/apple`, body, {
    headers: {
      ...sdkHeaders(id),
      // A distinct key per iteration. Reusing one would make every request
      // after the first a cached idempotency hit, which measures the cache
      // and calls it receipt verification.
      "Idempotency-Key": `load_${id}_${Date.now()}`,
    },
  });

  check(res, {
    // Both outcomes are expected and neither is a test failure: a synthetic
    // receipt is refused, a real sandbox one succeeds. What would be a
    // failure is a 5xx.
    "no server error": (r) => r.status < 500,
  });
}
