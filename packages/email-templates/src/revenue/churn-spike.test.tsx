import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  projectId: "p1",
  projectName: "Acme",
  churnRatePct: 9.3,
  baselinePct: 3.1,
  windowDays: 7,
  dashboardUrl: "https://app.rovenue.io/projects/p1/churn",
};

describe("revenue.churn.spike template", () => {
  it("renders subject, body and push payload in en", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.churn.spike",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Churn spike on Acme");
    expect(r.html).toMatch(/9\.3%/);
    expect(r.html).toMatch(/3\.1%/);
    expect(r.html).toMatch(/Open churn dashboard/);
    expect(r.pushTitle).toBe("Churn spike on Acme");
    expect(r.pushBody).toBe("9.3% vs 3.1% baseline");
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.churn.spike",
      locale: "tr",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Acme projesinde churn sıçraması");
  });
});
