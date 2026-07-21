import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const redisMock = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  }),
  getdel: vi.fn(async (key: string) => {
    const value = store.get(key) ?? null;
    store.delete(key);
    return value;
  }),
}));

vi.mock("../../lib/redis", () => ({ redis: redisMock }));

import { consumeOAuthState, createOAuthState } from "./oauth-state";

beforeEach(() => {
  store.clear();
  redisMock.set.mockClear();
  redisMock.getdel.mockClear();
});

describe("oauth state", () => {
  it("round-trips a payload", async () => {
    const nonce = await createOAuthState({
      projectId: "p1",
      userId: "u1",
      mode: "live",
    });
    expect(await consumeOAuthState(nonce)).toEqual({
      projectId: "p1",
      userId: "u1",
      mode: "live",
    });
  });

  it("issues a high-entropy nonce", async () => {
    const nonce = await createOAuthState({
      projectId: "p1",
      userId: "u1",
      mode: "live",
    });
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is single-use", async () => {
    const nonce = await createOAuthState({
      projectId: "p1",
      userId: "u1",
      mode: "test",
    });
    await consumeOAuthState(nonce);
    expect(await consumeOAuthState(nonce)).toBeNull();
  });

  it("returns null for an unknown nonce", async () => {
    expect(await consumeOAuthState("nope")).toBeNull();
  });

  it("sets a 600 second TTL", async () => {
    await createOAuthState({ projectId: "p1", userId: "u1", mode: "live" });
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringMatching(/^stripe:oauth:/),
      expect.any(String),
      "EX",
      600,
    );
  });

  it("returns null when the stored value is not valid state", async () => {
    store.set("stripe:oauth:garbage", "{\"nope\":1}");
    expect(await consumeOAuthState("garbage")).toBeNull();
  });
});
