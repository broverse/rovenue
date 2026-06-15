import { beforeEach, describe, expect, test, vi } from "vitest";
const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn((obj: Record<string, unknown> | null | undefined) => {
    if (!obj) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = "[REDACTED]";
    return out;
  }),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "",
    rowCount: 0,
    firstVerifiedAt: null,
    lastVerifiedAt: null,
    errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

const anonymizeMock = vi.hoisted(() => ({
  anonymizeSubscriber: vi.fn(async () => ({
    anonymousId: "anon_abcdef1234567890abcdef12",
    deletedAt: new Date("2026-04-21T10:00:00.000Z"),
  })),
}));
vi.mock("../src/services/gdpr/anonymize-subscriber", () => anonymizeMock);

const exportMock = vi.hoisted(() => ({
  exportSubscriber: vi.fn(async () => ({
    subscriber: { id: "sub_1" },
    purchases: [],
    access: [],
    creditLedger: [],
    exportedAt: "2026-04-21T10:00:00.000Z",
  })),
}));
vi.mock("../src/services/gdpr/export-subscriber", () => exportMock);

const creditHistoryMock = vi.hoisted(() => ({
  listCreditHistory: vi.fn(async () => ({
    entries: [],
    nextCursor: null as null | { createdAt: string; id: string },
  })),
}));
vi.mock("../src/services/credit-history", () => creditHistoryMock);

const { dbMock, drizzleMock, authMock } = vi.hoisted(() => {
  const dbMock = {
    projectMember: { findUnique: vi.fn() },
    subscriber: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      count: vi.fn(async () => 0),
    },
    purchase: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
    subscriberAccess: { findMany: vi.fn(async () => []) },
    creditLedger: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
    experimentAssignment: { findMany: vi.fn(async () => []) },
    outgoingWebhook: { findMany: vi.fn(async () => []) },
  };
  // Shadow reader: yields the primary caller, ignores the shadow.
  const drizzleMock = {
    db: {} as unknown,
    subscriberRepo: {
      findSubscriberAttributes: vi.fn(async () => null),
      findSubscriberByAppUserId: vi.fn(async () => null),
      findSubscriberById: vi.fn(async (_db: unknown, id: string) =>
        dbMock.subscriber.findUnique({ where: { id } }),
      ),
      listSubscribers: vi.fn(async () => []),
      countActiveSubscribers: vi.fn(async () => 0),
    },
    projectRepo: {
      findMembership: vi.fn(async (_db: unknown, projectId: string, userId: string) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    subscriberDetailRepo: {
      // Plan 3 §B.1: ledger/latestBalance moved to ClickHouse; PG path
      // returns access + purchases + assignments + outgoingWebhooks.
      loadSubscriberDetail: vi.fn(async (_db: unknown, subscriberId: string) => {
        const [purchasesRaw, access, assignmentsRaw, outgoingWebhooks] =
          await Promise.all([
            dbMock.purchase.findMany({
              where: { subscriberId },
              orderBy: { purchaseDate: "desc" },
              take: 50,
              include: { product: { select: { identifier: true } } },
            }),
            dbMock.subscriberAccess.findMany({
              where: { subscriberId },
              orderBy: { accessId: "asc" },
            }),
            dbMock.experimentAssignment.findMany({
              where: { subscriberId },
              orderBy: { assignedAt: "desc" },
              include: { experiment: { select: { key: true } } },
            }),
            dbMock.outgoingWebhook.findMany({
              where: { subscriberId },
              orderBy: { createdAt: "desc" },
              take: 20,
            }),
          ]);
        const purchases = (Array.isArray(purchasesRaw) ? purchasesRaw : []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => ({ ...p, productIdentifier: p.product?.identifier }),
        );
        const assignments = (
          Array.isArray(assignmentsRaw) ? assignmentsRaw : []
        ).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (a: any) => ({ ...a, experimentKey: a.experiment?.key }),
        );
        return {
          access: Array.isArray(access) ? access : [],
          purchases,
          assignments,
          outgoingWebhooks: Array.isArray(outgoingWebhooks)
            ? outgoingWebhooks
            : [],
        };
      }),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { dbMock, drizzleMock, authMock };
});

// Spread the real module so enum value-objects, zod validators
// (e.g. accessIdSchema), and the real `drizzle.schema` table objects
// stay available for sibling dashboard routes that load at module
// scope — overriding only the runtime `drizzle` repos + default `db`
// the subscribers handlers actually call. (Importing @rovenue/db is
// side-effect-free: the pool is created lazily via getPool().)
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    default: dbMock,
    drizzle: { ...actual.drizzle, ...drizzleMock },
  };
});
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "user_1") {
  authMock.api.getSession.mockResolvedValue({ user: { id: userId, email: "u@x" } });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /dashboard/projects/:projectId/subscribers", () => {
  test("forbidden when the user is not a project member", async () => {
    signedIn("outsider");
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers");
    expect(res.status).toBe(403);
  });

  test("returns a page + nextCursor when more rows exist", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });

    // take: limit + 1 = 51 rows to prove the "has more" probe.
    // The Drizzle list repo returns `purchaseCount` and
    // `activeEntitlementKeys` flattened — no _count / access
    // nesting needed post-cutover.
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `sub_${i}`,
      appUserId: `user_${i}`,
      attributes: {},
      firstSeenAt: new Date("2026-04-10"),
      lastSeenAt: new Date("2026-04-18"),
      createdAt: new Date(`2026-04-${10 + (i % 8)}T12:00:00Z`),
      purchaseCount: 0,
      activeEntitlementKeys: [],
    }));
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue(rows);

    const res = await app.request("/dashboard/projects/proj_1/subscribers?limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { subscribers: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(body.data.subscribers).toHaveLength(50);
    expect(body.data.nextCursor).not.toBeNull();
  });

  test("passes projectId to the list repository (soft-delete filter is internal)", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers");
    const call = drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as {
      projectId: string;
    };
    expect(call.projectId).toBe("proj_1");
  });

  test("forwards ?q to the list repository for case-insensitive search", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers?q=alice");
    const call = drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as {
      q?: string;
    };
    expect(call.q).toBe("alice");
  });

  test("forwards structured filter params to the list repository", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    await app.request(
      "/dashboard/projects/proj_1/subscribers?status=trial&access=premium&platform=ios,android&country=tr&ltvMin=25",
    );
    const call = drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as {
      status?: string;
      accessId?: string;
      platforms?: ReadonlyArray<string>;
      country?: string;
      ltvMin?: number;
    };
    expect(call.status).toBe("trial");
    expect(call.accessId).toBe("premium");
    expect(call.platforms).toEqual(["ios", "android"]);
    // Country casing is normalised inside the repo (UPPER on both
    // sides); the route preserves whatever the URL carried.
    expect(call.country).toBe("tr");
    expect(call.ltvMin).toBe(25);
  });

  test("rejects unknown status values with 400", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    const res = await app.request(
      "/dashboard/projects/proj_1/subscribers?status=bogus",
    );
    expect(res.status).toBe(400);
    expect(drizzleMock.subscriberRepo.listSubscribers).not.toHaveBeenCalled();
  });

  test("widens YYYY-MM-DD date bounds to whole-day [from, to] window", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    await app.request(
      "/dashboard/projects/proj_1/subscribers?from=2026-04-01&to=2026-04-28",
    );
    const call = drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as {
      lastSeenFrom?: Date;
      lastSeenTo?: Date;
    };
    expect(call.lastSeenFrom?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(call.lastSeenTo?.toISOString()).toBe("2026-04-28T23:59:59.999Z");
  });

  test("defaults to `last_activity` sort and forwards ?sort overrides", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers");
    expect(
      (drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as { sort?: string }).sort,
    ).toBe("last_activity");

    drizzleMock.subscriberRepo.listSubscribers.mockClear();
    await app.request("/dashboard/projects/proj_1/subscribers?sort=ltv");
    expect(
      (drizzleMock.subscriberRepo.listSubscribers.mock.calls[0]?.[1] as { sort?: string }).sort,
    ).toBe("ltv");
  });

  test("rejects unknown sort values with 400", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    const res = await app.request(
      "/dashboard/projects/proj_1/subscribers?sort=bogus",
    );
    expect(res.status).toBe(400);
    expect(drizzleMock.subscriberRepo.listSubscribers).not.toHaveBeenCalled();
  });

  test("rejects inverted date ranges with 400", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([]);

    const res = await app.request(
      "/dashboard/projects/proj_1/subscribers?from=2026-05-01&to=2026-04-01",
    );
    expect(res.status).toBe(400);
    expect(drizzleMock.subscriberRepo.listSubscribers).not.toHaveBeenCalled();
  });
});

describe("GET /dashboard/projects/:projectId/subscribers/:id", () => {
  test("forbidden when not a member", async () => {
    signedIn("outsider");
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_1");
    expect(res.status).toBe(403);
  });

  test("returns 404 when subscriber isn't in project", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    dbMock.subscriber.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_missing");
    expect(res.status).toBe(404);
  });

  test("assembles subscriber + purchases + access + ledger + assignments + webhooks", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_1",
      appUserId: "user_abc",
      attributes: { country: "TR" },
      firstSeenAt: new Date("2026-04-01"),
      lastSeenAt: new Date("2026-04-18"),
      deletedAt: null,
      mergedInto: null,
    });
    dbMock.purchase.findMany.mockResolvedValue([
      {
        id: "pur_1",
        productId: "prod_1",
        product: { identifier: "pro_monthly" },
        store: "APP_STORE",
        status: "ACTIVE",
        priceAmount: "9.99",
        priceCurrency: "USD",
        purchaseDate: new Date("2026-04-10"),
        expiresDate: new Date("2026-05-10"),
        autoRenewStatus: true,
      },
    ]);
    dbMock.subscriberAccess.findMany.mockResolvedValue([
      { accessId: "premium", isActive: true, expiresDate: null, store: "APP_STORE", purchaseId: "pur_1" },
    ]);
    // Plan 3 §B.1: credit history + latest balance now come from
    // ClickHouse. The CH preview's first row supplies `creditBalance`.
    creditHistoryMock.listCreditHistory.mockResolvedValueOnce({
      entries: [
        {
          id: "led_1",
          type: "PURCHASE",
          amount: "100",
          balance: "42",
          referenceType: "purchase",
          description: null,
          createdAt: "2026-04-12T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    dbMock.experimentAssignment.findMany.mockResolvedValue([
      {
        experimentId: "exp_1",
        variantId: "v_a",
        assignedAt: new Date("2026-04-12"),
        convertedAt: null,
        revenue: null,
        experiment: { key: "paywall_test" },
      },
    ]);
    dbMock.outgoingWebhook.findMany.mockResolvedValue([
      {
        id: "ow_1",
        eventType: "purchase",
        url: "https://example.com/hook",
        status: "SENT",
        attempts: 1,
        createdAt: new Date("2026-04-12"),
        sentAt: new Date("2026-04-12"),
        lastErrorMessage: null,
      },
    ]);

    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subscriber: Record<string, unknown> } };
    const s = body.data.subscriber as Record<string, unknown>;
    expect(s.appUserId).toBe("user_abc");
    expect(Array.isArray(s.purchases)).toBe(true);
    expect(Array.isArray(s.access)).toBe(true);
    expect(s.creditBalance).toBe("42");
    expect(Array.isArray(s.assignments)).toBe(true);
    expect(Array.isArray(s.outgoingWebhooks)).toBe(true);
  });

  test("list returns flat attributes; detail returns nested", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });

    const nestedAttributes = {
      country: {
        value: "US",
        updatedAt: "2026-06-15T10:00:00.000Z",
        source: "sdk",
      },
    };

    // LIST: the list repo yields the raw nested jsonb; the route flattens it.
    drizzleMock.subscriberRepo.listSubscribers.mockResolvedValue([
      {
        id: "sub_attrs",
        appUserId: "user_attrs",
        attributes: nestedAttributes,
        firstSeenAt: new Date("2026-04-10"),
        lastSeenAt: new Date("2026-04-18"),
        createdAt: new Date("2026-04-10T12:00:00Z"),
        purchaseCount: 0,
        activeEntitlementKeys: [],
      },
    ]);

    const listRes = await app.request(
      "/dashboard/projects/proj_1/subscribers",
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: {
        subscribers: Array<{ id: string; attributes: Record<string, unknown> }>;
      };
    };
    const row = listBody.data.subscribers.find((sub) => sub.id === "sub_attrs")!;
    expect(row.attributes).toEqual({ country: "US" });

    // DETAIL: the route normalizes the raw nested jsonb back to the typed shape.
    dbMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_attrs",
      projectId: "proj_1",
      appUserId: "user_attrs",
      attributes: nestedAttributes,
      firstSeenAt: new Date("2026-04-01"),
      lastSeenAt: new Date("2026-04-18"),
      deletedAt: null,
      mergedInto: null,
    });

    const detailRes = await app.request(
      "/dashboard/projects/proj_1/subscribers/sub_attrs",
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      data: {
        subscriber: {
          attributes: Record<
            string,
            { value: string; source: string; updatedAt: string }
          >;
        };
      };
    };
    const attrs = detailBody.data.subscriber.attributes;
    expect(attrs.country).toMatchObject({ value: "US", source: "sdk" });
    expect(typeof attrs.country.updatedAt).toBe("string");
  });
});

describe("POST /dashboard/projects/:projectId/subscribers/:id/anonymize", () => {
  test("POST /:id/anonymize with ADMIN returns anonymousId", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "user_admin" },
    });
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "m1",
      role: "ADMIN",
    });

    const res = await app.request(
      "/dashboard/projects/proj_1/subscribers/sub_1/anonymize",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "rovenue.session=test",
        },
        body: JSON.stringify({ reason: "gdpr_request" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { anonymousId: string; deletedAt: string };
    };
    expect(body.data.anonymousId).toBe("anon_abcdef1234567890abcdef12");
    expect(anonymizeMock.anonymizeSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: "sub_1",
        projectId: "proj_1",
        actorUserId: "user_admin",
        reason: "gdpr_request",
      }),
    );
  });

  test("POST /:id/anonymize as VIEWER is 403", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "user_viewer" },
    });
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "m2",
      role: "VIEWER",
    });

    const res = await app.request(
      "/dashboard/projects/proj_1/subscribers/sub_1/anonymize",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "rovenue.session=test",
        },
        body: "{}",
      },
    );
    expect(res.status).toBe(403);
    expect(anonymizeMock.anonymizeSubscriber).not.toHaveBeenCalled();
  });

  test("GET /:id/export returns export blob + content-disposition", async () => {
    authMock.api.getSession.mockResolvedValue({ user: { id: "user_admin" } });
    dbMock.projectMember.findUnique.mockResolvedValue({
      id: "m1",
      role: "ADMIN",
    });

    const res = await app.request(
      "/dashboard/projects/proj_1/subscribers/sub_1/export",
      { headers: { cookie: "rovenue.session=test" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      'filename="subscriber-sub_1.json"',
    );
    const body = (await res.json()) as {
      data: { subscriber: { id: string } };
    };
    expect(body.data.subscriber.id).toBe("sub_1");
    expect(exportMock.exportSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: "sub_1",
        projectId: "proj_1",
        actorUserId: "user_admin",
      }),
    );
  });
});
