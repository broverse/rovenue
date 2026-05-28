import { describe, expect, it, vi } from "vitest";
import {
  reportDeadLetterToSentry,
  type SentryDeps,
  type DeadLetterContext,
} from "./sentry-bridge";

const ctx: DeadLetterContext = {
  integrationId: "int-1",
  provider: "meta",
  eventType: "Purchase",
  projectId: "p1",
  attemptNumber: 3,
  reason: "max retries exceeded",
  jobId: "job-abc",
};

describe("sentry bridge", () => {
  it("calls captureNotifierError with component webhook-failing-emit", () => {
    const captureNotifierError = vi.fn();
    const deps: SentryDeps = { captureNotifierError };
    const err = new Error("delivery failed");
    reportDeadLetterToSentry(deps, err, ctx);
    expect(captureNotifierError).toHaveBeenCalledOnce();
    const [calledErr, calledCtx] = captureNotifierError.mock.calls[0];
    expect(calledErr).toBe(err);
    expect(calledCtx.component).toBe("webhook-failing-emit");
    expect(calledCtx.projectId).toBe("p1");
    expect(calledCtx.reason).toBe("max retries exceeded");
  });

  it("swallows errors thrown by captureNotifierError (best-effort)", () => {
    const captureNotifierError = vi.fn().mockImplementation(() => {
      throw new Error("sentry unavailable");
    });
    const deps: SentryDeps = { captureNotifierError };
    expect(() => reportDeadLetterToSentry(deps, new Error("oops"), ctx)).not.toThrow();
  });
});
