import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  projectId: "p1",
  projectName: "Acme",
  milestone: { amount: 1_000_000, currency: "USD" },
  metric: "mrr" as const,
  dashboardUrl: "https://app.rovenue.io/projects/p1",
};

describe("revenue.milestone.hit template", () => {
  it("renders subject + formatted milestone in en", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.milestone.hit",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Milestone hit on Acme");
    expect(r.html).toMatch(/\$10,000\.00/);
    expect(r.html).toMatch(/MRR/);
    expect(r.pushTitle).toBe("");
  });

  it("renders tr with translated metric label", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.milestone.hit",
      locale: "tr",
      context: { ...ctx, metric: "total_revenue" as const },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Acme kilometre taşını geçti");
    expect(r.html).toMatch(/toplam gelir/);
  });
});
