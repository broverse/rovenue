import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const baseCtx = {
  projectId: "p1",
  projectName: "Acme",
  provider: "apple" as const,
  expiresAt: "2026-05-25T00:00:00Z",
  reconnectUrl: "https://app.rovenue.io/projects/p1/integrations/apple",
};

describe("integration.store_credential.expired template", () => {
  it("renders subject + body + push payload with provider label", async () => {
    const r = await renderTemplate({
      eventKey: "integration.store_credential.expired",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Apple credentials expired on Acme");
    expect(r.html).toMatch(/Apple credentials expired on Acme/);
    expect(r.html).toMatch(/Reconnect Apple/);
    expect(r.html).toMatch(/Expired on 2026-05-25T00:00:00Z/);
    expect(r.pushTitle).toBe("Apple creds expired");
  });

  it("omits expiresAt line when absent and renders google + tr", async () => {
    const r = await renderTemplate({
      eventKey: "integration.store_credential.expired",
      locale: "tr",
      context: {
        ...baseCtx,
        provider: "google" as const,
        expiresAt: undefined,
      },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe(
      "Acme — Google kimlik bilgileri süresi doldu",
    );
    expect(r.html).not.toMatch(/Bitiş tarihi/);
  });
});
