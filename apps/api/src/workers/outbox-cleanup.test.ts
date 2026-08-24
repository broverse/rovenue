// =============================================================
// outbox retention vs the webhook retry ladder
// =============================================================
//
// The manual-redeliver window IS the outbox retention window: once
// outbox-cleanup prunes a published row, POST .../redeliver has nothing to
// replay and returns 410. Retention shorter than the longest retry ladder
// therefore means a fully-exhausted dead-letter is ALWAYS unredeliverable —
// the delivery is still being retried while its source row is being pruned.

import { describe, expect, it } from "vitest";
import { OUTBOX_RETENTION_WINDOW_MS } from "./outbox-cleanup";
import { WEBHOOK_RETRY_POLICY } from "../services/integrations/retry-policies";

/** Wall-clock span from the first attempt to the last, per the policy's
 *  backoff ladder (backoffMs[i] = wait before attempt i+2). */
function retryLadderSpanMs(policy: typeof WEBHOOK_RETRY_POLICY): number {
  const waits = policy.backoffMs;
  let total = 0;
  for (let attempt = 1; attempt < policy.attempts; attempt++) {
    total += waits[Math.min(attempt - 1, waits.length - 1)] ?? 0;
  }
  return total;
}

describe("OUTBOX_RETENTION_WINDOW_MS", () => {
  it("outlives the longest provider retry ladder with slack to spare", () => {
    const ladderMs = retryLadderSpanMs(WEBHOOK_RETRY_POLICY);
    expect(ladderMs).toBeGreaterThan(0);
    expect(OUTBOX_RETENTION_WINDOW_MS).toBeGreaterThan(ladderMs);
    // Not merely longer — long enough that an operator has more than a full
    // day after the dead-letter to notice it and hit redeliver.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    expect(OUTBOX_RETENTION_WINDOW_MS - ladderMs).toBeGreaterThan(ONE_DAY_MS);
  });
});
