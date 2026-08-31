import { describe, expect, it, vi } from "vitest";
import { ASSET_MAX_BYTES, ERROR_CODE } from "@rovenue/shared";

// =============================================================
// Global body limit must not shadow the upload routes
// =============================================================
//
// Regression test for the asset upload that failed in the dashboard as
// "Network error during upload" while the server had in fact answered
// 413 "Payload Too Large": the root app's `*` body limit (1 MiB) runs
// BEFORE the assets/fonts routes' own, larger, caps, so every upload
// over 1 MiB was rejected by the wrong middleware — with hono's default
// plain-text body, and early enough (off the Content-Length header, no
// body read) that the browser saw the socket close mid-upload and
// reported a network failure with no status at all.
//
// This has to go through `createApp()`. The route's own suite
// (tests/routes/dashboard/assets.test.ts) mounts `assetsRoute` on a bare
// Hono app, which is exactly why it stayed green while every real upload
// was broken — a route-level test cannot see a root-level middleware.

const redisMulti = vi.hoisted(() => () => {
  const chain = {
    zremrangebyscore: () => chain,
    zadd: () => chain,
    zcard: () => chain,
    zrange: () => chain,
    pexpire: () => chain,
    exec: async () => [
      [null, 0],
      [null, 1],
      [null, 1],
      [null, []],
      [null, 1],
    ],
  };
  return chain;
});

vi.mock("../src/lib/redis", () => ({
  redis: {
    multi: redisMulti,
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
  },
}));

/** Over the root app's 1 MiB cap, under every upload route's own cap
 *  (the smallest is Lottie's 2 MiB). A body in this band is the one the
 *  bug rejected: legal for the route, illegal for the global limit. */
const OVER_GLOBAL_UNDER_ROUTE_BYTES = 1_500_000;

const STATUS_PAYLOAD_TOO_LARGE = 413;

async function errorCode(res: Response): Promise<string | undefined> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    // A non-JSON body means hono's default `onError` answered — the
    // shape this app never emits, and the shape the bug produced.
    return text;
  }
}

function body(bytes: number): Uint8Array {
  return new Uint8Array(bytes);
}

async function post(path: string, bytes: number) {
  vi.resetModules();
  const { createApp } = await import("../src/app");
  const payload = body(bytes);
  return createApp().request(path, {
    method: "POST",
    // Explicit: `bodyLimit` decides off this header alone when it is
    // present, which is the path a browser upload always takes.
    headers: { "content-length": String(payload.byteLength) },
    body: payload,
  });
}

const PROJECT_PATH = "/dashboard/projects/p_test";

describe("global body limit", () => {
  it.each([
    [`${PROJECT_PATH}/assets/image`],
    [`${PROJECT_PATH}/assets/video`],
    [`${PROJECT_PATH}/assets/lottie`],
    [`${PROJECT_PATH}/fonts`],
    [`${PROJECT_PATH}/imports`],
  ])("does not reject %s for exceeding the 1 MiB global cap", async (path) => {
    const res = await post(path, OVER_GLOBAL_UNDER_ROUTE_BYTES);

    // Unauthenticated, so the expected answer is 401 from
    // `requireDashboardAuth` — the point is that the request got as far
    // as the route at all rather than dying on the global cap.
    expect(await errorCode(res)).not.toBe(ERROR_CODE.PAYLOAD_TOO_LARGE);
    expect(res.status).not.toBe(STATUS_PAYLOAD_TOO_LARGE);
  });

  it("still caps every other route at 1 MiB", async () => {
    const res = await post(`${PROJECT_PATH}/paywalls`, OVER_GLOBAL_UNDER_ROUTE_BYTES);

    expect(res.status).toBe(STATUS_PAYLOAD_TOO_LARGE);
    expect(await errorCode(res)).toBe(ERROR_CODE.PAYLOAD_TOO_LARGE);
  });

  it("leaves the assets route's own per-kind cap in force", async () => {
    const res = await post(
      `${PROJECT_PATH}/assets/lottie`,
      ASSET_MAX_BYTES.lottie + 1,
    );

    // The route's cap is bound behind `requireDashboardAuth`, so an
    // anonymous request is refused before it — asserting the status is
    // NOT hono's global 413 is the honest claim here; the route-level
    // suite owns the authenticated too-large case.
    expect(await errorCode(res)).not.toBe(ERROR_CODE.PAYLOAD_TOO_LARGE);
  });
});
