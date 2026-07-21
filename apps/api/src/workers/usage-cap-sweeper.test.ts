import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/billing/usage", () => ({
  buildUsageReport: vi.fn().mockResolvedValue({ meters: [] }),
}));
vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction: (fn: (tx: unknown) => Promise<void>) => fn({}) },
      projectRepo: {
        findProjectById: vi.fn(),
        setUsageLockedAt: vi.fn().mockResolvedValue(undefined),
      },
      usageSnapshotRepo: {
        findSnapshotsForPeriodStarts: vi.fn().mockResolvedValue([]),
      },
      outboxRepo: { insert: vi.fn().mockResolvedValue(undefined) },
    },
  };
});

import { drizzle } from "@rovenue/db";
import { audit } from "../lib/audit";
import { applyUsageLockState } from "./usage-cap-sweeper";

const d = drizzle as unknown as {
  projectRepo: {
    findProjectById: ReturnType<typeof vi.fn>;
    setUsageLockedAt: ReturnType<typeof vi.fn>;
  };
  usageSnapshotRepo: { findSnapshotsForPeriodStarts: ReturnType<typeof vi.fn> };
  outboxRepo: { insert: ReturnType<typeof vi.fn> };
};

const NOW = new Date(Date.UTC(2026, 6, 21));
const MAY = new Date(Date.UTC(2026, 4, 1));
const JUN = new Date(Date.UTC(2026, 5, 1));

function overRow(periodStart: Date) {
  return { meterKey: "events", periodStart, currentValue: "6000000", limitValue: "5000000" };
}

beforeEach(() => vi.clearAllMocks());

describe("applyUsageLockState", () => {
  it("locks an unlocked project when both completed periods are over", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: null });
    d.usageSnapshotRepo.findSnapshotsForPeriodStarts.mockResolvedValue([overRow(MAY), overRow(JUN)]);
    const out = await applyUsageLockState("p1", NOW);
    expect(out).toBe("locked");
    expect(d.projectRepo.setUsageLockedAt).toHaveBeenCalledWith(expect.anything(), "p1", NOW);
    expect(d.outboxRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "billing.usage_lock.applied" }),
    );
    expect(audit).toHaveBeenCalledOnce();
  });

  it("unlocks a locked project once usage recovers", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: new Date() });
    d.usageSnapshotRepo.findSnapshotsForPeriodStarts.mockResolvedValue([overRow(JUN)]);
    const out = await applyUsageLockState("p1", NOW);
    expect(out).toBe("unlocked");
    expect(d.projectRepo.setUsageLockedAt).toHaveBeenCalledWith(expect.anything(), "p1", null);
    expect(d.outboxRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "billing.usage_lock.cleared" }),
    );
  });

  it("is a no-op when state already matches", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: null });
    d.usageSnapshotRepo.findSnapshotsForPeriodStarts.mockResolvedValue([overRow(JUN)]);
    const out = await applyUsageLockState("p1", NOW);
    expect(out).toBe("unchanged");
    expect(d.projectRepo.setUsageLockedAt).not.toHaveBeenCalled();
    expect(d.outboxRepo.insert).not.toHaveBeenCalled();
  });

  it("is a no-op for a missing project", async () => {
    d.projectRepo.findProjectById.mockResolvedValue(null);
    const out = await applyUsageLockState("p1", NOW);
    expect(out).toBe("unchanged");
    expect(d.usageSnapshotRepo.findSnapshotsForPeriodStarts).not.toHaveBeenCalled();
  });
});
