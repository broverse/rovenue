import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Custom domain attach — losing the concurrent hostname claim
// =============================================================
//
// Hostnames are globally unique, so attach pre-checks for a collision
// and then relies on the DB to settle the case where two requests both
// passed the pre-check. That catch guarded on `err.code === "23505"`
// read off the caught error, which drizzle never puts there — the
// driver error hangs off `.cause`. So the loser of a genuine race got a
// 500 rather than the 409 the route was written to give it.
//
// The fixtures therefore throw the nested shape. A flat `{ code }`
// would satisfy the broken check and prove nothing.

const findFunnelById = vi.hoisted(() => vi.fn());
const findByFunnel = vi.hoisted(() => vi.fn());
const findByHostname = vi.hoisted(() => vi.fn());
const insertDomain = vi.hoisted(() => vi.fn());
const assertProjectAccess = vi.hoisted(() => vi.fn());

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "user_1" });
    await next();
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
      funnelRepo: { ...actual.drizzle.funnelRepo, findById: findFunnelById },
      customDomainRepo: {
        ...actual.drizzle.customDomainRepo,
        findByFunnel,
        findByHostname,
        insert: insertDomain,
      },
    },
  };
});

vi.mock("../src/lib/project-access", () => ({ assertProjectAccess }));
vi.mock("../src/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: () => ({ ipAddress: null, userAgent: null }),
}));

const { customDomainsRoute } = await import("../src/routes/dashboard/custom-domains");
const { Hono } = await import("hono");

/**
 * A unique violation as the route actually receives it: drizzle's
 * wrapper on the outside, the driver error one level down `.cause`.
 */
function wrappedUniqueViolation(constraint: string): Error {
  const driver = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: "23505", constraint },
  );
  return Object.assign(
    new Error('Failed query: insert into "custom_domains" ...'),
    { cause: driver },
  );
}

function attach() {
  return new Hono()
    .route("/dashboard/projects/:projectId/custom-domains", customDomainsRoute)
    .request("http://localhost/dashboard/projects/proj_a/custom-domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ funnelId: "fnl_1", hostname: "buy.example.com" }),
    });
}

describe("custom domain attach — concurrent claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertProjectAccess.mockResolvedValue(undefined);
    findFunnelById.mockResolvedValue({ id: "fnl_1", projectId: "proj_a" });
    // Both pre-checks pass: this request is the one that raced.
    findByFunnel.mockResolvedValue(null);
    findByHostname.mockResolvedValue(null);
  });

  it("409s hostname_taken when another request claimed the hostname first", async () => {
    const wrapped = wrappedUniqueViolation("custom_domains_hostname_unique");
    // The exact reason the old check was dead code.
    expect((wrapped as { code?: string }).code).toBeUndefined();
    insertDomain.mockRejectedValue(wrapped);

    const res = await attach();

    expect(res.status).toBe(409);
    // The route is mounted bare here, without the app's JSON error
    // handler, so an HTTPException renders as its plain message.
    expect(await res.text()).toBe("hostname_taken");
  });

  it("409s funnel_already_has_domain when the funnel index is the one that blew", async () => {
    // Same SQLSTATE, different index, different answer — reporting a
    // taken hostname here would send the customer chasing a hostname
    // that was never the problem. Mirrors the pre-check above the try.
    insertDomain.mockRejectedValue(
      wrappedUniqueViolation("custom_domains_funnel_unique"),
    );

    const res = await attach();

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("funnel_already_has_domain");
  });

  it("rethrows a unique violation of an unrelated index", async () => {
    // Fails closed: an unrecognised constraint is not a hostname race,
    // so it must surface rather than be reported as a 409.
    insertDomain.mockRejectedValue(wrappedUniqueViolation("audit_logs_pkey"));

    const res = await attach();

    expect(res.status).toBe(500);
  });

  it("rethrows a non-unique-violation failure", async () => {
    insertDomain.mockRejectedValue(
      Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      }),
    );

    const res = await attach();

    expect(res.status).toBe(500);
  });

  it("201s when nothing races it", async () => {
    insertDomain.mockImplementation(async (_tx: unknown, values: object) => ({
      id: "cd_1",
      verifiedAt: null,
      createdAt: new Date(),
      ...values,
    }));

    const res = await attach();

    expect(res.status).toBe(201);
  });
});
