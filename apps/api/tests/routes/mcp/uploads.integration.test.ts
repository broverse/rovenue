// =============================================================
// MCP staged asset upload — integration (host-run: real Postgres +
// real MinIO, via testcontainers).
//
// Proves the claims the DB-free unit tests cannot:
// - `stage_asset_upload` through the real MCP protocol endpoint mints
//   a ticket + upload URL + expiry for an ADMIN write token, and a
//   `read` token is refused at the route (403, no ticket).
// - POSTing the raw bytes to /mcp/uploads/:kind with the ticket runs
//   the dashboard byte-core for real (row committed, bytes in the
//   bucket, dedup on replay) through the ticketed transport's own
//   auth/scope/role/ticket gates.
// - Cross-project, cross-kind, forged, and missing credentials all
//   fail closed.
//
// What's real: Postgres, MinIO (startMinio), sharp-built PNG bytes,
// the MCP Bearer, the HMAC ticket. The per-request rate limiter is
// left real (volume here is far below the cap).
// =============================================================

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import type { StartedTestContainer } from "testcontainers";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { MCP_TOKEN_PREFIX } from "@rovenue/shared";
import { getDb, projects, drizzle, type MemberRole } from "@rovenue/db";
import { startMinio } from "../../helpers";
import { errorHandler } from "../../../src/middleware/error";
import { MCP_PROTOCOL_REVISION } from "../../../src/services/mcp/server";
import { mcpRoute } from "../../../src/routes/mcp";
import { mcpAssetUploadRoute } from "../../../src/routes/mcp/uploads";

const RUN_ID = Date.now();
const TEST_BCRYPT_ROUNDS = 4;

let minio: StartedTestContainer;
const seededProjectIds: string[] = [];

beforeAll(async () => {
  minio = await startMinio();
}, 120_000);

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
  await minio?.stop();
});

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  // Same mount paths as the production tree (app.ts).
  app.route("/mcp/uploads", mcpAssetUploadRoute);
  app.route("/mcp", mcpRoute);
  return app;
}

async function seedUser(suffix: string) {
  const db = getDb();
  const id = `usr_mcpupload_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.user).values({
    id,
    name: `MCP Upload User ${suffix}`,
    email: `mcpupload_${RUN_ID}_${suffix}@rovenue.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcpupload_${RUN_ID}${suffix}`;
  await db.insert(projects).values({ id, name: `MCP Upload Project ${RUN_ID}${suffix}` });
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
    label: `upload test token ${RUN_ID}`,
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
        [CLIENT_INFO_META_KEY]: { name: "upload-test", version: "0.0.1" },
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
      "mcp-name": "stage_asset_upload",
      authorization: `Bearer ${raw}`,
    },
    body: envelope(2, "tools/call", { name: "stage_asset_upload", arguments: args }),
  });
  return res;
}

async function stagedTicket(raw: string, name: string) {
  const res = await stageUpload(raw, { kind: "image", name });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
  };
  expect(body.result?.isError).not.toBe(true);
  const structured = body.result?.structuredContent as
    | { ticket: string; uploadUrl: string; expiresAt: string }
    | undefined;
  expect(typeof structured?.ticket).toBe("string");
  expect(structured?.uploadUrl).toBe("/mcp/uploads/image");
  return { ticket: structured!.ticket, expiresAt: structured!.expiresAt };
}

// Returns a Uint8Array over a plain ArrayBuffer, not sharp's Buffer. A
// Buffer is typed Buffer<ArrayBufferLike>, which may be backed by a
// SharedArrayBuffer and so is not a BodyInit; the copy narrows the backing
// store instead of casting the type away.
async function realPng(rgb: [number, number, number]): Promise<Uint8Array<ArrayBuffer>> {
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

function upload(
  kind: string,
  // BodyInit, not BlobPart: this goes straight to request() as a body, and
  // sharp hands back Buffer<ArrayBufferLike>, which BlobPart rejects because
  // it may be backed by a SharedArrayBuffer.
  body: BodyInit,
  ticket: string,
  raw?: string,
  contentLength?: number,
) {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  if (raw) headers.authorization = `Bearer ${raw}`;
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return buildApp().request(
    `/mcp/uploads/${kind}?ticket=${encodeURIComponent(ticket)}`,
    { method: "POST", headers, body },
  );
}

describe("MCP staged asset upload", () => {
  it("stages then uploads: 201, row committed, replay dedups to 200", async () => {
    const { raw, projectId } = await seedToken("happy", "read_write", "ADMIN");
    const { ticket } = await stagedTicket(raw, "staged-happy");
    const png = await realPng([11, 22, 33]);

    const first = await upload("image", png, ticket, raw, png.byteLength);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data?: { id?: string; url?: string } };
    expect(typeof firstBody.data?.id).toBe("string");
    expect(typeof firstBody.data?.url).toBe("string");

    const listed = await drizzle.assetRepo.listAssets(drizzle.db, projectId);
    expect(listed.map((a) => a.id)).toContain(firstBody.data?.id);

    // Replay: same ticket, same bytes → the existing row, HTTP 200,
    // no second row and no second quota charge.
    const before = listed.length;
    const second = await upload("image", png, ticket, raw, png.byteLength);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data?: { id?: string } };
    expect(secondBody.data?.id).toBe(firstBody.data?.id);
    const after = await drizzle.assetRepo.listAssets(drizzle.db, projectId);
    expect(after.length).toBe(before);
  });

  it("refuses staging to a read-only token with no side effects", async () => {
    const { raw } = await seedToken("readonly", "read", "OWNER");
    const res = await stageUpload(raw, { kind: "image", name: "nope" });
    expect(res.status).toBe(403);
  });

  it("refuses the upload without a token, with a read token, and for a non-ADMIN role", async () => {
    const admin = await seedToken("gatesadmin", "read_write", "ADMIN");
    const staged = await stagedTicket(admin.raw, "gate-bytes");
    const png = await realPng([44, 55, 66]);

    expect((await upload("image", png, staged.ticket, undefined, png.byteLength)).status).toBe(
      401,
    );

    const { raw: readRaw } = await seedToken("gatesread", "read", "ADMIN", admin.projectId);
    expect(
      (await upload("image", png, staged.ticket, readRaw, png.byteLength)).status,
    ).toBe(403);

    const { raw: devRaw } = await seedToken(
      "gatesdev",
      "read_write",
      "DEVELOPER",
      admin.projectId,
    );
    expect((await upload("image", png, staged.ticket, devRaw, png.byteLength)).status).toBe(
      403,
    );
  });

  it("binds the ticket to its project and kind, and rejects forgeries", async () => {
    const a = await seedToken("bindA", "read_write", "ADMIN");
    const b = await seedToken("bindB", "read_write", "ADMIN");
    const staged = await stagedTicket(a.raw, "bound");
    const png = await realPng([77, 88, 99]);

    // Another project's token, even valid, cannot spend this ticket.
    expect((await upload("image", png, staged.ticket, b.raw, png.byteLength)).status).toBe(
      403,
    );
    // Nor can the ticket cross kinds.
    expect((await upload("video", png, staged.ticket, a.raw, png.byteLength)).status).toBe(
      400,
    );
    // Nor can a tampered ticket pass the HMAC.
    const [body, sig] = staged.ticket.split(".");
    const forged = `${body}x.${sig}`;
    expect((await upload("image", png, forged, a.raw, png.byteLength)).status).toBe(401);
    // Missing ticket entirely.
    expect((await upload("image", png, "", a.raw, png.byteLength)).status).toBe(401);
  });
});
