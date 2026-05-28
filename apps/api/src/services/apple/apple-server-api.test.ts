import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendConsumptionInfo, AppleServerApiError } from "./apple-server-api";

const ctx = {
  bundleId: "com.example.app",
  environment: "PRODUCTION" as const,
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("./apple-auth", () => ({
  getAppleAuthToken: vi.fn().mockResolvedValue("test-jwt"),
}));

describe("sendConsumptionInfo", () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("PUTs to the production endpoint with bearer JWT and JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    const payload = {
      customerConsented: true,
      consumptionStatus: 3,
      platform: 1,
      sampleContentProvided: false,
      deliveryStatus: 0,
      accountTenure: 4,
      playTime: 3,
      lifetimeDollarsPurchased: 2,
      lifetimeDollarsRefunded: 0,
      userStatus: 1,
      refundPreference: 2,
    } as const;
    const res = await sendConsumptionInfo(ctx, "tx_123", payload);
    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.storekit.itunes.apple.com/inApps/v1/transactions/consumption/tx_123",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(payload),
      }),
    );
  });

  it("uses sandbox base URL when ctx.environment is SANDBOX", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await sendConsumptionInfo(
      { ...ctx, environment: "SANDBOX" },
      "tx_123",
      {} as never,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.storekit-sandbox.itunes.apple.com"),
      expect.anything(),
    );
  });

  it("throws AppleServerApiError on non-202 status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("bad request body", { status: 400 }),
    );
    await expect(
      sendConsumptionInfo(ctx, "tx_123", {} as never),
    ).rejects.toMatchObject({
      status: 400,
      bodyPreview: expect.stringContaining("bad request"),
    });
  });

  it("error is an instance of AppleServerApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("bad request body", { status: 400 }),
    );
    await expect(
      sendConsumptionInfo(ctx, "tx_123", {} as never),
    ).rejects.toBeInstanceOf(AppleServerApiError);
  });
});
