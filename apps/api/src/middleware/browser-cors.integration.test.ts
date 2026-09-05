// =============================================================
// Browser surface CORS — integration tests
// =============================================================
//
// These assert on real OPTIONS responses, not on a helper's return value.
// The mechanism under test is whether a credential-less preflight can be
// answered per-project at all, and only a real preflight shows that.
//
// Scenarios:
//   1. A listed origin is echoed back, and the response varies on Origin
//   2. An origin absent from the key's list gets no allow-origin header
//   3. An unknown public key gets no allow-origin header
//   4. A key with an empty list is refused from every origin
//   5. The SDK's identity headers survive preflight

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs } from "@rovenue/db";
import { HEADER } from "@rovenue/shared";
import { browserCors } from "./browser-cors";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

const schema = drizzleNs.schema;

const RUN_ID = Date.now();
const LISTED_ORIGIN = "https://app.customer.com";
const UNLISTED_ORIGIN = "https://evil.example";

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;
let PROJECT_ID: string;
let WEB_KEY: string;
let NATIVE_KEY: string;
let app: Hono;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  PROJECT_ID = createId();
  WEB_KEY = `pk_web_${RUN_ID}`;
  NATIVE_KEY = `pk_native_${RUN_ID}`;

  await testDb
    .insert(schema.projects)
    .values({ id: PROJECT_ID, name: `browser-cors ${RUN_ID}` });

  await testDb.insert(schema.apiKeys).values([
    {
      id: createId(),
      projectId: PROJECT_ID,
      label: "web",
      keyPublic: WEB_KEY,
      keySecretHash: "hash",
      environment: "SANDBOX",
      allowedOrigins: [LISTED_ORIGIN, "http://localhost:3000"],
    },
    {
      id: createId(),
      projectId: PROJECT_ID,
      label: "native",
      keyPublic: NATIVE_KEY,
      keySecretHash: "hash",
      environment: "SANDBOX",
      // No allowedOrigins — the default. This is every key that predates
      // the Web SDK.
    },
  ]);

  const lookup = async (publicKey: string) => {
    const record = await drizzleNs.apiKeyRepo.findApiKeyByPublic(
      testDb as never,
      publicKey,
    );
    return record?.allowedOrigins ?? [];
  };

  const v1 = new Hono().get("/me/entitlements", (c) =>
    c.json({ data: { entitlements: {} } }),
  );

  app = new Hono()
    .use("/v1/web/:publicKey/*", browserCors(lookup))
    .route("/v1/web/:publicKey", v1);
});

afterAll(async () => {
  await testDb.delete(schema.projects).where(eq(schema.projects.id, PROJECT_ID));
  await pool.end();
});

async function preflight(
  key: string,
  origin: string,
  requestHeaders?: string,
): Promise<Response> {
  return app.request(`/v1/web/${key}/me/entitlements`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      ...(requestHeaders
        ? { "Access-Control-Request-Headers": requestHeaders }
        : {}),
    },
  });
}

describe("browserCors", () => {
  it("echoes a listed origin and varies on Origin", async () => {
    const res = await preflight(WEB_KEY, LISTED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(LISTED_ORIGIN);
    // Without Vary, a shared cache could serve one origin's response to
    // another origin.
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("refuses an origin that is not on the key's list", async () => {
    const res = await preflight(WEB_KEY, UNLISTED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("refuses an unknown public key", async () => {
    const res = await preflight(`pk_does_not_exist_${RUN_ID}`, LISTED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("refuses every origin for a key with an empty list", async () => {
    const res = await preflight(NATIVE_KEY, LISTED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("permits the SDK identity headers", async () => {
    const res = await preflight(
      WEB_KEY,
      LISTED_ORIGIN,
      `${HEADER.X_ROVENUE_APP_USER_ID},${HEADER.X_ROVENUE_PLATFORM}`,
    );
    // Assert the origin too. Hono echoes requested headers even when the
    // origin is refused, so a headers-only assertion passes against a
    // middleware that allows nothing — verified by mounting this middleware
    // at the wrong level, where this test still went green while the origin
    // test failed.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(LISTED_ORIGIN);
    const allowed = (
      res.headers.get("Access-Control-Allow-Headers") ?? ""
    ).toLowerCase();
    expect(allowed).toContain(HEADER.X_ROVENUE_APP_USER_ID);
    expect(allowed).toContain(HEADER.X_ROVENUE_PLATFORM);
  });
});

// =============================================================
// The same thing, against the REAL app
// =============================================================
//
// The block above builds a minimal Hono app, which is why it cannot see the
// failure that matters most here: `createApp()` registers a global
// `cors()` on `*`, and hono's cors TERMINATES an OPTIONS request itself. If
// the browser CORS is registered after it, the global one — whose origin
// list is the dashboard, not a customer's app — answers every preflight for
// /v1/web/* and the per-key middleware never runs at all.
//
// A green minimal-app suite alongside a broken real app is exactly the shape
// of a test that proves nothing, so these run against the composed app.
describe("browserCors in the composed app", () => {
  it("answers a browser preflight ahead of the global CORS", async () => {
    const { createApp } = await import("../app");
    const res = await createApp().request(
      `/v1/web/${WEB_KEY}/me/entitlements`,
      {
        method: "OPTIONS",
        headers: {
          Origin: LISTED_ORIGIN,
          "Access-Control-Request-Method": "GET",
        },
      },
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(LISTED_ORIGIN);
  });

  it("still refuses an unlisted origin in the composed app", async () => {
    const { createApp } = await import("../app");
    const res = await createApp().request(
      `/v1/web/${WEB_KEY}/me/entitlements`,
      {
        method: "OPTIONS",
        headers: {
          Origin: UNLISTED_ORIGIN,
          "Access-Control-Request-Method": "GET",
        },
      },
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("leaves the dashboard's own CORS intact on a non-browser path", async () => {
    const { createApp } = await import("../app");
    const { env } = await import("../lib/env");
    const res = await createApp().request("/v1/config", {
      method: "OPTIONS",
      headers: {
        Origin: env.DASHBOARD_URL,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      env.DASHBOARD_URL,
    );
  });
});
