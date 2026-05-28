import { describe, expect, it, vi, afterEach } from "vitest";
import { drizzle } from "@rovenue/db";
import { purgeOldMessages } from "./rovi-retention";

describe("purgeOldMessages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls copilotMessageRepo.purgeOldMessages and returns the deleted count", async () => {
    vi.spyOn(drizzle.copilotMessageRepo, "purgeOldMessages").mockResolvedValueOnce(7);

    const result = await purgeOldMessages();

    expect(drizzle.copilotMessageRepo.purgeOldMessages).toHaveBeenCalledTimes(1);
    expect(drizzle.copilotMessageRepo.purgeOldMessages).toHaveBeenCalledWith(
      drizzle.db,
      expect.any(Number),
    );
    expect(result).toBe(7);
  });

  it("returns 0 when no messages are old enough to purge", async () => {
    vi.spyOn(drizzle.copilotMessageRepo, "purgeOldMessages").mockResolvedValueOnce(0);

    const result = await purgeOldMessages();

    expect(result).toBe(0);
  });
});
