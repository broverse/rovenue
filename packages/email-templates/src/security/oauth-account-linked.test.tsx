import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  provider: "github" as const,
  whenIso: "2026-05-26T10:00:00Z",
  connectedAccountsUrl: "https://app.rovenue.io/account/security/connections",
};

describe("security.oauth.account_linked template", () => {
  it("renders subject + provider label + body", async () => {
    const r = await renderTemplate({
      eventKey: "security.oauth.account_linked",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Your GitHub account is now linked");
    expect(r.html).toMatch(/GitHub/);
    expect(r.html).toMatch(/2026-05-26T10:00:00Z/);
    expect(r.html).toMatch(/Manage connected accounts/);
    expect(r.pushTitle).toBe("");
  });

  it("renders tr with localized provider label", async () => {
    const r = await renderTemplate({
      eventKey: "security.oauth.account_linked",
      locale: "tr",
      context: { ...ctx, provider: "google" as const },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Google hesabınız artık bağlı");
  });
});
