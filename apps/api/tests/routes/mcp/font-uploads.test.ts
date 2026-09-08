// =============================================================
// POST /mcp/font-uploads/font (staged font upload, Task: fonts
// group). Auth + capability + fontRepo + audit are mocked at module
// level, mirroring fonts.test.ts / assets.test.ts idiom: this
// exercises the real route's HTTP-layer decisions (Bearer/scope/
// role/ticket gate order, error codes, response shape), not a mock's
// opinion of them. `detectFontFormat` runs REAL (magic bytes decide
// the format, never a stub), and the HMAC ticket mint/verify below
// are the REAL lib/upload-ticket implementations against the test
// secret — only the ticket SIGNING KEY lookup is real env, which the
// test setup seeds.
// =============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { FONT_FACE_MAX_BYTES } from "@rovenue/shared";

const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/project-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectAccess: (...args: unknown[]) => assertProjectAccess(...args),
}));

const assertProjectCapability = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/capabilities", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectCapability: (...args: unknown[]) =>
    assertProjectCapability(...args),
}));

// Rate limiting touches Redis for real; mocked as a pass-through so
// these tests never need a live Redis (matches assets.test.ts).
vi.mock("../../../src/middleware/rate-limit", () => ({
  endpointRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

const verifyMcpToken = vi.hoisted(() => vi.fn());
vi.mock("../../../src/routes/mcp/auth", () => ({
  verifyMcpToken: (...args: unknown[]) => verifyMcpToken(...args),
}));

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  audit: (...args: unknown[]) => auditMock(...args),
}));

const countFacesForProject = vi.hoisted(() => vi.fn());
const createFamily = vi.hoisted(() => vi.fn());
const upsertFace = vi.hoisted(() => vi.fn());
const findLiveFamilyForProject = vi.hoisted(() => vi.fn());
const findFaceByKey = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      fontRepo: {
        ...actual.drizzle.fontRepo,
        countFacesForProject,
        createFamily,
        upsertFace,
        findLiveFamilyForProject,
        findFaceByKey,
      },
      db: { ...actual.drizzle.db, transaction },
    },
  };
});

import { mcpFontUploadRoute } from "../../../src/routes/mcp/font-uploads";
import {
  encodeFontTicketName,
  FONT_UPLOAD_TICKET_KIND,
} from "../../../src/routes/mcp/font-uploads";
import {
  getUploadTicketKey,
  mintUploadTicket,
  signUploadTicket,
} from "../../../src/lib/upload-ticket";
import { errorHandler } from "../../../src/middleware/error";

function app() {
  return new Hono().onError(errorHandler).route("/mcp/font-uploads", mcpFontUploadRoute);
}

/** A minimal, but real, OTF-shaped body ("OTTO" magic). */
function otfBytes(size = 16): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0x4f, 0x54, 0x54, 0x4f]);
  return bytes;
}

const PROJECT_ID = "prj_fontmcp";
const USER_ID = "usr_fontmcp";

function bearer() {
  return { authorization: "Bearer test-mcp-token" };
}

function stagedTicket(name: string, projectId = PROJECT_ID) {
  return mintUploadTicket({ projectId, kind: FONT_UPLOAD_TICKET_KIND, name }, getUploadTicketKey())
    .ticket;
}

function familyNameTicket() {
  return stagedTicket(
    encodeFontTicketName({ familyName: "Brand Sans", weight: 400, style: "normal" }),
  );
}

function upload(ticket: string, body: BodyInit, headers: Record<string, string> = {}) {
  return app().request(
    `/mcp/font-uploads/font?ticket=${encodeURIComponent(ticket)}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...bearer(), ...headers },
      body,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The happy-path identity: a read_write ADMIN token. Individual
  // tests override one gate at a time.
  verifyMcpToken.mockResolvedValue({
    tokenId: "tok_1",
    projectId: PROJECT_ID,
    userId: USER_ID,
    scope: "read_write",
  });
  assertProjectAccess.mockResolvedValue({ id: "m1", role: "ADMIN" });
  assertProjectCapability.mockResolvedValue({ id: "m1", role: "ADMIN" });
  findLiveFamilyForProject.mockResolvedValue({ id: "fam_1" });
  findFaceByKey.mockResolvedValue(null);
  countFacesForProject.mockResolvedValue(0);
  createFamily.mockImplementation(async (_tx: unknown, input: { name: string }) => ({
    id: "fam_new",
    projectId: PROJECT_ID,
    name: input.name,
  }));
  upsertFace.mockImplementation(
    async (
      _tx: unknown,
      input: { familyId: string; weight: number; style: string; format: string; bytes: Buffer },
    ) => ({
      id: "face_1",
      familyId: input.familyId,
      weight: input.weight,
      style: input.style,
      format: input.format,
      byteSize: input.bytes.byteLength,
      contentHash: "hash_1",
    }),
  );
  transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ __tx: "font-mcp-tx" }),
  );
  auditMock.mockResolvedValue(undefined);
});

describe("MCP ticketed font upload gates", () => {
  it("401s without a token and never reaches the ticket check", async () => {
    const res = await app().request(
      `/mcp/font-uploads/font?ticket=${encodeURIComponent(familyNameTicket())}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: otfBytes(),
      },
    );
    expect(res.status).toBe(401);
    expect(verifyMcpToken).not.toHaveBeenCalled();
  });

  it("403s a read-scope token before any ticket or pipeline work", async () => {
    verifyMcpToken.mockResolvedValue({
      tokenId: "tok_1",
      projectId: PROJECT_ID,
      userId: USER_ID,
      scope: "read",
    });
    const res = await upload(familyNameTicket(), otfBytes());
    expect(res.status).toBe(403);
    expect(assertProjectAccess).not.toHaveBeenCalled();
  });

  it("403s a non-ADMIN role (the MCP write tier)", async () => {
    // The real gate throws HTTPException — reject with the same shape
    // so the error handler maps it to 403 rather than 500.
    assertProjectAccess.mockRejectedValue(new HTTPException(403));
    const res = await upload(familyNameTicket(), otfBytes());
    expect(res.status).toBe(403);
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("401s a forged ticket and a missing ticket", async () => {
    const good = familyNameTicket();
    const [body, sig] = good.split(".");
    expect((await upload(`${body}x.${sig}`, otfBytes())).status).toBe(401);
    expect((await upload("", otfBytes())).status).toBe(401);
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("403s a ticket staged for another project", async () => {
    const foreign = stagedTicket(
      encodeFontTicketName({ familyName: "Brand Sans", weight: 400, style: "normal" }),
      "prj_other",
    );
    expect((await upload(foreign, otfBytes())).status).toBe(403);
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("400s a ticket staged for another upload kind", async () => {
    const assetTicket = mintUploadTicket(
      { projectId: PROJECT_ID, kind: "image", name: "hero.webp" },
      getUploadTicketKey(),
    ).ticket;
    expect((await upload(assetTicket, otfBytes())).status).toBe(400);
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("401s an expired ticket", async () => {
    const expired = signUploadTicket(
      {
        projectId: PROJECT_ID,
        kind: FONT_UPLOAD_TICKET_KIND,
        name: encodeFontTicketName({
          familyName: "Brand Sans",
          weight: 400,
          style: "normal",
        }),
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      getUploadTicketKey(),
    );
    expect((await upload(expired, otfBytes())).status).toBe(401);
  });
});

describe("MCP ticketed font upload pipeline", () => {
  it("commits the face through the font byte-core and audits", async () => {
    const res = await upload(familyNameTicket(), otfBytes());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; familyId: string; format: string; fileUrl: string };
    };
    expect(body.data.id).toBe("face_1");
    expect(body.data.familyId).toBe("fam_new");
    expect(body.data.format).toBe("otf");
    expect(typeof body.data.fileUrl).toBe("string");
    // The dashboard capability is re-checked at confirm time, and the
    // commit is audited exactly like the dashboard's.
    expect(assertProjectCapability).toHaveBeenCalledWith(
      PROJECT_ID,
      USER_ID,
      "fonts:write",
    );
    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditArg = auditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditArg).toMatchObject({
      projectId: PROJECT_ID,
      userId: USER_ID,
      action: "font.uploaded",
      resource: "font_face",
      resourceId: "face_1",
    });
  });

  it("400s bytes that match no font format (real magic-byte check)", async () => {
    const res = await upload(familyNameTicket(), new Uint8Array([1, 2, 3, 4, 5]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FONT_FORMAT_UNSUPPORTED");
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("404s a familyId ticket for a deleted or foreign family", async () => {
    findLiveFamilyForProject.mockResolvedValue(null);
    const ticket = stagedTicket(
      encodeFontTicketName({ familyId: "fam_gone", weight: 400, style: "normal" }),
    );
    const res = await upload(ticket, otfBytes());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FONT_FAMILY_NOT_FOUND");
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("400s an oversized body at the transport layer with the dashboard code", async () => {
    const res = await upload(familyNameTicket(), otfBytes(FONT_FACE_MAX_BYTES + 1));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FONT_FILE_TOO_LARGE");
    expect(upsertFace).not.toHaveBeenCalled();
  });
});
