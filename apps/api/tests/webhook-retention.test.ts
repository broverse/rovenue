import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    webhookEventRepo: {
      deleteWebhookEventsOlderThan: vi.fn(async (_db: unknown, _cutoff: Date) => 0),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", () => ({
  drizzle: drizzleMock,
}));

// =============================================================
// System under test (imported after mocks)
// =============================================================

import { runWebhookRetention } from "../src/workers/webhook-retention";

// =============================================================
// Helpers
// =============================================================

const NOW = new Date("2026-05-01T12:00:00Z");
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mockResolvedValue(0);
});

// =============================================================
// Tests
// =============================================================

describe("runWebhookRetention", () => {
  test("calls deleteWebhookEventsOlderThan with a cutoff 90 days before `now`", async () => {
    await runWebhookRetention(NOW);

    expect(
      drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan,
    ).toHaveBeenCalledOnce();
    const call =
      drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mock.calls[0]!;
    const cutoff = call[1] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBe(NOW.getTime() - NINETY_DAYS_MS);
  });

  test("returns { deleted, cutoff } with the repo's count and ISO8601 cutoff", async () => {
    drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mockResolvedValue(
      42,
    );

    const result = await runWebhookRetention(NOW);

    expect(result.deleted).toBe(42);
    expect(result.cutoff).toBe(
      new Date(NOW.getTime() - NINETY_DAYS_MS).toISOString(),
    );
    // Sanity: ISO8601 round-trips.
    expect(new Date(result.cutoff).toISOString()).toBe(result.cutoff);
  });

  test("propagates the repo error unchanged", async () => {
    drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mockRejectedValue(
      new Error("db down"),
    );

    await expect(runWebhookRetention(NOW)).rejects.toThrow("db down");
  });

  test("defaults `now` to the current time when no argument is provided", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);

      await runWebhookRetention();

      const call =
        drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mock.calls[0]!;
      const cutoff = call[1] as Date;
      expect(cutoff.getTime()).toBe(NOW.getTime() - NINETY_DAYS_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
