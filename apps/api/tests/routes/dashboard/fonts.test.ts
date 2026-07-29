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
// `drizzle.fontRepo.findFaceByKey` (final-review Important 2 fix,
// round 3): the existing-face lookup backing the quota-skip-on-update
// fix used to be an inline `drizzle.db.select` in this route, pinned
// by a mock whose `from`/`where`/`limit` all discarded their
// arguments — no test anywhere actually ran that query's WHERE clause,
// so dropping the `weight`/`style` predicates would have silently
// skipped the quota check for any upload into a family with any face,
// and every test here would still pass. It now lives in fontRepo,
// with real-Postgres, per-predicate coverage in
// fonts.integration.test.ts (mutation-checked). Mocked here the same
// way findLiveFamilyForProject is: these route tests pin the route's
// *reaction*, not the query.
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

// Task 4 (list): a bare membership gate, deliberately distinct from
// `assertProjectCapability` above — the list route only requires the
// caller to belong to the project named in the URL, not the
// `fonts:write` capability the upload route requires. Mocked to always
// resolve (i.e. "the caller is a legitimate member of whatever project
// the URL names") so that the cross-project delete test below
// exercises the thing it's meant to: family-vs-URL-project scoping via
// `findLiveFamilyForProject`, not membership itself.
//
// DELETE does NOT use this gate (final-review fix): it is destructive,
// so it is gated behind `assertProjectCapability(..., "fonts:write")`,
// same as upload — see the route's own comment. `assertProjectAccess`
// stays mocked to resolve for the GET/list tests below.
const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/project-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectAccess: (...args: unknown[]) => assertProjectAccess(...args),
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
const listFamiliesWithFaces = vi.hoisted(() => vi.fn());
const softDeleteFamily = vi.hoisted(() => vi.fn());
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
        listFamiliesWithFaces,
        softDeleteFamily,
      },
      db: { ...actual.drizzle.db, transaction },
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

function listFonts(projectId = "p1") {
  return app().request(`/dashboard/projects/${projectId}/fonts`);
}

function deleteFamily(familyId: string, opts?: { asProject?: string }) {
  const projectId = opts?.asProject ?? "p1";
  return app().request(
    `/dashboard/projects/${projectId}/fonts/${familyId}`,
    { method: "DELETE" },
  );
}

let faceIdCounter = 0;

beforeEach(() => {
  faceIdCounter = 0;
  assertProjectCapability
    .mockReset()
    .mockResolvedValue({ id: "m1", role: "OWNER" });
  assertProjectAccess
    .mockReset()
    .mockResolvedValue({ id: "m1", role: "OWNER" });
  auditMock.mockReset().mockResolvedValue(undefined);
  countFacesForProject.mockReset().mockResolvedValue(0);
  listFamiliesWithFaces.mockReset().mockResolvedValue([]);
  softDeleteFamily.mockReset().mockResolvedValue(undefined);
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
      contentHash: `hash${faceIdCounter}`,
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
  findFaceByKey.mockReset().mockResolvedValue(null);
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

  it("accepts a file of exactly FONT_FACE_MAX_BYTES (the documented cap is reachable)", async () => {
    // FONT_FACE_MAX_BYTES's own docstring in @rovenue/shared describes
    // it as the cap for one uploaded face ("2 MB comfortably holds a
    // full-featured OTF"). bodyLimit measures the WHOLE multipart body
    // (boundary + part headers + the other form fields), which is
    // always a bit larger than the file part alone, so bodyLimit is
    // bound to FONT_FACE_MAX_BYTES plus a small framing allowance
    // (FONT_UPLOAD_MULTIPART_FRAMING_ALLOWANCE_BYTES in the route) —
    // otherwise a file of exactly this size would be rejected at the
    // transport layer despite fitting the documented cap.
    const bytes = new Uint8Array(FONT_FACE_MAX_BYTES);
    bytes.set([0x4f, 0x54, 0x54, 0x4f]);
    const res = await uploadFont({
      bytes,
      familyName: "Brand",
      weight: 400,
      style: "normal",
    });
    expect(res.status).toBe(200);
    expect(upsertFace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: "otf" }),
    );
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
    const body = (await res.json()) as {
      data: { format: string; contentHash: string };
    };
    expect(body.data.format).toBe("otf");
    // Minor fix: the upload response now carries contentHash so a
    // client that just uploaded can build the versioned file URL
    // without a second round-trip to GET /fonts.
    expect(body.data.contentHash).toBe("hash1");
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
    findFaceByKey.mockResolvedValue(null);
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
    expect(findFaceByKey).toHaveBeenCalledWith(expect.anything(), {
      familyId: "family-existing",
      weight: 700,
      style: "italic",
    });
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
    findFaceByKey.mockResolvedValue({ id: "face-existing" });
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
    expect(findFaceByKey).toHaveBeenCalledWith(expect.anything(), {
      familyId: "family-existing",
      weight: 400,
      style: "normal",
    });
  });

  it("still rejects a genuinely new (weight, style) at the face cap", async () => {
    countFacesForProject.mockResolvedValue(FONT_FACES_MAX_PER_PROJECT);
    findLiveFamilyForProject.mockResolvedValue({ id: "family-existing" });
    findFaceByKey.mockResolvedValue(null);
    const res = await uploadFont({
      bytes: otfBytes(),
      familyId: "family-existing",
      weight: 900,
      style: "italic",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FONT_QUOTA_EXCEEDED");
    expect(upsertFace).not.toHaveBeenCalled();
    expect(findFaceByKey).toHaveBeenCalledWith(expect.anything(), {
      familyId: "family-existing",
      weight: 900,
      style: "italic",
    });
  });
});

// =============================================================
// GET /dashboard/projects/:projectId/fonts
// DELETE /dashboard/projects/:projectId/fonts/:familyId
// (paywall fonts wave E1, Task 4)
// =============================================================
//
// Same idiom as the POST suite above: `drizzle.fontRepo.*` and
// `assertProjectAccess` are mocked at module level, so these tests pin
// the ROUTE's reaction (status code, error code, which repo calls
// happen), not the repository queries themselves. `findLiveFamilyForProject`
// and `listFamiliesWithFaces` each already have real-Postgres coverage
// of their own predicates in
// packages/db/src/drizzle/repositories/fonts.integration.test.ts.

describe("GET /dashboard/projects/:projectId/fonts", () => {
  it("lists families with face metadata, including contentHash; the response never carries a bytes field", async () => {
    // NOTE on what this can and cannot prove: the route does a
    // straight pass-through of whatever `listFamiliesWithFaces`
    // returns — it does not itself strip anything. The guarantee that
    // the repo query never SELECTs the `bytes` column is real and is
    // pinned against a live database in
    // fonts.integration.test.ts ("listFamiliesWithFaces does not
    // select the bytes column"). Because this mock, by construction,
    // never contains a `bytes` field, `not.toHaveProperty("bytes")`
    // below cannot by itself catch a regression that reintroduced
    // bytes into the repo's result — it documents the same invariant
    // at the response boundary. What this test DOES genuinely pin is
    // the route's shape-mapping: that `families[0].name` and
    // `families[0].faces[0]` (including `contentHash`, Task 7's
    // addition so wave E2's picker can build the versioned file URL
    // without a second round-trip) surface, untouched, under
    // `{ data: [...] }`.
    const contentHash = "a".repeat(64);
    listFamiliesWithFaces.mockResolvedValue([
      {
        id: "family1",
        projectId: "p1",
        name: "Brand",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        faces: [
          {
            id: "face1",
            weight: 400,
            style: "normal",
            format: "otf",
            byteSize: 16,
            contentHash,
          },
        ],
      },
    ]);

    const res = await listFonts();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ name: string; faces: Array<Record<string, unknown>> }>;
    };
    expect(body.data[0].name).toBe("Brand");
    expect(body.data[0].faces[0]).not.toHaveProperty("bytes");
    expect(body.data[0].faces[0].contentHash).toBe(contentHash);
    expect(listFamiliesWithFaces).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
    );
  });
});

describe("DELETE /dashboard/projects/:projectId/fonts/:familyId", () => {
  // -----------------------------------------------------------
  // spec §4.1: deleting a family a paywall references is allowed on
  // purpose — there is deliberately no "font is in use" guard.
  //
  // Ambiguity note (see task-4-report.md for the full writeup): the
  // brief's own test for this is literally
  // `await createPaywallReferencing(familyId)` — but nothing in the
  // codebase today lets a paywall's component tree hold a font family
  // id (that field arrives in wave E2's font picker), so there is no
  // real reference to construct, and this file's mocked-@rovenue/db
  // setup has no paywall-repo wiring to fabricate one against either.
  // What IS genuinely constructible is the nearest true precondition:
  // a family that has actually been uploaded (via the real POST route
  // above, not a hand-built fixture). This test proves deletion
  // succeeds and the family leaves the list. It does NOT prove
  // "deletion is allowed while a paywall references the font" — that
  // claim has no mechanism to exercise yet and needs a real test once
  // E2 wires the field, not a faked one here.
  // -----------------------------------------------------------
  it("deletes an uploaded family; it disappears from the list afterward", async () => {
    const uploadRes = await uploadFont({
      bytes: otfBytes(),
      familyName: "Brand",
      weight: 400,
      style: "normal",
    });
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as {
      data: { familyId: string };
    };
    const familyId = uploadBody.data.familyId;

    findLiveFamilyForProject.mockResolvedValue({ id: familyId });

    const delRes = await deleteFamily(familyId);
    expect(delRes.status).toBe(200);
    expect(softDeleteFamily).toHaveBeenCalledWith(expect.anything(), familyId);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "font.deleted",
        resource: "font_family",
        resourceId: familyId,
      }),
      expect.anything(),
    );

    // Simulate the post-delete state: listFamiliesWithFaces now
    // excludes the soft-deleted family (pinned for real against
    // Postgres in fonts.integration.test.ts).
    listFamiliesWithFaces.mockResolvedValue([]);
    const listBody = (await (await listFonts()).json()) as {
      data: unknown[];
    };
    expect(listBody.data).toHaveLength(0);
  });

  it("gates deletion behind the fonts:write capability, not bare assertProjectAccess", async () => {
    // Final-review Important 1: DELETE used to call bare
    // `assertProjectAccess` (defaults to CUSTOMER_SUPPORT), weaker than
    // the `fonts:write` capability the upload route requires. This
    // pins the fix; it would fail if the route reverted to
    // `assertProjectAccess` because that mock is never called for this
    // request and `assertProjectCapability` would see zero calls.
    assertProjectCapability.mockReset().mockResolvedValue({
      id: "m1",
      role: "OWNER",
    });
    findLiveFamilyForProject.mockResolvedValue({ id: "family1" });
    const res = await deleteFamily("family1");
    expect(res.status).toBe(200);
    expect(assertProjectCapability).toHaveBeenCalledWith(
      "p1",
      "u1",
      "fonts:write",
    );
    expect(assertProjectAccess).not.toHaveBeenCalled();
  });

  it("returns 404 FONT_FAMILY_NOT_FOUND, not 403, for a familyId outside the caller's project", async () => {
    // The caller genuinely passes the `fonts:write` capability gate for
    // the project named in the URL (assertProjectCapability resolves —
    // see the "gates deletion behind the fonts:write capability" test
    // above); the familyId they supply simply belongs to a different
    // project and so is invisible under this project's scope. A 403
    // here would leak that the id exists somewhere; 404 does not.
    findLiveFamilyForProject.mockResolvedValue(null);

    const res = await deleteFamily("foreign-family", {
      asProject: "other-project",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("FONT_FAMILY_NOT_FOUND");
    expect(softDeleteFamily).not.toHaveBeenCalled();
    expect(findLiveFamilyForProject).toHaveBeenCalledWith(expect.anything(), {
      projectId: "other-project",
      familyId: "foreign-family",
    });
  });
});
