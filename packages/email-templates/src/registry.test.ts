import { describe, expect, it } from "vitest";
import { hasTemplate, registeredEventKeys, renderTemplate } from "./registry";

const baseCtx = {
  projectId: "p1",
  projectName: "Acme",
  metric: "mrr" as const,
  direction: "down" as const,
  magnitudePct: 12,
  windowMinutes: 60,
  dashboardUrl: "https://app.rovenue.io/projects/p1",
};

const managePreferencesUrl = "https://app.rovenue.io/account/notifications";

describe("renderTemplate(revenue.anomaly.detected)", () => {
  it("registers the event", () => {
    expect(hasTemplate("revenue.anomaly.detected")).toBe(true);
    expect(registeredEventKeys()).toContain("revenue.anomaly.detected");
  });

  it("throws on unknown event keys", async () => {
    await expect(
      renderTemplate({
        eventKey: "nope.does.not.exist",
        locale: "en",
        context: {},
        managePreferencesUrl,
      }),
    ).rejects.toThrow(/no template for event/);
  });

  it("renders subject + html + text + pushTitle in en", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.anomaly.detected",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl,
      unsubscribeUrl: "https://app.rovenue.io/u/abc",
    });
    expect(r.subject).toBe("Anomaly detected on Acme");
    expect(r.pushTitle).toBe("Anomaly on Acme");
    expect(r.pushBody).toBe("mrr down 12% / 60 min");
    expect(r.html).toMatch(/Acme/);
    expect(r.html).toMatch(/Unsubscribe/);
    expect(r.html).toMatch(/Open dashboard/);
    expect(r.text).toMatch(/Acme/i);
    expect(r.text).toMatch(/12%/);
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.anomaly.detected",
      locale: "tr",
      context: baseCtx,
      managePreferencesUrl,
    });
    expect(r.subject).toBe("Acme projesinde anomali");
    expect(r.pushTitle).toBe("Acme — anomali");
    expect(r.html).toMatch(/Acme/);
    expect(r.html).toMatch(/Aboneliği iptal et|Tercihleri yönet/);
  });

  it("falls back to en for unknown locale", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.anomaly.detected",
      locale: "de",
      context: baseCtx,
      managePreferencesUrl,
    });
    expect(r.subject).toContain("Anomaly");
  });

  it("omits the unsubscribe link when no URL is supplied", async () => {
    const r = await renderTemplate({
      eventKey: "revenue.anomaly.detected",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl,
    });
    expect(r.html).not.toMatch(/Unsubscribe/);
    expect(r.html).toMatch(/Manage preferences/);
  });
});
