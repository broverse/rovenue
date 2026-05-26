import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const baseCtx = {
  date: "2026-05-25",
  timezone: "Europe/Istanbul",
  sections: [
    {
      projectId: "p1",
      projectName: "Acme",
      mrr: 12345.67,
      mrrDelta: 4.2,
      newSubs: 18,
      churnedSubs: 3,
      refundCount: 1,
      refundTotalCents: 4999,
      currency: "USD",
    },
    {
      projectId: "p2",
      projectName: "Beta Corp",
      mrr: 2000,
      mrrDelta: -1.5,
      newSubs: 0,
      churnedSubs: 4,
      refundCount: 0,
      refundTotalCents: 0,
      currency: "USD",
    },
  ],
  dashboardUrl: "https://app.rovenue.io",
};

describe("revenue.digest.daily template", () => {
  it("renders one section per project, with subject + money + percent formatting", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.digest.daily",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Your Rovenue daily digest — 2026-05-25");
    expect(r.html).toMatch(/Acme/);
    expect(r.html).toMatch(/Beta Corp/);
    expect(r.html).toMatch(/\$12,345\.67/);
    expect(r.html).toMatch(/\+4\.2%/);
    expect(r.html).toMatch(/−1\.5%/);
    expect(r.html).toMatch(/\$49\.99/);
    // Push channels disabled for digests.
    expect(r.pushTitle).toBe("");
    expect(r.pushBody).toBe("");
  });

  it("renders tr subject + headline", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.digest.daily",
      locale: "tr",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Rovenue günlük özet — 2026-05-25");
    expect(r.html).toMatch(/Günlük özet/);
  });
});
