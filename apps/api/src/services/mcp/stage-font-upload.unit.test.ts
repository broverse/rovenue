// =============================================================
// MCP staged font upload — DB-free unit coverage.
//
// Pins the pieces that need no database: the dashboard-owned
// locator validation the stage tool and the ticket transport share,
// the stage preview, the ticket-name encode/decode round-trip, and
// the HMAC ticket round-trip (explicit test key — never env).
//
// The propose/confirm flow itself is covered by
// font-uploads.integration.test.ts (host-run, needs Postgres). The
// route gates are covered by tests/routes/mcp/font-uploads.test.ts
// (mocked, first-pass).
// =============================================================

import { describe, expect, it } from "vitest";
import { fontLocatorSchema } from "../../routes/dashboard/fonts";
import {
  decodeFontTicketName,
  encodeFontTicketName,
  FONT_UPLOAD_TICKET_KIND,
  FONT_UPLOAD_URL_PATH,
} from "../../routes/mcp/font-uploads";
import {
  signUploadTicket,
  verifyUploadTicket,
} from "../../lib/upload-ticket";
import { buildFontStagePreview } from "./write-tools";

const TEST_TICKET_KEY = "unit-test-upload-ticket-key";

describe("font locator schema (dashboard parity)", () => {
  it("accepts the familyName branch", () => {
    expect(
      fontLocatorSchema.safeParse({
        familyName: "Brand Sans",
        weight: 400,
        style: "normal",
      }).success,
    ).toBe(true);
  });

  it("accepts the familyId branch", () => {
    expect(
      fontLocatorSchema.safeParse({
        familyId: "fam_1",
        weight: 700,
        style: "italic",
      }).success,
    ).toBe(true);
  });

  it("rejects both or neither family selector", () => {
    expect(
      fontLocatorSchema.safeParse({
        familyName: "A",
        familyId: "fam_1",
        weight: 400,
        style: "normal",
      }).success,
    ).toBe(false);
    expect(
      fontLocatorSchema.safeParse({ weight: 400, style: "normal" }).success,
    ).toBe(false);
  });

  it("rejects out-of-range, non-integer, and non-numeric weights", () => {
    for (const weight of [50, 950, 400.5, "400", null]) {
      expect(
        fontLocatorSchema.safeParse({
          familyName: "A",
          weight,
          style: "normal",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an unknown style and an empty family name", () => {
    expect(
      fontLocatorSchema.safeParse({
        familyName: "A",
        weight: 400,
        style: "oblique",
      }).success,
    ).toBe(false);
    expect(
      fontLocatorSchema.safeParse({
        familyName: "",
        weight: 400,
        style: "normal",
      }).success,
    ).toBe(false);
  });
});

describe("font stage preview", () => {
  it("names the family, weight, and style", () => {
    const preview = buildFontStagePreview({
      familyName: "Brand Sans",
      weight: 700,
      style: "italic",
    });
    expect(preview.title).toContain("Brand Sans");
    expect(preview.fields).toContainEqual({ label: "Family", after: "Brand Sans" });
    expect(preview.fields).toContainEqual({ label: "Weight", after: "700" });
    expect(preview.fields).toContainEqual({ label: "Style", after: "italic" });
  });

  it("renders the familyId branch", () => {
    const preview = buildFontStagePreview({
      familyId: "fam_1",
      weight: 400,
      style: "normal",
    });
    expect(preview.title).toContain("fam_1");
    expect(preview.fields).toContainEqual({ label: "Family", after: "fam_1" });
  });
});

describe("font ticket name codec", () => {
  it("round-trips the familyName branch", () => {
    const locator = { familyName: "Brand Sans", weight: 400, style: "normal" as const };
    expect(decodeFontTicketName(encodeFontTicketName(locator))).toEqual(locator);
  });

  it("round-trips the familyId branch", () => {
    const locator = { familyId: "fam_1", weight: 700, style: "italic" as const };
    expect(decodeFontTicketName(encodeFontTicketName(locator))).toEqual(locator);
  });

  it("rejects garbage and schema-violating payloads", () => {
    expect(decodeFontTicketName("not-json")).toBeNull();
    expect(decodeFontTicketName(JSON.stringify({ kind: "image" }))).toBeNull();
    expect(
      decodeFontTicketName(
        JSON.stringify({ familyName: "A", weight: 50, style: "normal" }),
      ),
    ).toBeNull();
    expect(
      decodeFontTicketName(
        JSON.stringify({ familyName: "A", familyId: "fam_1", weight: 400, style: "normal" }),
      ),
    ).toBeNull();
  });
});

describe("font upload ticket (shared HMAC infra)", () => {
  it("mints and verifies a font ticket with an explicit key", () => {
    const locator = { familyName: "Brand Sans", weight: 400, style: "normal" as const };
    const ticket = signUploadTicket(
      {
        projectId: "prj_1",
        kind: FONT_UPLOAD_TICKET_KIND,
        name: encodeFontTicketName(locator),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_TICKET_KEY,
    );
    const payload = verifyUploadTicket(ticket, TEST_TICKET_KEY);
    expect(payload.projectId).toBe("prj_1");
    expect(payload.kind).toBe(FONT_UPLOAD_TICKET_KIND);
    expect(decodeFontTicketName(payload.name)).toEqual(locator);
  });

  it("rejects a tampered ticket", () => {
    const ticket = signUploadTicket(
      {
        projectId: "prj_1",
        kind: FONT_UPLOAD_TICKET_KIND,
        name: encodeFontTicketName({
          familyName: "Brand Sans",
          weight: 400,
          style: "normal" as const,
        }),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_TICKET_KEY,
    );
    const [body, sig] = ticket.split(".");
    expect(() => verifyUploadTicket(`${body}x.${sig}`, TEST_TICKET_KEY)).toThrow();
  });

  it("hands out the mounted transport path", () => {
    expect(FONT_UPLOAD_URL_PATH).toBe("/mcp/font-uploads/font");
  });
});
