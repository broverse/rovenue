import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  projectId: "p1",
  projectName: "Acme",
  webhookId: "wh_01HZX",
  endpointUrl: "https://example.com/hooks/rovenue",
  consecutiveFailures: 7,
  dashboardUrl: "https://app.rovenue.io/projects/p1/webhooks/wh_01HZX",
};

describe("integration.webhook.failing template", () => {
  it("renders subject + body + failure count + webhook id", async () => {
    const r = await renderTemplate({
      eventKey: "integration.webhook.failing",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Webhook delivery failing on Acme");
    expect(r.html).toMatch(/7/);
    expect(r.html).toMatch(/example\.com\/hooks\/rovenue/);
    expect(r.html).toMatch(/wh_01HZX/);
    expect(r.pushTitle).toBe("");
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "integration.webhook.failing",
      locale: "tr",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Acme — webhook teslimi başarısız");
  });
});
