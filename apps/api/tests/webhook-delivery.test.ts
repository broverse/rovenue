import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, fetchMock } = vi.hoisted(() => {
  const prismaMock = {
    outgoingWebhook: {
      update: vi.fn(async (args: any) => ({ id: "ow_1", ...args.data })),
    },
    $queryRaw: vi.fn(async () => [] as Array<Record<string, unknown>>),
  };

  const fetchMock = vi.fn<
    [string, RequestInit?],
    Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
  >();

  return { prismaMock, fetchMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  OutgoingWebhookStatus: {
    PENDING: "PENDING",
    SENT: "SENT",
    FAILED: "FAILED",
    DEAD: "DEAD",
    DISMISSED: "DISMISSED",
  },
}));

// =============================================================
// System under test
// =============================================================

import {
  deliverWebhooks,
  MAX_ATTEMPTS,
  BACKOFF_SCHEDULE_MS,
  signPayload,
} from "../src/workers/webhook-delivery";

// =============================================================
// Helpers
// =============================================================

function webhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ow_1",
    projectId: "proj_a",
    payload: { eventType: "purchase", subscriberId: "sub_1" },
    url: "https://example.com/hook",
    attempts: 0,
    projectWebhookSecret: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([]);
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "OK",
  });
});

// =============================================================
// Config
// =============================================================

describe("webhook-delivery config", () => {
  test("MAX_ATTEMPTS is 5", () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });

  test("backoff schedule is 1m, 5m, 30m, 2h, 12h", () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([
      1 * 60_000,
      5 * 60_000,
      30 * 60_000,
      2 * 60 * 60_000,
      12 * 60 * 60_000,
    ]);
  });
});

// =============================================================
// Successful delivery
// =============================================================

describe("deliverWebhooks — success", () => {
  test("delivers pending webhooks and marks them SENT", async () => {
    prismaMock.$queryRaw.mockResolvedValue([webhook()]);

    await deliverWebhooks(fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ eventType: "purchase", subscriberId: "sub_1" }),
      }),
    );

    const updateCall = prismaMock.outgoingWebhook.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.status).toBe("SENT");
    expect(updateCall.data.httpStatus).toBe(200);
    expect(updateCall.data.sentAt).toBeInstanceOf(Date);
    expect(updateCall.data.attempts).toBe(1);
  });

  test("raw fetch query uses FOR UPDATE SKIP LOCKED to prevent double-dispatch", async () => {
    // The worker is pulled from outgoing_webhooks via prisma.$queryRaw
    // with a SELECT … FOR UPDATE OF w SKIP LOCKED. Under multi-replica
    // deploys this row-level lock keeps two workers from grabbing the
    // same row and double-dispatching the webhook. The mock captures
    // the tagged-template strings array; we assert the SQL contains
    // the lock clauses + the join against projects for the webhook
    // secret.
    prismaMock.$queryRaw.mockResolvedValue([]);

    await deliverWebhooks(fetchMock);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    const firstArg = prismaMock.$queryRaw.mock.calls[0]![0] as unknown;
    // Prisma's $queryRaw tagged template receives a TemplateStringsArray.
    const templateParts = Array.from(firstArg as ArrayLike<string>);
    const sql = templateParts.join(" ");
    expect(sql).toMatch(/FROM\s+outgoing_webhooks/i);
    expect(sql).toMatch(/JOIN\s+projects/i);
    expect(sql).toMatch(/FOR\s+UPDATE/i);
    expect(sql).toMatch(/SKIP\s+LOCKED/i);
  });

  test("includes HMAC signature + event-id headers when project has a webhook secret", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      webhook({ projectWebhookSecret: "topsecret-abc" }),
    ]);

    await deliverWebhooks(fetchMock);

    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as { headers: Record<string, string>; body: string };
    expect(init.headers["x-rovenue-event-id"]).toBe("ow_1");
    expect(init.headers["x-rovenue-timestamp"]).toMatch(/^\d+$/);
    const sig = init.headers["x-rovenue-signature"]!;
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const ts = Number(init.headers["x-rovenue-timestamp"]);
    const expected = signPayload(init.body, ts, "topsecret-abc");
    expect(sig).toBe(`t=${ts},v1=${expected}`);
  });

  test("omits signature header when project has no webhook secret", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      webhook({ projectWebhookSecret: null }),
    ]);

    await deliverWebhooks(fetchMock);

    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers["x-rovenue-signature"]).toBeUndefined();
    expect(init.headers["x-rovenue-event-id"]).toBe("ow_1");
  });
});

// =============================================================
// Failed delivery — retry
// =============================================================

describe("deliverWebhooks — failure + retry", () => {
  test("on HTTP failure: status stays FAILED, attempts +1, nextRetryAt scheduled", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    prismaMock.$queryRaw.mockResolvedValue([webhook()]);

    await deliverWebhooks(fetchMock);

    const data = (
      prismaMock.outgoingWebhook.update.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.status).toBe("FAILED");
    expect(data.attempts).toBe(1);
    expect(data.httpStatus).toBe(500);
    expect(data.lastErrorMessage).toBe("Internal Server Error");
    expect(data.nextRetryAt).toBeInstanceOf(Date);
  });

  test("on network error: records error message, schedules retry", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    prismaMock.$queryRaw.mockResolvedValue([webhook()]);

    await deliverWebhooks(fetchMock);

    const data = (
      prismaMock.outgoingWebhook.update.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.status).toBe("FAILED");
    expect(data.lastErrorMessage).toBe("ECONNREFUSED");
  });
});

// =============================================================
// Dead letter after MAX_ATTEMPTS
// =============================================================

describe("deliverWebhooks — dead letter", () => {
  test("marks DEAD after exhausting all retries", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    });
    prismaMock.$queryRaw.mockResolvedValue([
      webhook({ attempts: MAX_ATTEMPTS - 1 }),
    ]);

    await deliverWebhooks(fetchMock);

    const data = (
      prismaMock.outgoingWebhook.update.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.status).toBe("DEAD");
    expect(data.deadAt).toBeInstanceOf(Date);
    expect(data.nextRetryAt).toBeNull();
    expect(data.attempts).toBe(MAX_ATTEMPTS);
  });

  test("still retries when attempts < MAX_ATTEMPTS - 1", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Unavailable",
    });
    prismaMock.$queryRaw.mockResolvedValue([webhook({ attempts: 2 })]);

    await deliverWebhooks(fetchMock);

    const data = (
      prismaMock.outgoingWebhook.update.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.status).toBe("FAILED");
    expect(data.attempts).toBe(3);
    expect(data.nextRetryAt).toBeInstanceOf(Date);
  });
});

// =============================================================
// Batch isolation
// =============================================================

describe("deliverWebhooks — batch isolation", () => {
  test("one failure does not block other deliveries", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("network down");
      return { ok: true, status: 200, text: async () => "OK" };
    });

    prismaMock.$queryRaw.mockResolvedValue([
      webhook({ id: "ow_fail" }),
      webhook({ id: "ow_ok", url: "https://example.com/hook2" }),
    ]);

    await deliverWebhooks(fetchMock);

    expect(prismaMock.outgoingWebhook.update).toHaveBeenCalledTimes(2);
    const calls = prismaMock.outgoingWebhook.update.mock.calls.map(
      (c: any) => ({ id: c[0].where.id, status: c[0].data.status }),
    );
    expect(calls).toContainEqual({ id: "ow_fail", status: "FAILED" });
    expect(calls).toContainEqual({ id: "ow_ok", status: "SENT" });
  });
});
