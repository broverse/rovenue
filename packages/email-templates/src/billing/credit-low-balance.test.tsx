import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  projectId: "p1",
  projectName: "Acme",
  balanceCents: 4250,
  thresholdCents: 10_000,
  dashboardUrl: "https://app.rovenue.io/projects/p1/billing",
};

describe("billing.credit.low_balance template", () => {
  it("renders formatted balance + threshold + push payload", async () => {
    const r = await renderTemplate({
      eventKey: "billing.credit.low_balance",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Low credit balance on Acme");
    expect(r.html).toMatch(/\$42\.50/);
    expect(r.html).toMatch(/\$100\.00/);
    expect(r.pushTitle).toBe("Low balance on Acme");
    expect(r.pushBody).toBe("Balance: $42.50 (threshold $100.00)");
  });

  it("respects an explicit currency override", async () => {
    const r = await renderTemplate({
      eventKey: "billing.credit.low_balance",
      locale: "tr",
      context: { ...ctx, currency: "EUR" },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Acme — kredi bakiyesi düşük");
    expect(r.html).toMatch(/€/);
  });
});
