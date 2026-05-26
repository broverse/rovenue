import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const baseCtx = {
  projectId: "p1",
  projectName: "Rovenue",
  inviterName: "Furkan",
  role: "DEVELOPER",
  acceptUrl: "https://dash.example.com/invitations/tok_123",
  expiresAt: "Tue, 02 Jun 2026 00:00:00 GMT",
};

describe("team.member.invited template", () => {
  it("renders subject, body, CTA and expiry hint in en", async () => {
    const r = await renderTemplate({
      eventKey: "team.member.invited",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe(
      "You've been invited to Rovenue on Rovenue",
    );
    expect(r.html).toMatch(/Furkan/);
    expect(r.html).toMatch(/DEVELOPER/);
    expect(r.html).toMatch(/Accept invitation/);
    expect(r.html).toMatch(/tok_123/);
    expect(r.html).toMatch(/02 Jun 2026/);
    expect(r.pushTitle).toBe("");
  });

  it("falls back to generic footer when expiresAt is absent", async () => {
    const r = await renderTemplate({
      eventKey: "team.member.invited",
      locale: "en",
      context: { ...baseCtx, expiresAt: undefined },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.html).not.toMatch(/expires on/);
    expect(r.html).toMatch(/can ignore it/);
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "team.member.invited",
      locale: "tr",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe(
      "Rovenue üzerinde Rovenue projesine davet edildiniz",
    );
  });
});
