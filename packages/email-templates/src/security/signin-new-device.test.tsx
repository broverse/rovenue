import { describe, expect, it } from "vitest";
import { renderTemplate } from "../registry";

const baseCtx = {
  userAgent: "Chrome 132 on macOS",
  ipAddress: "203.0.113.4",
  approxLocation: "Istanbul, TR",
  whenIso: "2026-05-26T10:00:00Z",
  reviewDevicesUrl: "https://app.rovenue.io/account/security/devices",
};

describe("security.signin.new_device template", () => {
  it("renders subject + body + push payload", async () => {
    const r = await renderTemplate({
      eventKey: "security.signin.new_device",
      locale: "en",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("New sign-in from Chrome 132 on macOS");
    expect(r.html).toMatch(/Istanbul, TR/);
    expect(r.html).toMatch(/203\.0\.113\.4/);
    expect(r.html).toMatch(/Review devices/);
    expect(r.pushTitle).toBe("New sign-in to your account");
    expect(r.pushBody).toBe("Chrome 132 on macOS · Istanbul, TR");
  });

  it("falls back to ip when approxLocation absent", async () => {
    const r = await renderTemplate({
      eventKey: "security.signin.new_device",
      locale: "en",
      context: { ...baseCtx, approxLocation: undefined },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.pushBody).toBe("Chrome 132 on macOS · 203.0.113.4");
  });

  it("renders in tr", async () => {
    const r = await renderTemplate({
      eventKey: "security.signin.new_device",
      locale: "tr",
      context: baseCtx,
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toBe("Chrome 132 on macOS üzerinden yeni oturum");
  });
});
