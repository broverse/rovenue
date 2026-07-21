import { describe, expect, it } from "vitest";
import { parseResendEvent } from "./resend-events";

function envelope(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, created_at: "2026-07-21T10:00:00.000Z", data });
}

describe("parseResendEvent", () => {
  it("maps email.delivered to DELIVERED with lowercased recipients", () => {
    const patch = parseResendEvent(
      envelope("email.delivered", { email_id: "re_1", to: ["User@Example.com"] }),
    );
    expect(patch).toEqual({
      providerMessageId: "re_1",
      status: "DELIVERED",
      error: null,
      recipients: ["user@example.com"],
    });
  });

  it("maps a permanent email.bounced to BOUNCED with diagnostic error", () => {
    const patch = parseResendEvent(
      envelope("email.bounced", {
        email_id: "re_2",
        to: ["u@e.com"],
        bounce: { type: "Permanent", subType: "General", message: "550 no such user" },
      }),
    );
    expect(patch).toEqual({
      providerMessageId: "re_2",
      status: "BOUNCED",
      error: "Permanent: General: 550 no such user",
      recipients: ["u@e.com"],
    });
  });

  it("treats a bounce without a type as permanent", () => {
    const patch = parseResendEvent(
      envelope("email.bounced", { email_id: "re_3", to: ["u@e.com"] }),
    );
    expect(patch?.status).toBe("BOUNCED");
    expect(patch?.error).toBe("bounced");
  });

  it("ignores transient bounces", () => {
    expect(
      parseResendEvent(
        envelope("email.bounced", {
          email_id: "re_4",
          to: ["u@e.com"],
          bounce: { type: "Transient", message: "mailbox full" },
        }),
      ),
    ).toBeNull();
  });

  it("maps email.complained to COMPLAINED", () => {
    const patch = parseResendEvent(
      envelope("email.complained", { email_id: "re_5", to: ["u@e.com"] }),
    );
    expect(patch).toEqual({
      providerMessageId: "re_5",
      status: "COMPLAINED",
      error: null,
      recipients: ["u@e.com"],
    });
  });

  it("accepts a string `to` field", () => {
    const patch = parseResendEvent(
      envelope("email.delivered", { email_id: "re_6", to: "Solo@E.com" }),
    );
    expect(patch?.recipients).toEqual(["solo@e.com"]);
  });

  it("ignores non-delivery event types", () => {
    for (const type of ["email.sent", "email.opened", "email.clicked", "email.delivery_delayed", "contact.created"]) {
      expect(parseResendEvent(envelope(type, { email_id: "re_7", to: ["u@e.com"] }))).toBeNull();
    }
  });

  it("returns null for malformed JSON, missing type, or missing email_id", () => {
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ data: { email_id: "x" } }))).toBeNull();
    expect(parseResendEvent(envelope("email.delivered", { to: ["u@e.com"] }))).toBeNull();
  });
});
