import { describe, expect, it } from "vitest";
import { renderInvitationEmail } from "./invitation";

describe("renderInvitationEmail", () => {
  it("includes all key params in subject/html/text", () => {
    const out = renderInvitationEmail({
      inviterName: "Furkan",
      projectName: "Rovenue",
      role: "DEVELOPER",
      inviteUrl: "https://dash.example.com/invitations/tok_123",
      expiresAt: new Date("2026-06-02T00:00:00Z"),
    });
    expect(out.subject).toContain("Rovenue");
    expect(out.subject).toContain("invited");
    expect(out.html).toContain("Furkan");
    expect(out.html).toContain("DEVELOPER");
    expect(out.html).toContain(
      'href="https://dash.example.com/invitations/tok_123"',
    );
    expect(out.text).toContain("https://dash.example.com/invitations/tok_123");
    expect(out.text).toContain("DEVELOPER");
    expect(out.text).toContain("Rovenue");
  });

  it("escapes HTML in inviter / project name to prevent injection", () => {
    const out = renderInvitationEmail({
      inviterName: '<script>alert(1)</script>',
      projectName: '"><img>',
      role: "ADMIN",
      inviteUrl: "https://example.com/x",
      expiresAt: new Date(),
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain('"><img>');
  });
});
