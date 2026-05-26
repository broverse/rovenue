import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const ctx = {
  projectId: "p1",
  projectName: "Acme",
  oldRole: "DEVELOPER",
  newRole: "ADMIN",
  changedByName: "Furkan",
  projectUrl: "https://app.rovenue.io/projects/p1",
};

describe("team.member.role_changed template", () => {
  it("renders role change with actor", async () => {
    const r = await renderTemplate({
      eventKey: "team.member.role_changed",
      locale: "en",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Your role on Acme changed");
    expect(r.html).toMatch(/DEVELOPER/);
    expect(r.html).toMatch(/ADMIN/);
    expect(r.html).toMatch(/Furkan/);
    expect(r.pushTitle).toBe("");
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "team.member.role_changed",
      locale: "tr",
      context: ctx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Acme üzerindeki rolünüz değişti");
  });
});
