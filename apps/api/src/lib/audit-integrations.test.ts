import { describe, expect, it } from "vitest";
import type { AuditAction, AuditResource } from "./audit";

describe("audit unions — integrations", () => {
  it("AuditAction includes the five integration actions", () => {
    const ok: AuditAction[] = [
      "integration.connection.created",
      "integration.connection.updated",
      "integration.connection.deleted",
      "integration.credentials.rotated",
      "integration.delivery.dead_letter",
    ];
    expect(ok.length).toBe(5);
  });
  it("AuditResource includes integration_connection", () => {
    const r: AuditResource = "integration_connection";
    expect(r).toBe("integration_connection");
  });
});
