import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { FONT_FACE_MAX_BYTES, FONT_FACES_MAX_PER_PROJECT } from "@rovenue/shared";

// =============================================================
// POST /dashboard/projects/:projectId/fonts (paywall fonts wave E1,
// Task 3): the product's first multipart endpoint. Auth + capability
// + the fontRepo writes + audit are mocked at module level, mirroring
// paywalls.from-app-store.test.ts's idiom — this exercises the real
// route's HTTP-layer decisions (check order, error codes, response
// shape), not a mock's opinion of them. `detectFontFormat` and the
// FONT_FACE_MAX_BYTES / FONT_FACES_MAX_PER_PROJECT constants below are
// the REAL implementation/values from @rovenue/shared: the point of
// the fourth test is that real magic-byte sniffing overrides the
// filename, so it must not be stubbed.
//
// `drizzle.fontRepo.findLiveFamilyForProject` is mocked directly (fix
// round 2): the familyId ownership/liveness check moved out of this
// route and into fontRepo, where it now has real-Postgres coverage of
// every predicate (packages/db/src/drizzle/repositories/
// fonts.integration.test.ts). Mocking it here means these route tests
// pin the route's *reaction* to found/not-found (status, error code,
// whether upsertFace/createFamily get called), not the query itself —
// that split is deliberate, not a gap.
//
// `drizzle.db.select` is still mocked, but now only backs the one
// remaining inline query: the existing-face lookup that backs the
// quota-skip-on-update fix. That query's shape (not its WHERE clause)
// is an accepted, documented deferred minor — see the task report,
// "still not to be fixed" in fix round 2.
// =============================================================

const assertProjectCapability = vi.hoisted(() => vi.fn());
vi.mock("../../../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    return next();
  },
}));
vi.mock("../../../src/lib/capabilities", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectCapability: (...args: unknown[]) =>
    assertProjectCapability(...args),
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
const transaction = vi.hoisted(() => vi.fn());
// Controllable result set for the one remaining inline `select` query
// (the existing-face lookup). Reset to "no existing face" by default
// in beforeEach; tests that need "this weight/style already exists"
// override it explicitly.
const selectFacesResult = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(selectFacesResult.rows),
      }),
    }),
  });
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
      },
      db: { ...actual.drizzle.db, transaction, select },
    },
  };
});

import { fontsRoute } from "../../../src/routes/dashboard/fonts";
import { errorHandler } from "../../../src/middleware/error";

function app() {
  return new Hono()
    .onError(errorHandler)
    .route("/dashboard/projects/:projectId/fonts", fontsRoute);
}

/** A minimal, but real, OTF-shaped prefix ("OTTO" magic). */
function otfBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x4f, 0x54, 0x54, 0x4f]);
  return bytes;
}

interface UploadFontInput {
  bytes: Uint8Array;
  filename?: string;
  familyName?: string;
  familyId?: string;
  weight: number;
  style: string;
}

async function uploadFont(input: UploadFontInput) {
  const form = new FormData();
  const file = new File(
    [input.bytes as BlobPart],
    input.filename ?? "brand.otf",
    { type: "application/octet-stream" },
  );
  form.set("file", file);
  if (input.familyName !== undefined) {
    form.set("familyName", input.familyName);
  }
  if (input.familyId !== undefined) {
    form.set("familyId", input.familyId);
  }
  form.set("weight", String(input.weight));
  form.set("style", input.style);

  return app().request("/dashboard/projects/p1/fonts", {
    method: "POST",
    body: form,
  });
}

let faceIdCounter = 0;

beforeEach(() => {
  faceIdCounter = 0;
  assertProjectCapability
    .mockReset()
    .mockResolvedValue({ id: "m1", role: "OWNER" });
  auditMock.mockReset().mockResolvedValue(undefined);
  countFacesForProject.mockReset().mockResolvedValue(0);
  createFamily.mockReset().mockImplementation(
    async (_db: unknown, input: { projectId: string; name: string }) => ({
      id: "family1",
      projectId: input.projectId,
      name: input.name,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    }),
  );
  upsertFace.mockReset().mockImplementation(
    async (
      _db: unknown,
      input: {
        familyId: string;
        weight: number;
        style: string;
        format: string;
        bytes: Buffer;
      },
    ) => ({
      id: `face${++faceIdCounter}`,
      familyId: input.familyId,
      weight: input.weight,
      style: input.style,
      format: input.format,
      bytes: input.bytes,
      byteSize: input.bytes.byteLength,
      createdAt: new Date(),
    }),
  );
  transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({}),
    );
  // Default: a familyId, if one is supplied, resolves to a live family
  // with no existing face at the requested weight/style. Tests that
  // need the other branches override these explicitly.
  findLiveFamilyForProject
    .mockReset()
    .mockResolvedValue({ id: "family-existing" });
  selectFacesResult.rows = [];
});

describe("POST /dashboard/projects/:projectId/fonts", () => {
  it("rejects a file whose bytes do not match any allowed format", async () => {
    const res = await uploadFont({
      bytes: new TextEncoder().encode("<html>"),
      familyName: "Brand",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FONT_FORMAT_UNSUPPORTED");
  });

  it("rejects a file over the size cap", async () => {
    const bytes = new Uint8Array(FONT_FACE_MAX_BYTES + 1);
    bytes.set([0x4f, 0x54, 0x54, 0x4f]);
    const res = await uploadFont({
      bytes,
      familyName: "Brand",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FONT_FILE_TOO_LARGE");
  });

  it("rejects an upload past the per-project face cap", async () => {
    // seed FONT_FACES_MAX_PER_PROJECT faces first
    countFacesForProject.mockResolvedValue(FONT_FACES_MAX_PER_PROJECT);
    const res = await uploadFont({
      bytes: otfBytes(),
      familyName: "One More",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FONT_QUOTA_EXCEEDED");
    // The quota gate must run before a new family is created — a
    // rejected upload should never leave a dangling family row.
    expect(createFamily).not.toHaveBeenCalled();
  });

  it("rejects a grossly oversized body at the transport layer, before the handler runs", async () => {
    // fix round 1, review item 3: a body many times over the cap must
    // be bounced by hono/body-limit before parseBody buffers it and
    // before the route handler (and its own file.size check) ever
    // runs. assertProjectCapability not being called is what proves
    // the rejection happened at the body-limit gate, not inside the
    // handler.
    const bytes = new Uint8Array(FONT_FACE_MAX_BYTES * 5);
    bytes.set([0x4f, 0x54, 0x54, 0x4f]);
    const res = await uploadFont({
      bytes,
      familyName: "Brand",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FONT_FILE_TOO_LARGE");
    expect(assertProjectCapability).not.toHaveBeenCalled();
  });

  it("stores the detected format, ignoring the filename", async () => {
    const res = await uploadFont({
      bytes: otfBytes(),
      filename: "brand.ttf",
      familyName: "Brand",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { format: string } };
    expect(body.data.format).toBe("otf");
    expect(upsertFace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: "otf" }),
    );
  });

  // -----------------------------------------------------------
  // familyId branch (fix round 1, review item 2; ownership/liveness
  // query moved to fontRepo.findLiveFamilyForProject in fix round 2).
  // From the route's point of view "foreign project" and "soft-deleted
  // family" both surface as findLiveFamilyForProject resolving null —
  // that collapse happens inside the (now real-Postgres-tested) repo
  // function, not here, so both tests below mock it identically on
  // purpose. What each predicate (projectId ownership, deletedAt)
  // individually does is pinned against a live database in
  // packages/db/src/drizzle/repositories/fonts.integration.test.ts's
  // findLiveFamilyForProject suite, with its own mutation-checked
  // evidence — these route tests exist to pin the route's *reaction*
  // (404 FONT_FAMILY_NOT_FOUND, upsertFace never called), not the
  // query.
  // -----------------------------------------------------------

  it("404s with FONT_FAMILY_NOT_FOUND when familyId belongs to another project", async () => {
    findLiveFamilyForProject.mockResolvedValue(null);
    const res = await uploadFont({
      bytes: otfBytes(),
      familyId: "foreign-family",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("FONT_FAMILY_NOT_FOUND");
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("404s with FONT_FAMILY_NOT_FOUND when familyId's family is soft-deleted", async () => {
    findLiveFamilyForProject.mockResolvedValue(null);
    const res = await uploadFont({
      bytes: otfBytes(),
      familyId: "deleted-family",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("FONT_FAMILY_NOT_FOUND");
    expect(upsertFace).not.toHaveBeenCalled();
  });

  it("attaches a face to an existing, owned, live family via familyId", async () => {
    findLiveFamilyForProject.mockResolvedValue({ id: "family-existing" });
    selectFacesResult.rows = [];
    const res = await uploadFont({
      bytes: otfBytes(),
      familyId: "family-existing",
      weight: 700,
      style: "italic",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { familyId: string } };
    expect(body.data.familyId).toBe("family-existing");
    expect(createFamily).not.toHaveBeenCalled();
    expect(upsertFace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        familyId: "family-existing",
        weight: 700,
        style: "italic",
      }),
    );
  });

  // -----------------------------------------------------------
  // Quota-skip-on-update (fix round 1, review item 4 / human ruling):
  // upsertFace REPLACES an existing (familyId, weight, style) rather
  // than inserting, so it must not be blocked by the face cap.
  // -----------------------------------------------------------

  it("allows re-uploading an existing (familyId, weight, style) even at the face cap", async () => {
    countFacesForProject.mockResolvedValue(FONT_FACES_MAX_PER_PROJECT);
    findLiveFamilyForProject.mockResolvedValue({ id: "family-existing" });
    selectFacesResult.rows = [{ id: "face-existing" }];
    const res = await uploadFont({
      bytes: otfBytes(),
      familyId: "family-existing",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(200);
    // The quota query must be skipped entirely, not merely tolerated —
    // it's mocked to report "at cap" specifically to prove this isn't
    // an accidental pass from an unset default.
    expect(countFacesForProject).not.toHaveBeenCalled();
  });

  it("still rejects a genuinely new (weight, style) at the face cap", async () => {
    countFacesForProject.mockResolvedValue(FONT_FACES_MAX_PER_PROJECT);
    findLiveFamilyForProject.mockResolvedValue({ id: "family-existing" });
    selectFacesResult.rows = [];
    const res = await uploadFont({
      bytes: otfBytes(),
      familyId: "family-existing",
      weight: 900,
      style: "italic",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FONT_QUOTA_EXCEEDED");
    expect(upsertFace).not.toHaveBeenCalled();
  });
});
