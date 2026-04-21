import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Audit hash chain — unit tests
// =============================================================
//
// Exercises the canonical JSON, the chain linking, and the
// re-verification helper directly against the prisma mock — no
// HTTP layer, no dashboard routes. Route-level coverage lives in
// audit-log.test.ts.

const { prismaMock } = vi.hoisted(() => {
  const rows: Array<{
    id: string;
    projectId: string;
    userId: string;
    action: string;
    resource: string;
    resourceId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ipAddress: string | null;
    userAgent: string | null;
    prevHash: string | null;
    rowHash: string;
    createdAt: Date;
  }> = [];
  let autoId = 0;

  const auditLog = {
    findFirst: vi.fn(async (args: any) => {
      if (!args?.where?.projectId) return null;
      const filtered = rows
        .filter(
          (r) => r.projectId === args.where.projectId && r.rowHash !== null,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return filtered[0] ?? null;
    }),
    findMany: vi.fn(async (args: any) => {
      const projectId = args?.where?.projectId;
      const out = projectId
        ? rows.filter((r) => r.projectId === projectId)
        : [...rows];
      return out.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
    }),
    create: vi.fn(async (args: any) => {
      const row = {
        id: `al_${++autoId}`,
        ...args.data,
        createdAt: args.data.createdAt ?? new Date(),
      };
      rows.push(row);
      return row;
    }),
  };

  const mock = {
    auditLog,
    $executeRaw: vi.fn(async () => 0),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (fn: any) => fn(mock)),
    __rows: rows,
    __reset: () => {
      rows.length = 0;
      autoId = 0;
    },
  };

  return { prismaMock: mock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  Prisma: {},
  // Drizzle auditLogRepo is wired to the same in-memory `rows`
  // store so verifyAuditChain walks the chain identically
  // whether the primary or the repo is asked.
  drizzle: {
    db: {} as unknown,
    auditLogRepo: {
      findProjectChain: vi.fn(async (_db: unknown, projectId: string) =>
        prismaMock.auditLog.findMany({ where: { projectId } }),
      ),
    },
  },
}));

// Import AFTER the mock so audit.ts sees our fake prisma.
import { audit, verifyAuditChain, __testing } from "../src/lib/audit";

beforeEach(() => {
  prismaMock.__reset();
  vi.clearAllMocks();
});

// =============================================================
// canonicalJSON
// =============================================================

describe("canonicalJSON", () => {
  it("emits keys in sorted order so hashes are stable", () => {
    expect(
      __testing.canonicalJSON({ b: 1, a: 2 }),
    ).toBe(__testing.canonicalJSON({ a: 2, b: 1 }));
  });

  it("distinguishes null from missing", () => {
    expect(__testing.canonicalJSON({ a: null })).not.toBe(
      __testing.canonicalJSON({}),
    );
  });

  it("recurses through nested objects and arrays", () => {
    const a = __testing.canonicalJSON({ x: { b: 1, a: 2 }, y: [3, 2, 1] });
    const b = __testing.canonicalJSON({ x: { a: 2, b: 1 }, y: [3, 2, 1] });
    expect(a).toBe(b);
  });
});

// =============================================================
// audit() chain writes
// =============================================================

describe("audit() — chained writes", () => {
  it("first row has prevHash = null and a rowHash", async () => {
    await audit({
      projectId: "proj_a",
      userId: "user_1",
      action: "create",
      resource: "audience",
      resourceId: "aud_1",
      after: { name: "TR iOS" },
    });

    expect(prismaMock.__rows).toHaveLength(1);
    expect(prismaMock.__rows[0]!.prevHash).toBeNull();
    expect(prismaMock.__rows[0]!.rowHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("subsequent rows link to the previous rowHash", async () => {
    for (let i = 0; i < 3; i++) {
      // Ensure distinct createdAt timestamps so `findFirst` ordering is
      // deterministic — same-millisecond inserts can otherwise tie.
      await audit({
        projectId: "proj_a",
        userId: "user_1",
        action: "create",
        resource: "audience",
        resourceId: `aud_${i}`,
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    const [r0, r1, r2] = prismaMock.__rows;
    expect(r0!.prevHash).toBeNull();
    expect(r1!.prevHash).toBe(r0!.rowHash);
    expect(r2!.prevHash).toBe(r1!.rowHash);
  });

  it("different projects keep independent chains", async () => {
    await audit({
      projectId: "proj_a",
      userId: "user_1",
      action: "create",
      resource: "audience",
      resourceId: "a1",
    });
    await new Promise((r) => setTimeout(r, 2));
    await audit({
      projectId: "proj_b",
      userId: "user_1",
      action: "create",
      resource: "audience",
      resourceId: "b1",
    });

    const a = prismaMock.__rows.find((r) => r.projectId === "proj_a");
    const b = prismaMock.__rows.find((r) => r.projectId === "proj_b");
    expect(a!.prevHash).toBeNull();
    expect(b!.prevHash).toBeNull();
    expect(a!.rowHash).not.toBe(b!.rowHash);
  });

  it("takes a per-project advisory lock before reading prevHash", async () => {
    await audit({
      projectId: "proj_a",
      userId: "user_1",
      action: "create",
      resource: "audience",
      resourceId: "aud_1",
    });
    // $executeRaw is called with the advisory lock SQL. With the
    // template-literal raw form, we only assert it was invoked.
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });
});

// =============================================================
// verifyAuditChain
// =============================================================

describe("verifyAuditChain", () => {
  it("reports no errors for a correctly chained project", async () => {
    for (let i = 0; i < 3; i++) {
      await audit({
        projectId: "proj_a",
        userId: "user_1",
        action: "update",
        resource: "audience",
        resourceId: `aud_${i}`,
        after: { step: i },
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    const result = await verifyAuditChain("proj_a");
    expect(result.rowCount).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("detects a tampered row via bad_hash", async () => {
    await audit({
      projectId: "proj_a",
      userId: "user_1",
      action: "create",
      resource: "audience",
      resourceId: "aud_1",
      after: { name: "original" },
    });
    // Simulate a compromised writer mutating `after` in-place. The
    // real DB trigger rejects UPDATE, but verifier must catch any
    // mutation that slips past (e.g. via direct SQL by a DBA).
    prismaMock.__rows[0]!.after = { name: "tampered" };

    const result = await verifyAuditChain("proj_a");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.kind).toBe("bad_hash");
  });

  it("detects a broken link when a middle row is removed", async () => {
    for (let i = 0; i < 3; i++) {
      await audit({
        projectId: "proj_a",
        userId: "user_1",
        action: "update",
        resource: "audience",
        resourceId: `aud_${i}`,
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    // Drop the middle row — the third row's prevHash now points at a
    // rowHash that no longer exists in the chain.
    prismaMock.__rows.splice(1, 1);

    const result = await verifyAuditChain("proj_a");
    const brokenLinks = result.errors.filter((e) => e.kind === "broken_link");
    expect(brokenLinks.length).toBeGreaterThan(0);
  });
});
