import { describe, it, expect, vi, beforeEach } from "vitest";

const claimFunnelToken = vi.fn();
const claimInstall = vi.fn();
const claimViaEmail = vi.fn(async () => {});
vi.mock("../core/native", () => ({
  getNative: () => ({ claimFunnelToken, claimInstall, claimViaEmail }),
}));

import { claimFunnelToken as cft, claimInstall as ci } from "./funnel";

describe("funnel claim", () => {
  beforeEach(() => { claimFunnelToken.mockReset(); claimInstall.mockReset(); });

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
});
