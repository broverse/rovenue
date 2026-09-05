// Shared configuration for every profile.
//
// Nothing here has a default that points at a real deployment. A load
// generator whose target defaults to something reachable is one typo away
// from being pointed at production, so BASE_URL and API_KEY are required and
// the run aborts without them.

import exec from "k6/execution";

export function required(name) {
  const value = __ENV[name];
  if (!value) {
    exec.test.abort(
      `${name} is required. Example:\n` +
        `  k6 run -e BASE_URL=http://localhost:3000 -e API_KEY=rov_pub_... load/k6/steady-read.js`,
    );
  }
  return value;
}

export const BASE_URL = () => required("BASE_URL").replace(/\/$/, "");
export const API_KEY = () => required("API_KEY");

/**
 * Headers for an SDK request.
 *
 * Both identity headers are sent, and both carry the same value. That is not
 * redundancy: /v1/me reads the app-user header while /v1/placements,
 * /v1/config and /v1/experiments read x-rovenue-user-id, and a load profile
 * that sent only one would exercise half the routes anonymously — measuring
 * a cheaper request than the one production serves.
 */
export function sdkHeaders(userId) {
  return {
    Authorization: `Bearer ${API_KEY()}`,
    "Content-Type": "application/json",
    "x-rovenue-app-user-id": userId,
    "x-rovenue-user-id": userId,
    "x-rovenue-platform": "ios",
  };
}

/**
 * A distinct subscriber per virtual user and iteration.
 *
 * Reusing one id across the whole run is the classic way to produce a
 * beautiful, meaningless number: every request hits the same warm row, the
 * same cache entry, and the same partition. Real traffic spreads.
 */
export function userId() {
  return `load_${exec.vu.idInTest}_${exec.vu.iterationInInstance}`;
}

/**
 * Pass/fail criteria, taken from the SLOs in
 * deploy/prometheus/rules/slo.yml rather than invented here. One definition
 * of "fast enough" for the alerting rules and the load suite both.
 */
export const sloThresholds = {
  // 99% under 500ms.
  http_req_duration: ["p(99)<500"],
  // 99.9% availability. k6 counts any non-2xx/3xx as failed, which is
  // stricter than the SLO (it folds in 4xx) — fine for a load run, where a
  // 4xx means the profile itself is malformed.
  http_req_failed: ["rate<0.001"],
};
