import { describe, it, expect, vi, beforeEach } from "vitest";

const claimFunnelToken = vi.fn();
const claimInstall = vi.fn();
const claimViaEmail = vi.fn(async () => {});
const addListener = vi.fn();
const remove = vi.fn();
vi.mock("../core/native", () => ({
  getNative: () => ({ claimFunnelToken, claimInstall, claimViaEmail }),
  getEmitter: () => ({ addListener }),
}));

import { claimFunnelToken as cft, claimInstall as ci, addFunnelClaimListener } from "./funnel";

describe("funnel claim", () => {
  beforeEach(() => {
    claimFunnelToken.mockReset();
    claimInstall.mockReset();
    claimViaEmail.mockReset();
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
});
