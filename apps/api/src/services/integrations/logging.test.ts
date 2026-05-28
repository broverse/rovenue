import { describe, expect, it, vi } from "vitest";
import {
  logDeliveryAttempt,
  logDeliveryResult,
  logDeliveryDeadLetter,
  type AttemptFields,
  type ResultFields,
  type DeadLetterFields,
} from "./logging";
import type { Logger } from "../../lib/logger";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

const baseAttempt: AttemptFields = {
  integrationId: "int-1",
  provider: "meta",
  eventType: "Purchase",
  attemptNumber: 1,
  jobId: "job-abc",
};

describe("structured log helpers", () => {
  it("logDeliveryAttempt calls log.info with correct message", () => {
    const log = makeLogger();
    logDeliveryAttempt(log, baseAttempt);
    expect(log.info).toHaveBeenCalledWith(
      "integration.delivery.attempt",
      expect.objectContaining({ integrationId: "int-1", provider: "meta" }),
    );
  });

  it("logDeliveryResult calls log.info on success", () => {
    const log = makeLogger();
    const fields: ResultFields = { ...baseAttempt, durationMs: 42, success: true, statusCode: 200 };
    logDeliveryResult(log, fields);
    expect(log.info).toHaveBeenCalledWith(
      "integration.delivery.result",
      expect.objectContaining({ success: true }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logDeliveryResult calls log.warn on failure", () => {
    const log = makeLogger();
    const fields: ResultFields = { ...baseAttempt, durationMs: 42, success: false, statusCode: 500 };
    logDeliveryResult(log, fields);
    expect(log.warn).toHaveBeenCalledWith(
      "integration.delivery.result",
      expect.objectContaining({ success: false }),
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logDeliveryDeadLetter calls log.error", () => {
    const log = makeLogger();
    const fields: DeadLetterFields = { ...baseAttempt, reason: "max retries", finalError: "timeout" };
    logDeliveryDeadLetter(log, fields);
    expect(log.error).toHaveBeenCalledWith(
      "integration.delivery.dead_letter",
      expect.objectContaining({ reason: "max retries" }),
    );
  });
});
