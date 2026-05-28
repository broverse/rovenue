import { describe, expect, it, vi } from "vitest";
import {
  auditIntegrationCreate,
  auditIntegrationUpdate,
  auditIntegrationDelete,
} from "./audit-helpers";

describe("audit helpers", () => {
  it("auditIntegrationCreate calls audit() with redacted creds", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    await auditIntegrationCreate({ audit } as never, {
      tx: {} as never,
      projectId: "p1",
      userId: "u1",
      resourceId: "c1",
      after: { credentialsCipher: "v1:secret", displayName: "Meta" },
    });
    const call = audit.mock.calls[0][0];
    expect(call.action).toBe("integration.connection.created");
    expect(call.resource).toBe("integration_connection");
    expect(call.after?.credentialsCipher).toBe("[REDACTED]");
    expect(call.after?.displayName).toBe("Meta");
  });
  it("auditIntegrationUpdate redacts before+after credentialsCipher", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    await auditIntegrationUpdate({ audit } as never, {
      tx: {} as never,
      projectId: "p1",
      userId: "u1",
      resourceId: "c1",
      before: { credentialsCipher: "v1:old", isEnabled: false },
      after: { credentialsCipher: "v1:new", isEnabled: true },
    });
    const call = audit.mock.calls[0][0];
    expect(call.before?.credentialsCipher).toBe("[REDACTED]");
    expect(call.after?.credentialsCipher).toBe("[REDACTED]");
    expect(call.after?.isEnabled).toBe(true);
  });
  it("auditIntegrationDelete fires correct action", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    await auditIntegrationDelete({ audit } as never, {
      tx: {} as never,
      projectId: "p1",
      userId: "u1",
      resourceId: "c1",
    });
    expect(audit.mock.calls[0][0].action).toBe("integration.connection.deleted");
  });
});
