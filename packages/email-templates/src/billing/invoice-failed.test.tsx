import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const baseCtx = {
  invoiceId: "in_2026_05_001",
  amount: { amount: 4900, currency: "USD" },
  reason: "card_declined",
  hostedInvoiceUrl: "https://billing.rovenue.io/in_2026_05_001",
};

describe("billing.invoice.failed template", () => {
  it("renders subject + body + CTA + push payload in en", async () => {
    const r = await renderTemplate({
      eventKey: "billing.invoice.failed",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Your Rovenue invoice failed to charge");
    expect(r.html).toMatch(/\$49\.00/);
    expect(r.html).toMatch(/card_declined/);
    expect(r.html).toMatch(/View invoice/);
    expect(r.html).toMatch(/in_2026_05_001/);
    expect(r.pushTitle).toBe("Invoice failed");
    expect(r.pushBody).toBe("$49.00 — card_declined");
  });

  it("omits the CTA when hostedInvoiceUrl is absent", async () => {
    const r = await renderTemplate({
      eventKey: "billing.invoice.failed",
      locale: "en",
      context: { ...baseCtx, hostedInvoiceUrl: undefined },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.html).not.toMatch(/View invoice/);
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "billing.invoice.failed",
      locale: "tr",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Rovenue faturanız tahsil edilemedi");
  });
});
