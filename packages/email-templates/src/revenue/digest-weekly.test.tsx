import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const baseCtx = {
  weekStart: "2026-05-18",
  weekEnd: "2026-05-24",
  timezone: "Europe/Istanbul",
  sections: [
    {
      projectId: "p1",
      projectName: "Acme",
      mrr: 30000,
      mrrDelta: 8.5,
      newSubs: 120,
      churnedSubs: 7,
      refundCount: 2,
      refundTotalCents: 19800,
      currency: "USD",
    },
  ],
  dashboardUrl: "https://app.rovenue.io",
};

describe("revenue.digest.weekly template", () => {
  it("renders subject + week range + section content", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.digest.weekly",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Your Rovenue weekly summary — 2026-05-18");
    expect(r.html).toMatch(/2026-05-18 → 2026-05-24/);
    expect(r.html).toMatch(/Acme/);
    expect(r.html).toMatch(/\$30,000\.00/);
    expect(r.html).toMatch(/\+8\.5%/);
    expect(r.html).toMatch(/\$198\.00/);
    expect(r.pushTitle).toBe("");
  });

  it("renders tr headline", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.digest.weekly",
      locale: "tr",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Rovenue haftalık özet — 2026-05-18");
    expect(r.html).toMatch(/Haftalık özet/);
  });
});
