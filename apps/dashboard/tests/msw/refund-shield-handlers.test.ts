import { describe, expect, test } from "vitest";

const BASE = "http://localhost:3000";

// Note: MSW server lifecycle is owned by tests/setup.ts — no per-file
// beforeAll/afterEach/afterAll calls.

describe("refund-shield MSW handlers", () => {
  test("GET settings returns disabled by default", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/settings`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.settings).toMatchObject({
      enabled: false,
      responseDelayMinutes: 60,
    });
  });

  test("PUT settings echoes the patch", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          responseDelayMinutes: 120,
          consentAcknowledged: true,
        }),
      },
    );
    const body = await res.json();
    expect(body.data.settings.enabled).toBe(true);
    expect(body.data.settings.responseDelayMinutes).toBe(120);
    expect(body.data.settings.consentAcknowledgedAt).not.toBeNull();
  });

  test("GET responses returns at least one row + nextCursor null", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/responses?limit=50`,
    );
    const body = await res.json();
    expect(body.data.responses.length).toBeGreaterThan(0);
    expect(body.data).toHaveProperty("nextCursor");
  });

  test("GET response by id returns the matching fixture", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/responses/rss_sent_declined`,
    );
    const body = await res.json();
    expect(body.data.response.id).toBe("rss_sent_declined");
    expect(body.data.response.requestPayload).toMatchObject({
      customerConsented: true,
    });
  });

  test("GET metrics returns numeric KPI surface", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/metrics`,
    );
    const body = await res.json();
    expect(body.data).toMatchObject({
      sentCount: expect.any(Number),
      outcomeCount: expect.any(Number),
      declinedCount: expect.any(Number),
      approvedCount: expect.any(Number),
      reversedCount: expect.any(Number),
      winRate: expect.any(Number),
      estimatedRevenueSavedCents: expect.any(Number),
    });
  });
});
