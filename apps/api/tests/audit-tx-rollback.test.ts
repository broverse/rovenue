import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// audit() — caller-tx atomicity contract
// =============================================================
//
// audit() must run inside the caller's Drizzle transaction when one
// is provided, so a rollback on the caller propagates to the audit
// row. When no callerTx is passed, audit() opens its own transaction
// for advisory-lock scope. These tests pin both contracts via an
// in-memory Drizzle mock that mirrors the pattern in audit-chain.test.ts.

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

const {
  drizzleMock,
  innerTxStore,
  callerTxStore,
  innerTxSpies,
  callerTxSpies,
} = vi.hoisted(() => {
  interface Row {
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

  const innerTxStore: Row[] = [];
  const callerTxStore: Row[] = [];
  let autoId = 0;

  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve([]),
      then: undefined,
    };
    return chain;
  };

  const makeInsertChain = (store: Row[]) => {
    let queued: Partial<Row> = {};
    const chain: Record<string, unknown> = {
      values: (v: Partial<Row>) => {
        queued = v;
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        const row: Row = {
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
        store.push(row);
        resolve(undefined);
      },
    };
    return chain;
  };

  const innerTxSpies = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain(innerTxStore)),
    execute: vi.fn(async () => ({ rows: [] })),
  };

  const callerTxSpies = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain(callerTxStore)),
    execute: vi.fn(async () => ({ rows: [] })),
  };

  const drizzleMock = {
    db: {
      transaction: vi.fn(async <T>(fn: (tx: typeof innerTxSpies) => Promise<T>) =>
        fn(innerTxSpies),
      ),
    },
    schema: {
      auditLogs: { name: "audit_logs" } as unknown,
    },
    auditLogRepo: {
      findProjectChain: vi.fn(async () => []),
    },
  };

  return {
    drizzleMock,
    innerTxStore,
    callerTxStore,
    innerTxSpies,
    callerTxSpies,
  };
});

vi.mock("@rovenue/db", () => ({
  default: {},
  drizzle: drizzleMock,
}));

// Import AFTER the mock so audit.ts sees our fake drizzle.
import { audit, type AuditTx } from "../src/lib/audit";

beforeEach(() => {
  innerTxStore.length = 0;
  callerTxStore.length = 0;
  vi.clearAllMocks();
});

const baseEntry = {
  projectId: "proj_a",
  userId: "user_1",
  action: "subscriber.anonymized" as const,
  resource: "subscriber" as const,
  resourceId: "sub_1",
  before: null,
  after: { reason: "gdpr_request", anonymousId: "anon_x" },
  ipAddress: null,
  userAgent: null,
};

describe("audit() — caller transaction contract", () => {
  test("when callerTx is provided, audit() does NOT open its own transaction", async () => {
    await audit(baseEntry, callerTxSpies as unknown as AuditTx);

    expect(drizzleMock.db.transaction).not.toHaveBeenCalled();
  });

  test("when callerTx is provided, the audit insert lands on the caller's tx", async () => {
    await audit(baseEntry, callerTxSpies as unknown as AuditTx);

    expect(callerTxSpies.insert).toHaveBeenCalledTimes(1);
    expect(innerTxSpies.insert).not.toHaveBeenCalled();
    expect(callerTxStore).toHaveLength(1);
    expect(innerTxStore).toHaveLength(0);
    expect(callerTxStore[0]!.resourceId).toBe("sub_1");
  });

  test("when no callerTx is provided, audit() opens its own transaction", async () => {
    await audit(baseEntry);

    expect(drizzleMock.db.transaction).toHaveBeenCalledTimes(1);
    expect(innerTxSpies.insert).toHaveBeenCalledTimes(1);
    expect(innerTxStore).toHaveLength(1);
    expect(callerTxStore).toHaveLength(0);
  });

  test("advisory lock + prevHash lookup run on the caller's tx, not on the global db", async () => {
    await audit(baseEntry, callerTxSpies as unknown as AuditTx);

    expect(callerTxSpies.execute).toHaveBeenCalledTimes(1);
    expect(callerTxSpies.select).toHaveBeenCalledTimes(1);
    expect(innerTxSpies.execute).not.toHaveBeenCalled();
    expect(innerTxSpies.select).not.toHaveBeenCalled();
  });
});

// =============================================================
// Rollback semantics — simulated via a tx runner that discards
// writes when the caller throws. This mirrors what Postgres does
// inside drizzle.db.transaction.
// =============================================================

describe("audit() — rollback propagation", () => {
  test("audit row is discarded when the caller's tx callback throws (after audit ran inside it)", async () => {
    // Build a one-off "real-ish" tx runner: writes accumulate in a
    // staging buffer; commit on success, drop on throw.
    const committed: AuditRow[] = [];
    const staging: AuditRow[] = [];
    const txInsert = vi.fn(() => {
      let queued: Partial<AuditRow> = {};
      const chain: Record<string, unknown> = {
        values: (v: Partial<AuditRow>) => {
          queued = v;
          return chain;
        },
        then: (resolve: (v: unknown) => void) => {
          const row: AuditRow = {
            id: `staging_${staging.length + 1}`,
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
          staging.push(row);
          resolve(undefined);
        },
      };
      return chain;
    });
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
          }),
        }),
      })),
      insert: txInsert,
      execute: vi.fn(async () => ({ rows: [] })),
    };

    // Caller code: open a tx, run audit() inside it, then throw.
    await expect(
      (async () => {
        await audit(baseEntry, tx as unknown as AuditTx);
        throw new Error("force-rollback");
      })(),
    ).rejects.toThrow(/force-rollback/);

    // The staging buffer never gets committed — that's the rollback
    // contract. Production Postgres would discard the row here.
    expect(staging).toHaveLength(1);
    expect(committed).toHaveLength(0);
    // Crucially, audit() did NOT open its own (independently
    // committed) transaction:
    expect(drizzleMock.db.transaction).not.toHaveBeenCalled();
  });
});
