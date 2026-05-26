import { describe, expect, it } from "vitest";
import { verifyUnsubscribeToken } from "../../lib/unsubscribe-token";
import { buildEmailHeaders } from "./email-headers";

const KEY = "ab".repeat(32);
const NOW = Date.UTC(2026, 4, 26, 10, 0, 0); // 2026-05-26T10:00:00Z

describe("buildEmailHeaders", () => {
  it("returns empty headers for forced-channel events", () => {
    const h = buildEmailHeaders({
      eventKey: "billing.invoice.failed", // forcedChannels: ["email"]
      userId: "u1",
      dashboardUrl: "https://app.rovenue.io",
      signingKey: KEY,
      mailtoUnsub: "unsub@rovenue.io",
    });
    expect(h).toEqual({});
  });

  it("returns both headers for non-forced events", () => {
    const h = buildEmailHeaders({
      eventKey: "revenue.anomaly.detected",
      userId: "u1",
      projectId: "p1",
      dashboardUrl: "https://app.rovenue.io",
      signingKey: KEY,
      mailtoUnsub: "unsub@rovenue.io",
    });
    expect(Object.keys(h).sort()).toEqual([
      "List-Unsubscribe",
      "List-Unsubscribe-Post",
    ]);
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(h["List-Unsubscribe"]).toMatch(
      /^<https:\/\/app\.rovenue\.io\/unsubscribe\?token=[^>]+>, <mailto:unsub@rovenue\.io>$/,
    );
  });

  it("emits a token that round-trips to the original payload", () => {
    const h = buildEmailHeaders({
      eventKey: "revenue.anomaly.detected",
      userId: "u1",
      projectId: "p1",
      dashboardUrl: "https://app.rovenue.io",
      signingKey: KEY,
      mailtoUnsub: "unsub@rovenue.io",
      nowMs: NOW,
    });
    const token = h["List-Unsubscribe"]!.match(/token=([^>]+)>/)![1]!;
    const verified = verifyUnsubscribeToken(token, KEY, NOW);
    expect(verified.userId).toBe("u1");
    expect(verified.projectId).toBe("p1");
    expect(verified.scope).toBe("channel:email");
    expect(verified.exp).toBe(Math.floor(NOW / 1000) + 30 * 24 * 60 * 60);
  });

  it("trims trailing slashes from the dashboard URL", () => {
    const h = buildEmailHeaders({
      eventKey: "revenue.anomaly.detected",
      userId: "u1",
      dashboardUrl: "https://app.rovenue.io///",
      signingKey: KEY,
      mailtoUnsub: "unsub@rovenue.io",
    });
    expect(h["List-Unsubscribe"]).toMatch(
      /<https:\/\/app\.rovenue\.io\/unsubscribe\?token=/,
    );
  });

  it("honours a custom ttlSeconds", () => {
    const h = buildEmailHeaders({
      eventKey: "revenue.anomaly.detected",
      userId: "u1",
      dashboardUrl: "https://app.rovenue.io",
      signingKey: KEY,
      mailtoUnsub: "unsub@rovenue.io",
      ttlSeconds: 60,
      nowMs: NOW,
    });
    const token = h["List-Unsubscribe"]!.match(/token=([^>]+)>/)![1]!;
    const verified = verifyUnsubscribeToken(token, KEY, NOW);
    expect(verified.exp).toBe(Math.floor(NOW / 1000) + 60);
  });
});
