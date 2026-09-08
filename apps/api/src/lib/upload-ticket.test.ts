// =============================================================
// Upload-ticket unit tests (DB-free).
//
// The ticket is the only authorisation the raw-body upload transport
// verifies besides the MCP Bearer [REDACTED] so every failure mode here must fail
// closed: forgery, tamper, expiry, wrong key, and malformed shapes.
// =============================================================

import { describe, expect, it } from "vitest";
import {
  mintUploadTicket,
  signUploadTicket,
  UPLOAD_TICKET_TTL_MS,
  uploadTicketPath,
  verifyUploadTicket,
  UploadTicketError,
} from "./upload-ticket";

const KEY = "test-secret-for-upload-tickets-only";
const OTHER_KEY = "a-different-signing-key";

const INPUT = { projectId: "proj_1", kind: "image", name: "hero.webp" };

describe("upload tickets", () => {
  it("round-trips a minted ticket", () => {
    const { ticket, expiresAt } = mintUploadTicket(INPUT, KEY, 1_000_000);
    const payload = verifyUploadTicket(ticket, KEY, 1_000_000);
    expect(payload).toEqual({
      ...INPUT,
      exp: Math.floor((1_000_000 + UPLOAD_TICKET_TTL_MS) / 1000),
    });
    expect(new Date(expiresAt).getTime()).toBe(
      (Math.floor((1_000_000 + UPLOAD_TICKET_TTL_MS) / 1000)) * 1000,
    );
  });

  it("expires ~15 minutes after minting", () => {
    expect(UPLOAD_TICKET_TTL_MS).toBe(15 * 60 * 1000);
    const { ticket } = mintUploadTicket(INPUT, KEY, 0);
    expect(() =>
      verifyUploadTicket(ticket, KEY, UPLOAD_TICKET_TTL_MS + 1000),
    ).toThrowError(UploadTicketError);
  });

  it("rejects a ticket signed with a different key", () => {
    const { ticket } = mintUploadTicket(INPUT, KEY);
    expect(() => verifyUploadTicket(ticket, OTHER_KEY)).toThrowError(
      expect.objectContaining({ code: "invalid_signature" }),
    );
  });

  it("rejects a tampered payload (kind swap)", () => {
    const { ticket } = mintUploadTicket(INPUT, KEY);
    const [body, sig] = ticket.split(".");
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as Record<string, unknown>;
    payload.kind = "video";
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(() => verifyUploadTicket(tampered, KEY)).toThrowError(
      expect.objectContaining({ code: "invalid_signature" }),
    );
  });

  it("rejects malformed shapes", () => {
    for (const bad of ["", "no-dot", "a.b.c", ".sig", "body."]) {
      expect(() => verifyUploadTicket(bad, KEY)).toThrowError(
        expect.objectContaining({ code: "malformed" }),
      );
    }
  });

  it("rejects a well-signed payload missing required fields", () => {
    const bad = signUploadTicket(
      { projectId: "", kind: "image", name: "x", exp: 9_999_999_999 },
      KEY,
    );
    expect(() => verifyUploadTicket(bad, KEY)).toThrowError(
      expect.objectContaining({ code: "malformed_payload" }),
    );
  });

  it("uses one shared upload path for stage tools and the route", () => {
    expect(uploadTicketPath("image")).toBe("/mcp/uploads/image");
    expect(uploadTicketPath("video")).toBe("/mcp/uploads/video");
    expect(uploadTicketPath("lottie")).toBe("/mcp/uploads/lottie");
  });
});
