/**
 * Unit tests for the `clientIp` helper in the rate-limit middleware.
 *
 * The helper should pick the rightmost-non-trusted hop from
 * X-Forwarded-For according to TRUSTED_PROXY_COUNT, so that a client
 * cannot spoof its own bucket by prepending fake IPs to the header.
 *
 * TRUSTED_PROXY_COUNT is read inside clientIp() on each call, so
 * we can set process.env.TRUSTED_PROXY_COUNT per test and import the
 * module with vi.importActual after setting the env.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module isolation: we need clientIp to re-read process.env on each call
// because the implementation reads it inside the function body.
// We use vi.resetModules() between env-changing tests.
// ---------------------------------------------------------------------------

// Minimal fake Hono Context factory — only req.header() is needed.
function fakeContext(headers: Record<string, string>) {
  return {
    req: {
      header(name: string): string | undefined {
        return headers[name.toLowerCase()];
      },
    },
  } as any;
}

// Import helper — re-imports the module after resetting so the new
// process.env.TRUSTED_PROXY_COUNT takes effect.
async function importClientIp() {
  vi.resetModules();
  // The module imports redis; mock it so the import doesn't fail.
  vi.mock("../src/lib/redis", () => ({ redis: { multi: vi.fn() } }));
  const mod = await import("../src/middleware/rate-limit");
  return (mod as any).clientIp as (c: any) => string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clientIp — trusted-proxy depth extraction", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_COUNT;
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // Core spoofing protection: TRUSTED_PROXY_COUNT=1
  // -----------------------------------------------------------------------

  test("TRUSTED_PROXY_COUNT=1: attacker-prepended hops are ignored; returns second-from-last hop", async () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    const clientIp = await importClientIp();

    // XFF: "evil, 1.2.3.4, 10.0.0.1"
    //   hops = ["evil", "1.2.3.4", "10.0.0.1"]  (length 3)
    //   idx  = max(0, 3 - 1 - 1) = 1  → "1.2.3.4"
    const c = fakeContext({ "x-forwarded-for": "evil, 1.2.3.4, 10.0.0.1" });
    expect(clientIp(c)).toBe("1.2.3.4");
  });

  test("TRUSTED_PROXY_COUNT=1: additional attacker-prepended hops still return correct IP", async () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    const clientIp = await importClientIp();

    // "spoof1, spoof2, real, 10.0.0.1"
    //   hops = ["spoof1", "spoof2", "real", "10.0.0.1"]  (length 4)
    //   idx  = max(0, 4 - 1 - 1) = 2  → "real"
    const c = fakeContext({
      "x-forwarded-for": "spoof1, spoof2, real, 10.0.0.1",
    });
    expect(clientIp(c)).toBe("real");
  });

  // -----------------------------------------------------------------------
  // Single-hop XFF (only the client's own IP, no proxy appended yet)
  // -----------------------------------------------------------------------

  test("TRUSTED_PROXY_COUNT=1: single-hop XFF clamps idx to 0, returns that hop", async () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    const clientIp = await importClientIp();

    // "5.5.5.5"
    //   hops = ["5.5.5.5"]  (length 1)
    //   idx  = max(0, 1 - 1 - 1) = 0  → "5.5.5.5"
    const c = fakeContext({ "x-forwarded-for": "5.5.5.5" });
    expect(clientIp(c)).toBe("5.5.5.5");
  });

  // -----------------------------------------------------------------------
  // Default (no env set) — should behave like TRUSTED_PROXY_COUNT=1
  // -----------------------------------------------------------------------

  test("default (no env): behaves identically to TRUSTED_PROXY_COUNT=1", async () => {
    // TRUSTED_PROXY_COUNT not set → default is "1"
    const clientIp = await importClientIp();

    const c = fakeContext({ "x-forwarded-for": "evil, 1.2.3.4, 10.0.0.1" });
    expect(clientIp(c)).toBe("1.2.3.4");
  });

  // -----------------------------------------------------------------------
  // TRUSTED_PROXY_COUNT=0 (direct connection, no proxy — take last hop)
  // -----------------------------------------------------------------------

  test("TRUSTED_PROXY_COUNT=0: takes the last hop (no proxy to skip)", async () => {
    process.env.TRUSTED_PROXY_COUNT = "0";
    const clientIp = await importClientIp();

    // hops = ["1.2.3.4", "10.0.0.1"]  (length 2)
    // idx  = max(0, 2 - 1 - 0) = 1  → "10.0.0.1"
    const c = fakeContext({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" });
    expect(clientIp(c)).toBe("10.0.0.1");
  });

  // -----------------------------------------------------------------------
  // TRUSTED_PROXY_COUNT=2 (e.g., load balancer + CDN)
  // -----------------------------------------------------------------------

  test("TRUSTED_PROXY_COUNT=2: skips last 2 hops", async () => {
    process.env.TRUSTED_PROXY_COUNT = "2";
    const clientIp = await importClientIp();

    // "client, proxy1, lb, cdn"
    //   hops = ["client", "proxy1", "lb", "cdn"]  (length 4)
    //   idx  = max(0, 4 - 1 - 2) = 1  → "proxy1"
    const c = fakeContext({ "x-forwarded-for": "client, proxy1, lb, cdn" });
    expect(clientIp(c)).toBe("proxy1");
  });

  // -----------------------------------------------------------------------
  // Missing XFF header fallbacks
  // -----------------------------------------------------------------------

  test("no XFF, has x-real-ip: returns x-real-ip value", async () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    const clientIp = await importClientIp();

    const c = fakeContext({ "x-real-ip": "7.7.7.7" });
    expect(clientIp(c)).toBe("7.7.7.7");
  });

  test("no XFF, no x-real-ip: returns 'unknown'", async () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    const clientIp = await importClientIp();

    const c = fakeContext({});
    expect(clientIp(c)).toBe("unknown");
  });

  // -----------------------------------------------------------------------
  // Whitespace trimming
  // -----------------------------------------------------------------------

  test("extra whitespace around hops is trimmed", async () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    const clientIp = await importClientIp();

    const c = fakeContext({ "x-forwarded-for": "  1.2.3.4  ,  10.0.0.1  " });
    expect(clientIp(c)).toBe("1.2.3.4");
  });
});
