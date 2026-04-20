import { hc, type InferRequestType, type InferResponseType } from "hono/client";
import { describe, expectTypeOf, it, expect } from "vitest";
import type { AppType } from "../src/app";

// =============================================================
// AppType compile-time smoke test
// =============================================================
//
// Vitest picks up this file when it contains a `describe`/`it`
// call, but the important checks are happening at TYPE level in
// the declarations below — if `hc<AppType>()` doesn't resolve or
// the chained paths drop, this file fails to type-check before
// any runtime assertion runs.
//
// `expectTypeOf` from vitest is a compile-time assertion; the
// runtime body just ensures the test suite registers.

describe("AppType — top-level surface", () => {
  it("instantiates a typed hc<AppType>() client", () => {
    const client = hc<AppType>("http://localhost");
    expect(typeof client).toBe("function");
  });
});

describe("AppType — /v1/config inference", () => {
  const client = hc<AppType>("http://localhost");

  it("types the POST /v1/config body through zValidator", () => {
    // `InferRequestType` narrows to the zValidator input. Accepting
    // `attributes: { country: "TR" }` must compile; passing a
    // number for attributes must not.
    type Req = InferRequestType<typeof client.v1.config.$post>;
    expectTypeOf<Req>().toMatchTypeOf<{
      json: { attributes?: Record<string, unknown> };
    }>();

    // Missing body form — attributes is optional
    const ok1: Req = { json: { attributes: { country: "TR" } } };
    const ok2: Req = { json: {} };
    expect(ok1.json).toBeDefined();
    expect(ok2.json).toBeDefined();
  });

  it("exposes POST /v1/config at the expected path", () => {
    const url = client.v1.config.$url();
    expect(url.pathname).toBe("/v1/config");
  });

  it("exposes GET /v1/config", () => {
    // $get on the same route — present because configRoute chains
    // .get("/") alongside .post("/").
    expectTypeOf(client.v1.config.$get).toBeFunction();
  });
});

describe("AppType — /v1/experiments/track inference", () => {
  const client = hc<AppType>("http://localhost");

  it("requires events: [...] via zValidator", () => {
    type Req = InferRequestType<typeof client.v1.experiments.track.$post>;
    expectTypeOf<Req>().toMatchTypeOf<{
      json: {
        events: Array<{
          type: string;
          key?: string;
          timestamp?: string;
          metadata?: Record<string, unknown>;
        }>;
      };
    }>();

    const ok: Req = {
      json: {
        events: [
          { type: "paywall_viewed" },
          { type: "cta_clicked", key: "exp_a", metadata: { screen: "home" } },
        ],
      },
    };
    expect(ok.json.events).toHaveLength(2);
  });

  it("response carries recorded count through InferResponseType", () => {
    type Res = InferResponseType<typeof client.v1.experiments.track.$post>;
    // The route wraps payloads with `ok({ recorded })`, so the
    // response shape at the type level is `{ data: { recorded: number } }`.
    expectTypeOf<Res>().toMatchTypeOf<{ data: { recorded: number } }>();
  });
});
