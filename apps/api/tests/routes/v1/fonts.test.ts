import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { FONT_FILE_CACHE_MAX_AGE_SECONDS } from "@rovenue/shared";

// =============================================================
// GET /v1/fonts/:faceId/:contentHash/file (paywall fonts wave E1,
// Task 5 + Task 7)
// =============================================================
//
// Mounts the REAL `apiKeyAuth("any")` middleware ahead of `fontsRoute`
// — mirroring tests/placements-events.integration.test.ts and
// tests/v1-offerings.test.ts — rather than hand-setting a `project`
// context via a shim middleware (the lighter idiom used by
// v1-experiments-expose.test.ts, which deliberately bypasses
// apiKeyAuth to dodge Redis). This route's whole point is device auth
// via a project's public key, so these tests exercise the real
// middleware: only `apiKeyRepo.findApiKeyByPublic` is mocked (mapping
// a raw key string to a project), which means "refuses a key from
// another project" genuinely proves apiKeyAuth resolved a DIFFERENT
// `project.id` from a different key — not something this test file
// wired by hand. It also proves the mount actually applies apiKeyAuth
// to this route: an unmocked/garbage key is rejected by the real
// middleware before the handler ever runs.
//
// `drizzle.fontRepo.findFaceBytes` is mocked, not real Postgres — its
// own deleted-family predicate is pinned for real in
// packages/db/src/drizzle/repositories/fonts.integration.test.ts. This
// file pins the ROUTE's reaction (200/404, headers, byte-for-byte
// body), not that query.
//
// Task 7: the URL now carries the face's content hash
// (`/:faceId/:contentHash/file`), so `immutable` caching is honest even
// though `upsertFace` replaces bytes in place under the same face id.
// The mock's `contentHash` here is a REAL sha256 of `uploadedBytes`
// (not a fixture string) so the "correct hash" test can't pass by
// coincidence, and a mismatched-hash test genuinely exercises the
// comparison rather than two accidentally-equal fixtures.

const PROJECT_ID = "proj_test";
const OTHER_PROJECT_ID = "proj_other";
const PUBLIC_KEY = "rov_pub_test_project_key";
const OTHER_PUBLIC_KEY = "rov_pub_other_project_key";
const FACE_ID = "face_1";

/** A minimal, but real, OTF-shaped prefix ("OTTO" magic) plus some
 *  varied trailing bytes so a length-only comparison couldn't pass. */
function otfBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x4f, 0x54, 0x54, 0x4f]);
  for (let i = 4; i < bytes.length; i++) bytes[i] = i * 7;
  return bytes;
}

const uploadedBytes = otfBytes();
const CONTENT_HASH = createHash("sha256").update(uploadedBytes).digest("hex");
// A well-formed hash of DIFFERENT bytes — stands in for "the face was
// re-uploaded since this URL was minted" (Task 7's stale-hash case).
const STALE_HASH = createHash("sha256")
  .update(new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0xff]))
  .digest("hex");

const apiKeyRecords: Record<
  string,
  {
    id: string;
    project: { id: string; name: string };
    keySecretHash: string;
    revokedAt: null;
    expiresAt: null;
  }
> = {
  [PUBLIC_KEY]: {
    id: "key_1",
    project: { id: PROJECT_ID, name: "Test" },
    keySecretHash: "n/a",
    revokedAt: null,
    expiresAt: null,
  },
  [OTHER_PUBLIC_KEY]: {
    id: "key_2",
    project: { id: OTHER_PROJECT_ID, name: "Other" },
    keySecretHash: "n/a",
    revokedAt: null,
    expiresAt: null,
  },
};

const findApiKeyByPublic = vi.hoisted(() => vi.fn());
const findApiKeyById = vi.hoisted(() => vi.fn());
const updateApiKeyLastUsed = vi.hoisted(() => vi.fn());
const findFaceBytes = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      apiKeyRepo: {
        ...actual.drizzle.apiKeyRepo,
        findApiKeyByPublic,
        findApiKeyById,
        updateApiKeyLastUsed,
      },
      fontRepo: {
        ...actual.drizzle.fontRepo,
        findFaceBytes,
      },
    },
  };
});

import { apiKeyAuth } from "../../../src/middleware/api-key-auth";
import { errorHandler } from "../../../src/middleware/error";
import { fontsRoute } from "../../../src/routes/v1/fonts";

function app() {
  return new Hono()
    .onError(errorHandler)
    .use("*", apiKeyAuth("any"))
    .route("/v1/fonts", fontsRoute);
}

function getFaceFile(
  faceId: string,
  contentHash: string,
  opts?: { key?: string },
) {
  return app().request(`/v1/fonts/${faceId}/${contentHash}/file`, {
    headers: { authorization: `Bearer ${opts?.key ?? PUBLIC_KEY}` },
  });
}

// Test-local state standing in for "the face's family got soft-deleted" —
// findFaceBytes is mocked, so this flips what the mock returns rather
// than touching a real family row (that predicate is pinned against
// real Postgres elsewhere; see the file banner above).
let familyDeleted = false;
function deleteFamily(_familyId: string): Promise<void> {
  familyDeleted = true;
  return Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  familyDeleted = false;
  findApiKeyByPublic.mockImplementation(
    async (_db: unknown, keyPublic: string) => apiKeyRecords[keyPublic] ?? null,
  );
  findApiKeyById.mockResolvedValue(null);
  updateApiKeyLastUsed.mockResolvedValue(undefined);
  findFaceBytes.mockImplementation(async (_db: unknown, faceId: string) => {
    if (familyDeleted) return null;
    if (faceId !== FACE_ID) return null;
    return {
      bytes: Buffer.from(uploadedBytes),
      format: "otf",
      projectId: PROJECT_ID,
      contentHash: CONTENT_HASH,
    };
  });
});

describe("GET /v1/fonts/:faceId/:contentHash/file", () => {
  it("serves the bytes with the format's content type", async () => {
    const res = await getFaceFile(FACE_ID, CONTENT_HASH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/otf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(uploadedBytes);
  });

  it("caches immutably, with the ETag equal to the content hash", async () => {
    const res = await getFaceFile(FACE_ID, CONTENT_HASH);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("immutable");
    expect(cc).toContain(`max-age=${FONT_FILE_CACHE_MAX_AGE_SECONDS}`);
    expect(res.headers.get("etag")).toBe(CONTENT_HASH);
  });

  it("404s a stale-but-well-formed hash for a face that has since been re-uploaded", async () => {
    const res = await getFaceFile(FACE_ID, STALE_HASH);
    expect(res.status).toBe(404);
  });

  it("404s a hash belonging to a different face", async () => {
    // FACE_ID's real hash is CONTENT_HASH; requesting some OTHER face's
    // hash against FACE_ID's own faceId must not serve it.
    const otherFaceHash = createHash("sha256")
      .update(new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x01]))
      .digest("hex");
    const res = await getFaceFile(FACE_ID, otherFaceHash);
    expect(res.status).toBe(404);
  });

  it("404s a face whose family was deleted", async () => {
    await deleteFamily("family_1");
    const res = await getFaceFile(FACE_ID, CONTENT_HASH);
    expect(res.status).toBe(404);
  });

  it("refuses a key from another project", async () => {
    const res = await getFaceFile(FACE_ID, CONTENT_HASH, {
      key: OTHER_PUBLIC_KEY,
    });
    expect(res.status).toBe(404);
  });
});
