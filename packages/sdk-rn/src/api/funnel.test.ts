import { describe, it, expect, vi, beforeEach } from "vitest";

const claimFunnelToken = vi.fn();
const claimInstall = vi.fn();
const claimViaEmail = vi.fn(async () => {});
const claimFromClipboard = vi.fn();
const hasResolvedFunnelClaim = vi.fn();
const addListener = vi.fn();
const remove = vi.fn();
vi.mock("../core/native", () => ({
  getNative: () => ({ claimFunnelToken, claimInstall, claimViaEmail, claimFromClipboard, hasResolvedFunnelClaim }),
  getEmitter: () => ({ addListener }),
}));

import { claimFunnelToken as cft, claimInstall as ci, addFunnelClaimListener, claimFromClipboard as cfc, extractFunnelToken, claimFromUrl, resolveFunnelClaim } from "./funnel";

describe("funnel claim", () => {
  beforeEach(() => {
    claimFunnelToken.mockReset();
    claimInstall.mockReset();
    claimViaEmail.mockReset();
    claimFromClipboard.mockReset();
    addListener.mockReset();
    remove.mockReset();
    addListener.mockReturnValue({ remove });
  });

  it("parses funnel_answers_json into funnelAnswers", async () => {
    claimFunnelToken.mockResolvedValue({ subscriberId: "sub_1", funnelAnswersJson: '{"q1":"yes"}' });
    const r = await cft("tok");
    expect(r).toEqual({ subscriberId: "sub_1", funnelAnswers: { q1: "yes" } });
    expect(claimFunnelToken).toHaveBeenCalledWith("tok");
  });

  it("maps claimInstall null → null", async () => {
    claimInstall.mockResolvedValue(null);
    expect(await ci({ platform: "ios", locale: "en-US", timezone: "UTC", screenDims: "390x844" })).toBeNull();
  });

  it("maps claimInstall result → parsed", async () => {
    claimInstall.mockResolvedValue({ subscriberId: "sub_2", funnelAnswersJson: "{}" });
    const r = await ci({ platform: "android", locale: "en-US", timezone: "UTC", screenDims: "390x844", installReferrer: "x" });
    expect(r).toEqual({ subscriberId: "sub_2", funnelAnswers: {} });
  });

  it("claimInstall() with no args forwards an empty object to native", async () => {
    claimInstall.mockResolvedValue(null);
    await ci();
    expect(claimInstall).toHaveBeenCalledWith({});
  });

  it("claimInstall passes caller overrides through unchanged", async () => {
    claimInstall.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: "{}" });
    await ci({ installReferrer: "rovenue_funnel_token%3Dabc" });
    expect(claimInstall).toHaveBeenCalledWith({ installReferrer: "rovenue_funnel_token%3Dabc" });
  });

  it("addFunnelClaimListener delivers parsed payload and unsubscribe calls remove", () => {
    let capturedHandler: ((p: any) => void) | undefined;
    addListener.mockImplementation((_event: string, handler: (p: any) => void) => {
      capturedHandler = handler;
      return { remove };
    });

    const received: any[] = [];
    const unsub = addFunnelClaimListener((result) => received.push(result));

    expect(addListener).toHaveBeenCalledWith("onFunnelClaimResolved", expect.any(Function));

    capturedHandler!({ subscriberId: "sub_x", funnelAnswersJson: '{"q":1}' });
    expect(received).toEqual([{ subscriberId: "sub_x", funnelAnswers: { q: 1 } }]);

    expect(remove).not.toHaveBeenCalled();
    unsub();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("claimFromClipboard parses a native result", async () => {
    claimFromClipboard.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: '{"q":1}' });
    expect(await cfc()).toEqual({ subscriberId: "s", funnelAnswers: { q: 1 } });
  });

  it("claimFromClipboard returns null when native returns null", async () => {
    claimFromClipboard.mockResolvedValue(null);
    expect(await cfc()).toBeNull();
  });
});

describe("extractFunnelToken", () => {
  const TOK = "a".repeat(48); // 40-64 char funnel token
  it("extracts from a Universal Link path", () => {
    expect(extractFunnelToken(`https://links.acme.com/universal/funnels/open/${TOK}`)).toBe(TOK);
  });
  it("extracts from a path with trailing query/fragment", () => {
    expect(extractFunnelToken(`https://d/universal/funnels/open/${TOK}?x=1#y`)).toBe(TOK);
  });
  it("stops the path token at the next '/' (real funnel tokens have no slash)", () => {
    expect(extractFunnelToken(`https://d/universal/funnels/open/${TOK}/extra`)).toBe(TOK);
  });
  it("extracts from the funnel deep-link query (token= on onboarding-complete)", () => {
    expect(extractFunnelToken(`myapp://onboarding-complete?token=${TOK}`)).toBe(TOK);
  });
  it("extracts rovenue_funnel_token= anywhere", () => {
    expect(extractFunnelToken(`myapp://whatever?rovenue_funnel_token=${TOK}`)).toBe(TOK);
  });
  it("ignores a generic token= on a non-funnel host", () => {
    expect(extractFunnelToken(`myapp://reset-password?token=${TOK}`)).toBeNull();
  });
  it("does NOT honor token= when onboarding-complete appears only in the query", () => {
    expect(extractFunnelToken(`myapp://reset-password?onboarding-complete=1&token=${TOK}`)).toBeNull();
  });
  it("returns null for a non-funnel URL", () => {
    expect(extractFunnelToken("https://example.com/page?x=1")).toBeNull();
  });
  it("returns null for empty/garbage", () => {
    expect(extractFunnelToken("")).toBeNull();
    expect(extractFunnelToken("not a url")).toBeNull();
  });
});

describe("claimFromUrl", () => {
  const TOK = "b".repeat(48);
  beforeEach(() => claimFunnelToken.mockReset());
  it("claims when the URL carries a token", async () => {
    claimFunnelToken.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: '{"q":1}' });
    const r = await claimFromUrl(`https://d/universal/funnels/open/${TOK}`);
    expect(claimFunnelToken).toHaveBeenCalledWith(TOK);
    expect(r).toEqual({ subscriberId: "s", funnelAnswers: { q: 1 } });
  });
  it("resolves null and does NOT touch native for a non-funnel URL", async () => {
    const r = await claimFromUrl("https://example.com/page");
    expect(r).toBeNull();
    expect(claimFunnelToken).not.toHaveBeenCalled();
  });
  it("resolves null (no native call) for a generic token= on a non-funnel host", async () => {
    const r = await claimFromUrl(`myapp://reset-password?token=${TOK}`);
    expect(r).toBeNull();
    expect(claimFunnelToken).not.toHaveBeenCalled();
  });
});

describe("resolveFunnelClaim", () => {
  const TOK = "c".repeat(48);
  const FUNNEL_URL = `https://d/universal/funnels/open/${TOK}`;
  beforeEach(() => {
    hasResolvedFunnelClaim.mockReset();
    claimFunnelToken.mockReset();
    claimInstall.mockReset();
  });

  it("skips the chain when already resolved", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(true);
    expect(await resolveFunnelClaim({ url: FUNNEL_URL })).toBeNull();
    expect(claimFunnelToken).not.toHaveBeenCalled();
    expect(claimInstall).not.toHaveBeenCalled();
  });

  it("returns the deep-link claim when the url resolves", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimFunnelToken.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: "{}" });
    const r = await resolveFunnelClaim({ url: FUNNEL_URL });
    expect(r).toEqual({ subscriberId: "s", funnelAnswers: {} });
    expect(claimInstall).not.toHaveBeenCalled();
  });

  it("falls through to claimInstall when the deep-link token is invalid (throws)", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimFunnelToken.mockRejectedValue(Object.assign(new Error("x"), { code: "FunnelTokenExpired" }));
    claimInstall.mockResolvedValue({ subscriberId: "s2", funnelAnswersJson: "{}" });
    const r = await resolveFunnelClaim({ url: FUNNEL_URL });
    expect(r).toEqual({ subscriberId: "s2", funnelAnswers: {} });
    expect(claimInstall).toHaveBeenCalledTimes(1);
  });

  it("uses claimInstall when no url is given", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimInstall.mockResolvedValue({ subscriberId: "s3", funnelAnswersJson: "{}" });
    expect(await resolveFunnelClaim()).toEqual({ subscriberId: "s3", funnelAnswers: {} });
  });

  it("returns null when nothing resolves", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimInstall.mockResolvedValue(null);
    expect(await resolveFunnelClaim({})).toBeNull();
  });

  it("returns null (no throw) when claimInstall throws", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimInstall.mockRejectedValue(new Error("network"));
    expect(await resolveFunnelClaim({})).toBeNull();
  });
});
