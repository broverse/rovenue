import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFunnelTokenToClipboard } from "./clipboard";

describe("writeFunnelTokenToClipboard", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("writes the rovenue-funnel marker", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await writeFunnelTokenToClipboard("abc123");
    expect(writeText).toHaveBeenCalledWith("rovenue-funnel:abc123");
  });

  it("swallows a rejected clipboard write", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(writeFunnelTokenToClipboard("abc123")).resolves.toBeUndefined();
  });

  it("no-ops when clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(writeFunnelTokenToClipboard("abc123")).resolves.toBeUndefined();
  });
});
