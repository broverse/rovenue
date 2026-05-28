import { describe, expect, it, beforeEach } from "vitest";
import { recordDeadLetterAudit } from "./integrations-deliver";

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
