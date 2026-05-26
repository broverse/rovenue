import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  projectId: "p1",
  projectName: "Acme",
  removedByName: "Furkan",
};

describe("team.member.removed template", () => {
  it("renders subject + body in en", async () => {
    const r = await renderTemplate({
      eventKey: "team.member.removed",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("You've been removed from Acme");
    expect(r.html).toMatch(/Furkan/);
    expect(r.pushTitle).toBe("");
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "team.member.removed",
      locale: "tr",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Acme projesinden çıkarıldınız");
  });
});
