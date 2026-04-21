import { vi } from "vitest";

// =============================================================
// Shared audit mock
// =============================================================
//
// Most route-level tests care that audit() was invoked with a
// specific entry, not about the chain mechanics. This helper
// returns a bundle of vi.fn stubs that test files wire into
// vi.mock("../src/lib/audit", ...). Tests assert against
// `auditMock.audit.mock.calls[n][0]` — the first argument is the
// audit entry object.
//
// Chain-behavior tests (audit-chain.test.ts) import the real
// audit module with a live Drizzle mock that simulates the
// per-project hash chain; this helper is not for them.

export function buildAuditMock() {
  return {
    audit: vi.fn(async () => undefined),
    extractRequestContext: vi.fn(() => ({
      ipAddress: null,
      userAgent: null,
    })),
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
  };
}
