import { describe, expect, it, vi, afterEach } from "vitest";
import { drizzle } from "@rovenue/db";
import { reapStaleIntents } from "./rovi-reaper";

describe("reapStaleIntents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls expireStaleIntents and returns the count", async () => {
    vi.spyOn(drizzle.copilotIntentRepo, "expireStaleIntents").mockResolvedValueOnce(3);

    const result = await reapStaleIntents();

    expect(drizzle.copilotIntentRepo.expireStaleIntents).toHaveBeenCalledTimes(1);
    expect(drizzle.copilotIntentRepo.expireStaleIntents).toHaveBeenCalledWith(drizzle.db);
    expect(result).toBe(3);
  });

  it("returns 0 when no intents are stale", async () => {
    vi.spyOn(drizzle.copilotIntentRepo, "expireStaleIntents").mockResolvedValueOnce(0);

    const result = await reapStaleIntents();

    expect(result).toBe(0);
  });
});
