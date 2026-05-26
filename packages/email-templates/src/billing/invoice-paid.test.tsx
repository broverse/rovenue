import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  invoiceId: "in_2026_05_001",
  amount: { amount: 4900, currency: "USD" },
  periodStart: "2026-05-01",
  periodEnd: "2026-05-31",
  hostedInvoiceUrl: "https://billing.rovenue.io/in_2026_05_001",
};

describe("billing.invoice.paid template", () => {
  it("renders subject + body + CTA in en", async () => {
    const r = await renderTemplate({
      eventKey: "billing.invoice.paid",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Your Rovenue invoice was paid");
    expect(r.html).toMatch(/\$49\.00/);
    expect(r.html).toMatch(/2026-05-01 → 2026-05-31/);
    expect(r.html).toMatch(/View invoice/);
    expect(r.pushTitle).toBe("");
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "billing.invoice.paid",
      locale: "tr",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Rovenue faturanız ödendi");
  });
});
