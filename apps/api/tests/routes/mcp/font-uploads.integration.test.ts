// =============================================================
// MCP staged font upload — integration (host-run: real Postgres,
// via testcontainers).
//
// Proves the claims the DB-free unit tests cannot:
// - `stage_font_upload` through the real MCP protocol endpoint mints
//   a ticket + upload URL + expiry for an ADMIN write token, and a
//   `read` token is refused at the route (403, no ticket).
// - POSTing the raw bytes to /mcp/font-uploads/font with the ticket
//   runs the dashboard font byte-core for real (family + face
//   committed, audit written, upsert on replay) through the ticketed
//   transport's own auth/scope/role/ticket gates.
// - Cross-project, cross-kind, forged, and missing credentials all
//   fail closed.
//
// What's real: Postgres, real OTF-magic bytes, the MCP Bearer, the
// HMAC ticket. Fonts persist to Postgres `bytea` (no object storage),
// so no MinIO here — unlike the asset upload suite. The per-request
// rate limiter is left real (volume here is far below the cap).
// =============================================================

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { MCP_TOKEN_PREFIX } from "@rovenue/shared";
import { getDb, projects, drizzle, type MemberRole } from "@rovenue/db";
import { errorHandler } from "../../../src/middleware/error";
import { MCP_PROTOCOL_REVISION } from "../../../src/services/mcp/server";
import { mcpRoute } from "../../../src/routes/mcp";
import { mcpFontUploadRoute } from "../../../src/routes/mcp/font-uploads";
import { getUploadTicketKey, mintUploadTicket } from "../../../src/lib/upload-ticket";

const RUN_ID = Date.now();
const TEST_BCRYPT_ROUNDS = 4;

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  // Same mount paths as the production tree (app.ts).
  app.route("/mcp/font-uploads", mcpFontUploadRoute);
  app.route("/mcp", mcpRoute);
  return app;
}

async function seedUser(suffix: string) {
  const db = getDb();
  const id = `usr_mcpfont_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.user).values({
    id,
    name: `MCP Font User ${suffix}`,
    email: `mcpfont_${RUN_ID}_${suffix}@rovenue.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcpfont_${RUN_ID}${suffix}`;
  await db.insert(projects).values({ id, name: `MCP Font Project ${RUN_ID}${suffix}` });
  seededProjectIds.push(id);
  return { id };
}

async function seedToken(
  suffix: string,
  scope: "read" | "read_write",
  role: MemberRole,
  projectId?: string,
) {
  // A fresh user per token, so the membership role is exactly `role` —
  // the ADMIN gate reads the live membership, never the token.
  const project = projectId ? { id: projectId } : await seedProject(suffix);
  const user = await seedUser(suffix);
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId: project.id,
    userId: user.id,
    role,
  });
  const tokenId = createId();
  const raw = `${MCP_TOKEN_PREFIX}${tokenId}_${randomBytes(16).toString("base64url")}`;
  await drizzle.mcpTokenRepo.create(drizzle.db, {
    id: tokenId,
    projectId: project.id,
    userId: user.id,
    label: `font upload test token ${RUN_ID}`,
    scope,
    keyPublic: `${MCP_TOKEN_PREFIX}${tokenId}`,
    keySecretHash: await bcrypt.hash(raw, TEST_BCRYPT_ROUNDS),
    expiresAt: null,
  });
  return { raw, projectId: project.id, userId: user.id };
}

function envelope(id: number, method: string, params: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...(params as Record<string, unknown>),
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_REVISION,
        [CLIENT_INFO_META_KEY]: { name: "font-upload-test", version: "0.0.1" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
}

async function stageUpload(raw: string, args: unknown) {
  const res = await buildApp().request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "tools/call",
      "mcp-name": "stage_font_upload",
      authorization: `Bearer ${raw}`,
    },
    body: envelope(2, "tools/call", { name: "stage_font_upload", arguments: args }),
  });
  return res;
}

async function stagedTicket(raw: string, args: unknown) {
  const res = await stageUpload(raw, args);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
  };
  expect(body.result?.isError).not.toBe(true);
  const structured = body.result?.structuredContent as
    | { ticket: string; uploadUrl: string; expiresAt: string }
    | undefined;
  expect(typeof structured?.ticket).toBe("string");
  expect(structured?.uploadUrl).toBe("/mcp/font-uploads/font");
  return { ticket: structured!.ticket, expiresAt: structured!.expiresAt };
}

/** Real OTF-magic bytes (the route sniffs magic, never the name). */
function otfBytes(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(64).fill(seed);
  bytes.set([0x4f, 0x54, 0x54, 0x4f]);
  return bytes;
}

function upload(body: BodyInit, ticket: string, raw?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  if (raw) headers.authorization = `Bearer ${raw}`;
  return buildApp().request(
    `/mcp/font-uploads/font?ticket=${encodeURIComponent(ticket)}`,
    { method: "POST", headers, body },
  );
}

describe("MCP staged font upload", () => {
  it("stages then uploads: 200, face committed, replay upserts to the same face", async () => {
    const { raw, projectId } = await seedToken("happy", "read_write", "ADMIN");
    const family = await drizzle.fontRepo.createFamily(drizzle.db, {
      projectId,
      name: "Brand Sans",
    });
    const { ticket } = await stagedTicket(raw, {
      familyId: family.id,
      weight: 400,
      style: "normal",
    });
    const bytes = otfBytes(7);

    const first = await upload(bytes, ticket, raw);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data?: { id?: string; familyId?: string; format?: string; fileUrl?: string };
    };
    expect(typeof firstBody.data?.id).toBe("string");
    expect(firstBody.data?.familyId).toBe(family.id);
    expect(firstBody.data?.format).toBe("otf");
    expect(typeof firstBody.data?.fileUrl).toBe("string");

    const listed = await drizzle.fontRepo.listFamiliesWithFaces(drizzle.db, projectId);
    expect(listed.flatMap((f) => f.faces.map((face) => face.id))).toContain(
      firstBody.data?.id,
    );

    // Replay: same ticket, same bytes → the same face row, no second
    // face and no quota growth.
    const before = await drizzle.fontRepo.countFacesForProject(drizzle.db, projectId);
    const second = await upload(bytes, ticket, raw);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data?: { id?: string } };
    expect(secondBody.data?.id).toBe(firstBody.data?.id);
    expect(await drizzle.fontRepo.countFacesForProject(drizzle.db, projectId)).toBe(
      before,
    );
  });

  it("stages a new family by name and mints a fresh family", async () => {
    const { raw, projectId } = await seedToken("byname", "read_write", "ADMIN");
    const { ticket } = await stagedTicket(raw, {
      familyName: "Display Serif",
      weight: 700,
      style: "italic",
    });
    const res = await upload(otfBytes(9), ticket, raw);
    expect(res.status).toBe(200);
    const listed = await drizzle.fontRepo.listFamiliesWithFaces(drizzle.db, projectId);
    expect(listed.map((f) => f.name)).toContain("Display Serif");
  });

  it("refuses staging to a read-only token with no side effects", async () => {
    const { raw } = await seedToken("readonly", "read", "OWNER");
    const res = await stageUpload(raw, {
      familyName: "Nope",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(403);
  });

  it("refuses the upload without a token, with a read token, and for a non-ADMIN role", async () => {
    const admin = await seedToken("gatesadmin", "read_write", "ADMIN");
    const staged = await stagedTicket(admin.raw, {
      familyName: "Gate Sans",
      weight: 400,
      style: "normal",
    });
    const bytes = otfBytes(11);

    expect((await upload(bytes, staged.ticket, undefined)).status).toBe(401);

    const { raw: readRaw } = await seedToken("gatesread", "read", "ADMIN", admin.projectId);
    expect((await upload(bytes, staged.ticket, readRaw)).status).toBe(403);

    const { raw: devRaw } = await seedToken(
      "gatesdev",
      "read_write",
      "DEVELOPER",
      admin.projectId,
    );
    expect((await upload(bytes, staged.ticket, devRaw)).status).toBe(403);
  });

  it("binds the ticket to its project and kind, and rejects forgeries", async () => {
    const a = await seedToken("bindA", "read_write", "ADMIN");
    const b = await seedToken("bindB", "read_write", "ADMIN");
    const staged = await stagedTicket(a.raw, {
      familyName: "Bound Sans",
      weight: 400,
      style: "normal",
    });
    const bytes = otfBytes(13);

    // Another project's token, even valid, cannot spend this ticket.
    expect((await upload(bytes, staged.ticket, b.raw)).status).toBe(403);
    // Nor can a ticket staged for an asset kind upload a font. Minted
    // directly rather than by calling stage_asset_upload through the MCP
    // endpoint: that tool checks asset storage is configured before it mints
    // anything, so on a runner with no MinIO it answers with an error
    // envelope and the old code read `.ticket` off an undefined `result`.
    // The claim under test is the ticket's `kind` binding, which does not
    // involve storage at all — this mints exactly what stage_asset_upload
    // would, with the same helper and key the route verifies against.
    const { ticket: assetTicket } = mintUploadTicket(
      { projectId: a.projectId, kind: "image", name: "hero.webp" },
      getUploadTicketKey(),
    );
    expect((await upload(bytes, assetTicket, a.raw)).status).toBe(400);
    // Nor can a tampered ticket pass the HMAC.
    const [bodyPart, sig] = staged.ticket.split(".");
    const forged = `${bodyPart}x.${sig}`;
    expect((await upload(bytes, forged, a.raw)).status).toBe(401);
    // Missing ticket entirely.
    expect((await upload(bytes, "", a.raw)).status).toBe(401);
  });
});
