import { describe, expect, it, vi, beforeEach } from "vitest";
import { recordDeadLetterAudit, emitDeadLetterNotification } from "./integrations-deliver";

describe("recordDeadLetterAudit — 1-minute dedup window", () => {
  let auditCalls: Array<{ at: number; connectionId: string }>;
  let lastWriteAt: Map<string, number>;
  beforeEach(() => { auditCalls = []; lastWriteAt = new Map(); });

  const audit = (id: string, now: number) =>
    recordDeadLetterAudit({
      connectionId: id, projectId: "p1", errorMessage: "401",
      now: () => now,
      lastWriteAt,
      writeAuditRow: async (m) => { auditCalls.push({ at: m.now, connectionId: m.connectionId }); },
    });

  it("emits the first dead-letter audit immediately", async () => {
    await audit("c1", 1_000);
    expect(auditCalls).toHaveLength(1);
  });

  it("suppresses a second dead-letter within 60s on the same connection", async () => {
    await audit("c1", 1_000);
    await audit("c1", 1_000 + 59_000);
    expect(auditCalls).toHaveLength(1);
  });

  it("emits again after the 60s window passes", async () => {
    await audit("c1", 1_000);
    await audit("c1", 1_000 + 60_001);
    expect(auditCalls).toHaveLength(2);
  });

  it("does NOT suppress across different connections", async () => {
    await audit("c1", 1_000);
    await audit("c2", 1_000);
    expect(auditCalls).toHaveLength(2);
  });
});

describe("emitDeadLetterNotification", () => {
  const fixedNow = () => new Date("2026-08-24T12:00:00.000Z");

  it("emits with a per-connection per-day eventId and looked-up names", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const captureError = vi.fn();
    const lookupProjectAndConnection = vi.fn().mockResolvedValue({
      projectName: "Acme",
      displayName: "Meta Ads",
    });

    await emitDeadLetterNotification(
      { connectionId: "c1", projectId: "p1", providerId: "META_CAPI", errorMessage: "401" },
      { now: fixedNow, lookupProjectAndConnection, emit, captureError },
    );

    expect(lookupProjectAndConnection).toHaveBeenCalledWith({ projectId: "p1", connectionId: "c1" });
    expect(emit).toHaveBeenCalledWith({
      eventId: "dead_letter:c1:2026-08-24",
      projectId: "p1",
      context: {
        projectId: "p1",
        projectName: "Acme",
        connectionId: "c1",
        providerId: "META_CAPI",
        displayName: "Meta Ads",
        errorMessage: "401",
      },
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("falls back to raw ids when the project/connection lookup misses", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const captureError = vi.fn();
    const lookupProjectAndConnection = vi.fn().mockResolvedValue(undefined);

    await emitDeadLetterNotification(
      { connectionId: "c1", projectId: "p1", providerId: "META_CAPI", errorMessage: null },
      { now: fixedNow, lookupProjectAndConnection, emit, captureError },
    );

    expect(emit).toHaveBeenCalledWith({
      eventId: "dead_letter:c1:2026-08-24",
      projectId: "p1",
      context: {
        projectId: "p1",
        projectName: "p1",
        connectionId: "c1",
        providerId: "META_CAPI",
        displayName: "c1",
        errorMessage: null,
      },
    });
  });

  it("is best-effort: a lookup failure is captured, never thrown", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const captureError = vi.fn();
    const lookupProjectAndConnection = vi.fn().mockRejectedValue(new Error("db down"));

    await expect(
      emitDeadLetterNotification(
        { connectionId: "c1", projectId: "p1", providerId: "META_CAPI", errorMessage: "401" },
        { now: fixedNow, lookupProjectAndConnection, emit, captureError },
      ),
    ).resolves.toBeUndefined();

    expect(emit).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      { projectId: "p1", connectionId: "c1" },
    );
  });

  it("is best-effort: an emit failure is captured, never thrown", async () => {
    const emit = vi.fn().mockRejectedValue(new Error("outbox insert failed"));
    const captureError = vi.fn();
    const lookupProjectAndConnection = vi.fn().mockResolvedValue({
      projectName: "Acme",
      displayName: "Meta Ads",
    });

    await expect(
      emitDeadLetterNotification(
        { connectionId: "c1", projectId: "p1", providerId: "META_CAPI", errorMessage: "401" },
        { now: fixedNow, lookupProjectAndConnection, emit, captureError },
      ),
    ).resolves.toBeUndefined();

    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      { projectId: "p1", connectionId: "c1" },
    );
  });
});
