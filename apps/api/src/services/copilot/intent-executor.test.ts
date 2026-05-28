import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  executeIntent,
  registerIntentHandler,
  __resetIntentHandlersForTests,
} from "./intent-executor";

const fakeRefund = vi.fn();

beforeEach(() => {
  __resetIntentHandlersForTests();
  fakeRefund.mockReset();
  registerIntentHandler("action.subscriptions.refund", async (ctx, payload) => {
    return fakeRefund(ctx, payload);
  });
});

describe("executeIntent", () => {
  it("invokes the registered handler with payload and ctx", async () => {
    fakeRefund.mockResolvedValueOnce({ refunded: true });
    const out = await executeIntent({
      intent: {
        id: "int_1",
        toolName: "action.subscriptions.refund",
        payload: { purchaseId: "p_1", reason: "duplicate" },
      },
      ctx: { projectId: "prj_1", userId: "u_1", role: "ADMIN" },
    });
    expect(out).toEqual({ refunded: true });
    expect(fakeRefund).toHaveBeenCalledOnce();
  });

  it("throws when no handler registered", async () => {
    await expect(
      executeIntent({
        intent: { id: "int_2", toolName: "action.unknown.foo", payload: {} },
        ctx: { projectId: "prj_1", userId: "u_1", role: "ADMIN" },
      }),
    ).rejects.toThrow(/no handler/i);
  });
});
