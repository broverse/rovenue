import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const baseCtx = {
  projectId: "p1",
  projectName: "Acme",
  amount: { amount: 9999, currency: "USD" },
  reason: "high_value" as const,
  dashboardUrl: "https://app.rovenue.io/projects/p1/refunds",
};

describe("billing.refund.detected template", () => {
  it("renders formatted amount + reason + push payload", async () => {
    const r = await renderTemplate({
      eventKey: "billing.refund.detected",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Refund detected on Acme");
    expect(r.html).toMatch(/\$99\.99/);
    expect(r.html).toMatch(/high-value/);
    expect(r.pushTitle).toBe("Refund $99.99 on Acme");
    expect(r.pushBody).toBe("Reason: high-value");
  });

  it("includes productId meta line when supplied", async () => {
    const r = await renderTemplate({
      eventKey: "billing.refund.detected",
      locale: "en",
      context: { ...baseCtx, productId: "prod_premium_yearly" },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.html).toMatch(/prod_premium_yearly/);
  });

  it("renders tr with localized reason label", async () => {
    const r = await renderTemplate({
      eventKey: "billing.refund.detected",
      locale: "tr",
      context: { ...baseCtx, reason: "burst" as const },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Acme projesinde iade tespit edildi");
    expect(r.html).toMatch(/iade patlaması/);
  });
});
