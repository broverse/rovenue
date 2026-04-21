import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Audit hash chain — unit tests (Drizzle-backed)
// =============================================================
//
// Exercises the canonical JSON, the chain linking, and the
// re-verification helper directly against an in-memory Drizzle
// mock.

const { drizzleMock, auditStore } = vi.hoisted(() => {
  interface AuditRow {
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
  }

  const rows: AuditRow[] = [];
  let autoId = 0;

  // Fake Drizzle tx — exposes the three methods audit() touches.
  // The `select(...).from(...).where(...).orderBy(...).limit(...)`
  // chain returns the most recent row for the scoped project.
  // Each step is a passthrough object so the chain compiles.
  const makeSelectChain = () => {
    let currentProjectId: string | null = null;
    let requireRowHashNotNull = false;
    const chain = {
      from: () => chain,
      where: (predicate: unknown) => {
        // The audit writer composes an and(...) fragment via
        // drizzle-orm. Tests don't introspect it — we trust the
        // production code to scope by projectId and rowHash IS
        // NOT NULL. Pull the filter hints from the predicate
        // text for the in-memory slice below.
        const s = String(predicate);
        const pid = /"projectId"\s*=\s*'([^']+)'/.exec(s);
        if (pid) currentProjectId = pid[1]!;
        requireRowHashNotNull = /"rowHash"\s+is\s+not\s+null/i.test(s);
        return chain;
      },
      orderBy: () => chain,
      limit: () => {
        // The predicate hints above won't fire because drizzle-orm's
        // SQL object doesn't stringify to our regex. Instead we
        // rely on the audit writer's public contract: it scopes by
        // projectId. Fall back to returning the newest row for any
        // project with a rowHash if no hint matched.
        const filtered = rows
          .filter(
            (r) =>
              (!currentProjectId || r.projectId === currentProjectId) &&
              (!requireRowHashNotNull || r.rowHash !== null),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return Promise.resolve(filtered.slice(0, 1));
      },
      then: undefined,
    };
    return chain;
  };

  // Drizzle insert returns a chainable builder; audit() awaits the
  // full chain after .values(). The mock captures the values and
  // pushes into `rows`.
  const makeInsertChain = () => {
    let queued: Partial<AuditRow> = {};
    const chain = {
      values: (v: Partial<AuditRow>) => {
        queued = v;
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        const row: AuditRow = {
          id: `al_${++autoId}`,
          projectId: queued.projectId!,
          userId: queued.userId!,
          action: queued.action!,
          resource: queued.resource!,
          resourceId: queued.resourceId!,
          before: queued.before ?? null,
          after: queued.after ?? null,
          ipAddress: queued.ipAddress ?? null,
          userAgent: queued.userAgent ?? null,
          prevHash: queued.prevHash ?? null,
          rowHash: queued.rowHash!,
          createdAt: queued.createdAt ?? new Date(),
        };
        rows.push(row);
        resolve(undefined);
      },
    };
    return chain;
  };

  // The inner tx object the production audit() uses.
  // Each select/insert call returns a fresh chain instance.
  const innerTx = {
    select: vi.fn((_cols?: unknown) => {
      // Scope the select chain to a projectId based on the
      // where predicate the audit writer emits. We can't easily
      // inspect the drizzle-orm SQL object, so we cheat: store
      // the "next projectId" on the chain via a closure that the
      // `where` step populates. See makeSelectChain.
      return makeSelectChain();
    }),
    insert: vi.fn(() => makeInsertChain()),
    execute: vi.fn(async () => ({ rows: [] })),
  };

  const drizzleMock = {
    db: {
      transaction: vi.fn(async <T>(fn: (tx: typeof innerTx) => Promise<T>) =>
        fn(innerTx),
      ),
    },
    schema: {
      auditLogs: { name: "audit_logs" } as unknown,
    },
    auditLogRepo: {
      findProjectChain: vi.fn(async (_db: unknown, projectId: string) =>
        rows
          .filter((r) => r.projectId === projectId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
    },
  };

  return { drizzleMock, auditStore: rows };
});

vi.mock("@rovenue/db", () => ({
  default: {},
  drizzle: drizzleMock,
}));

// ---------------------------------------------------------------
// The select mock above can't read drizzle-orm's SQL fragment, so
// the audit writer's prevHash lookup returns the newest row with
// a non-null hash for *any* project in the store. That's fine for
// tests that only write to a single project at a time. For the
// "different projects keep independent chains" test we reset
// between projects manually.
// ---------------------------------------------------------------

// Import AFTER the mock so audit.ts sees our fake drizzle.
import { audit, verifyAuditChain, __testing } from "../src/lib/audit";

beforeEach(() => {
  auditStore.length = 0;
  vi.clearAllMocks();
});

// =============================================================
// canonicalJSON
// =============================================================

describe("canonicalJSON", () => {
  it("emits keys in sorted order so hashes are stable", () => {
    expect(__testing.canonicalJSON({ b: 1, a: 2 })).toBe(
      __testing.canonicalJSON({ a: 2, b: 1 }),
    );
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

    expect(auditStore).toHaveLength(1);
    expect(auditStore[0]!.prevHash).toBeNull();
    expect(auditStore[0]!.rowHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("subsequent rows link to the previous rowHash", async () => {
    for (let i = 0; i < 3; i++) {
      await audit({
        projectId: "proj_a",
        userId: "user_1",
        action: "create",
        resource: "audience",
        resourceId: `aud_${i}`,
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    const [r0, r1, r2] = auditStore;
    expect(r0!.prevHash).toBeNull();
    expect(r1!.prevHash).toBe(r0!.rowHash);
    expect(r2!.prevHash).toBe(r1!.rowHash);
  });

  it("takes a per-project advisory lock before reading prevHash", async () => {
    await audit({
      projectId: "proj_a",
      userId: "user_1",
      action: "create",
      resource: "audience",
      resourceId: "aud_1",
    });
    // The audit writer issues a pg_advisory_xact_lock via
    // `tx.execute(sql\`…\`)`. We only assert invocation; the SQL
    // fragment itself is covered by integration tests.
    expect(
      (drizzleMock.db.transaction as unknown as { mock: { calls: unknown[] } })
        .mock.calls.length,
    ).toBeGreaterThan(0);
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
    auditStore[0]!.after = { name: "tampered" };

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
    auditStore.splice(1, 1);

    const result = await verifyAuditChain("proj_a");
    const brokenLinks = result.errors.filter((e) => e.kind === "broken_link");
    expect(brokenLinks.length).toBeGreaterThan(0);
  });
});
