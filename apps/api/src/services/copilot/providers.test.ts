import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveProviderForProject } from "./providers";

const fakeGetCreds = vi.fn();

describe("resolveProviderForProject", () => {
  beforeEach(() => fakeGetCreds.mockReset());

  it("returns BYOK provider when credentials exist", async () => {
    fakeGetCreds.mockResolvedValueOnce({
      provider: "openai",
      defaultModel: "gpt-4o-mini",
      apiKey: "sk-test",
    });
    const out = await resolveProviderForProject({
      projectId: "prj_1",
      loadCreds: fakeGetCreds,
      env: {},
    });
    expect(out.source).toBe("byok");
    expect(out.provider).toBe("openai");
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.apiKey).toBe("sk-test");
  });

  it("falls back to env defaults when no credentials", async () => {
    fakeGetCreds.mockResolvedValueOnce(null);
    const out = await resolveProviderForProject({
      projectId: "prj_1",
      loadCreds: fakeGetCreds,
      env: {
        ROVI_DEFAULT_PROVIDER: "anthropic",
        ROVI_DEFAULT_MODEL: "claude-haiku-4-5",
        ROVI_DEFAULT_API_KEY: "sk-anthropic",
      },
    });
    expect(out.source).toBe("env");
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("claude-haiku-4-5");
  });

  it("throws NOT_CONFIGURED when no credentials and no env fallback", async () => {
    fakeGetCreds.mockResolvedValueOnce(null);
    await expect(
      resolveProviderForProject({
        projectId: "prj_1",
        loadCreds: fakeGetCreds,
        env: {},
      }),
    ).rejects.toMatchObject({ code: "ROVI_NOT_CONFIGURED" });
  });
});
