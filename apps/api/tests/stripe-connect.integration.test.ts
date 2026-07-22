// =============================================================
// Stripe Connect — end-to-end lifecycle integration test
// =============================================================
//
// Runs against the docker-compose dev Postgres (host port 5433) and
// Redis (host port 6380), exactly like
// billing-webhook-handlers.integration.test.ts. Only the Stripe SDK
// is stubbed: `oauth.token`, `oauth.deauthorize` and
// `accounts.retrieve`. The connection row, the audit hash chain and
// the partial unique index are all real.
//
// Test ordering is deliberate and load-bearing (see the comment on
// "rejects a replayed state" below) — do not reorder these `it`s.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.PUBLIC_BASE_URL ??= "https://api.test";
process.env.DASHBOARD_URL ??= "https://app.test";
process.env.STRIPE_CONNECT_CLIENT_ID ??= "ca_live_test";
process.env.STRIPE_PLATFORM_SECRET_KEY ??= "sk_live_fake";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET ??= "whsec_connect_it";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { Pool } from "pg";
import { MemberRole, drizzle } from "@rovenue/db";

const oauthToken = vi.hoisted(() => vi.fn());
const oauthDeauthorize = vi.hoisted(() => vi.fn(async () => ({})));
const accountsRetrieve = vi.hoisted(() => vi.fn());
const enqueueWebhookEvent = vi.hoisted(() =>
  vi.fn(async () => ({ id: "job_1" })),
);
const assertProjectAccessMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

// The platform-client accessor is `getConnectPlatformStripe` (not
// `getPlatformStripe` — that name belongs to the unrelated cloud
// billing client in lib/stripe-billing.ts). It takes a `livemode`
// arg in the real module; the stub below ignores it and always
// returns the same fake client, matching the pattern already proven
// in tests/stripe-connect-routes.test.ts and
// tests/stripe-connect-webhook.test.ts. `webhooks` is left as the
// REAL `Stripe.webhooks` static so signature verification in the
// Connect webhook route is exercised for real — only the OAuth/account
// calls are stubbed.
vi.mock("../src/lib/stripe-platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/stripe-platform")>();
  return {
    ...actual,
    getConnectPlatformStripe: () => ({
      oauth: { token: oauthToken, deauthorize: oauthDeauthorize },
      accounts: { retrieve: accountsRetrieve },
      webhooks: Stripe.webhooks,
    }),
  };
});

vi.mock("../src/services/webhook-processor", () => ({ enqueueWebhookEvent }));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: USER_ID });
    await next();
  },
}));

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: assertProjectAccessMock,
}));

// Per-run-unique ids so a repeat run (this file is executed twice in
// the same verification session) can never collide with rows a prior
// run left behind — afterAll also deletes everything keyed by these.
const RUN_ID = randomUUID().slice(0, 8);
const PROJECT_ID = `proj_sc_it_${RUN_ID}`;
const USER_ID = `user_sc_it_${RUN_ID}`;
const ACCOUNT_ID = `acct_sc_it_${RUN_ID}`;
const SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET as string;

let pool: Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

async function buildApp() {
  const { createApp } = await import("../src/app");
  return createApp();
}

function signed(payload: unknown) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret: SECRET,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    },
  };
}

const connectPath = `/dashboard/projects/${PROJECT_ID}/stripe/connect`;

async function beginConnect(): Promise<string> {
  const res = await app.request(connectPath);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  // Assert WHERE we send the customer, not just that we send them
  // somewhere: a regression pointing the consent step at another host
  // would still be a 302 carrying a state param.
  expect(location.origin + location.pathname).toBe(
    "https://connect.stripe.com/oauth/authorize",
  );
  expect(location.searchParams.get("response_type")).toBe("code");
  expect(location.searchParams.get("scope")).toBe("read_write");
  const state = location.searchParams.get("state") ?? "";
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return state;
}

async function activeRows() {
  const { rows } = await pool.query(
    `SELECT * FROM project_stripe_connections
      WHERE project_id = $1 AND disconnected_at IS NULL`,
    [PROJECT_ID],
  );
  return rows;
}

async function auditActions() {
  const { rows } = await pool.query(
    `SELECT action FROM audit_logs WHERE "projectId" = $1 ORDER BY "createdAt"`,
    [PROJECT_ID],
  );
  return rows.map((r) => r.action as string);
}

// There is no exported `seedProjectAndUser` helper anywhere in the repo
// — the column lists below are lifted from the working patterns in
// tests/notifier-entry.integration.test.ts (the `user` row: id, name,
// email, emailVerified, createdAt, updatedAt) and
// tests/billing-webhook-handlers.integration.test.ts (the `projects`
// row, here with a pinned id instead of relying on the cuid2 default so
// the dashboard route path is known ahead of time). A real `user` row
// is required because `project_stripe_connections.connected_by`
// references `user.id`.
async function seedProjectAndUser(): Promise<void> {
  const now = new Date();
  await drizzle.db.insert(drizzle.schema.user).values({
    id: USER_ID,
    name: `Stripe Connect IT ${RUN_ID}`,
    email: `${USER_ID}@stripe-connect-it.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await drizzle.db.insert(drizzle.schema.projects).values({
    id: PROJECT_ID,
    name: `Stripe Connect IT ${RUN_ID}`,
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await seedProjectAndUser();
  app = await buildApp();

  oauthToken.mockResolvedValue({
    stripe_user_id: ACCOUNT_ID,
    livemode: true,
    scope: "read_write",
    access_token: "sk_live_LEAK",
    refresh_token: "rt_LEAK",
  });
  accountsRetrieve.mockResolvedValue({
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { card_payments: "active" },
    country: "TR",
    default_currency: "try",
  });
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM project_stripe_connections WHERE project_id = $1",
    [PROJECT_ID],
  );
  await pool.query('DELETE FROM audit_logs WHERE "projectId" = $1', [
    PROJECT_ID,
  ]);
  await pool.query("DELETE FROM projects WHERE id = $1", [PROJECT_ID]);
  await pool.query('DELETE FROM "user" WHERE id = $1', [USER_ID]);
  await pool.end();
});

describe("Stripe Connect lifecycle", () => {
  // Shared across the first two `it`s on purpose: the second test
  // replays this EXACT nonce rather than minting a fresh one. A fresh
  // GET /connect after the first test would 409 ("Project already has
  // an active Stripe connection") since that test's connection is
  // still live — so "replay" here means what the route actually
  // guards against: reusing an already-consumed `state` value, not a
  // second full connect handshake.
  let firstState = "";

  it("connects, persists the account and audits it (OWNER-gated)", async () => {
    firstState = await beginConnect();
    expect(assertProjectAccessMock).toHaveBeenCalledWith(
      PROJECT_ID,
      USER_ID,
      MemberRole.OWNER,
    );

    const res = await app.request(
      `/stripe/oauth/callback?state=${firstState}&code=ok`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("stripe=connected");

    const rows = await activeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_account_id).toBe(ACCOUNT_ID);
    expect(rows[0].livemode).toBe(true);
    expect(rows[0].charges_enabled).toBe(true);
    expect(rows[0].capabilities).toEqual({ card_payments: "active" });
    // The OAuth tokens must not have reached the database in any column.
    expect(JSON.stringify(rows[0])).not.toContain("LEAK");
    expect(await auditActions()).toContain("stripe.connected");
  });

  it("rejects a replayed state and writes no second row", async () => {
    const replay = await app.request(
      `/stripe/oauth/callback?state=${firstState}&code=ok`,
    );
    expect(replay.status).toBe(400);
    expect(await activeRows()).toHaveLength(1);
  });

  it("routes a connected-account webhook to the project", async () => {
    enqueueWebhookEvent.mockClear();
    const { body, headers } = signed({
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      account: ACCOUNT_ID,
      data: { object: {} },
    });
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(enqueueWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "STRIPE", projectId: PROJECT_ID }),
    );
  });

  it("disconnects, audits it, and then ignores that account's events", async () => {
    const del = await app.request(connectPath, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await activeRows()).toHaveLength(0);
    expect(await auditActions()).toContain("stripe.disconnected");

    enqueueWebhookEvent.mockClear();
    const { body, headers } = signed({
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      account: ACCOUNT_ID,
      data: { object: {} },
    });
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { status: "unknown_account" } });
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("allows reconnecting after a disconnect", async () => {
    // Proves the partial unique index (WHERE disconnected_at IS NULL)
    // is scoped to live rows only and does not block reconnecting —
    // the prior row for this same project_id still exists, just
    // disconnected.
    const state = await beginConnect();
    const res = await app.request(
      `/stripe/oauth/callback?state=${state}&code=ok`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("stripe=connected");
    expect(await activeRows()).toHaveLength(1);
  });
});
