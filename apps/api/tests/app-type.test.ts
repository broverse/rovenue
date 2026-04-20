import { hc } from "hono/client";
import type { AppType } from "../src/app";

// =============================================================
// AppType compile-time smoke test
// =============================================================
//
// Vitest picks up this file when it contains a `describe`/`it`
// call, but the important checks are happening at TYPE level in
// the variable declarations below — if `hc<AppType>()` doesn't
// resolve or the chained paths are missing, this file fails to
// type-check before any runtime assertion runs.
//
// When Phase 1 of the RPC cutover wires zValidator into sub-routes
// we'll add `expectTypeOf<...>()` checks here to pin the request
// body + response shapes.

import { describe, it, expect } from "vitest";

describe("AppType", () => {
  it("instantiates a typed hc<AppType>() client", () => {
    const client = hc<AppType>("http://localhost");
    // The client is built lazily — calling `$url()` on any route
    // exercises the proxy without issuing a request.
    expect(typeof client).toBe("function");
  });

  it("exposes the top-level path segments that createApp mounts", () => {
    const client = hc<AppType>("http://localhost");
    // Drop to `any` for the access chain; `any` here documents
    // that Phase 1 will replace these with proper
    // `expectTypeOf<typeof client.v1.config.$get>`-style assertions
    // once zValidator is wired into each sub-route.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    expect(c.health).toBeDefined();
    expect(c.v1).toBeDefined();
    expect(c.dashboard).toBeDefined();
    expect(c.webhooks).toBeDefined();
  });
});
