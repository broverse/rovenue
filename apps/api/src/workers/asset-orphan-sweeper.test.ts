// =============================================================
// asset-orphan-sweeper — age-confirmation guard (unit)
// =============================================================
//
// getObjectLastModified() returns null when HeadObject comes back
// NotFound. That is NOT proof the object is gone — read-after-write
// lag or a transient S3 error can surface as NotFound while the object
// still exists (and may be live). This pins the asymmetric handling: a
// null age must be SKIPPED, not treated as "old enough to delete".
//
// @rovenue/db and lib/asset-store are both mocked so this runs with no
// containers — the real-MinIO/real-Postgres version of "does the
// window actually protect a fresh orphan" lives in
// tests/workers/asset-orphan-sweeper.integration.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` factories are hoisted above every top-level statement in
// this file, including plain `const` declarations — a bare
// `const foo = vi.fn()` referenced inside the factory below hits the
// same TDZ footgun documented for `lib/env` elsewhere in this repo.
// `vi.hoisted` is what actually runs before the mocks, not just before
// the imports.
const {
  isStorageConfiguredMock,
  listAllKeysMock,
  getObjectLastModifiedMock,
  deleteObjectMock,
  dbExecuteMock,
} = vi.hoisted(() => ({
  isStorageConfiguredMock: vi.fn(),
  listAllKeysMock: vi.fn(),
  getObjectLastModifiedMock: vi.fn(),
  deleteObjectMock: vi.fn(),
  dbExecuteMock: vi.fn(),
}));

vi.mock("../lib/asset-store", () => ({
  isStorageConfigured: isStorageConfiguredMock,
  listAllKeys: listAllKeysMock,
  getObjectLastModified: getObjectLastModifiedMock,
  deleteObject: deleteObjectMock,
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { execute: dbExecuteMock },
    },
  };
});

import { sweepOrphanedAssets } from "./asset-orphan-sweeper";

const NOW = new Date("2026-07-29T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  isStorageConfiguredMock.mockReturnValue(true);
  // Covers both the live-keys SELECT and the reservations DELETE —
  // neither case under test here depends on a live row or an existing
  // reservation.
  dbExecuteMock.mockResolvedValue({ rows: [] });
});

describe("sweepOrphanedAssets — age-confirmation guard", () => {
  it("skips a key when its age cannot be confirmed (null LastModified)", async () => {
    listAllKeysMock.mockResolvedValue(["prj_x/orphan.webp"]);
    getObjectLastModifiedMock.mockResolvedValue(null);

    const result = await sweepOrphanedAssets(NOW);

    // "Could not confirm this object's age" must resolve to "leave it
    // alone" — the asymmetry is deliberate: skipping costs one more
    // sweep cycle of retained bytes, deleting wrongly costs a
    // published paywall's asset.
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(result.reclaimed).toBe(0);
  });

  it("reclaims a key whose confirmed age is older than the grace window", async () => {
    listAllKeysMock.mockResolvedValue(["prj_x/orphan.webp"]);
    getObjectLastModifiedMock.mockResolvedValue(
      new Date("2026-07-01T00:00:00.000Z"), // weeks before NOW — well past ASSET_ORPHAN_GRACE_HOURS
    );

    const result = await sweepOrphanedAssets(NOW);

    expect(deleteObjectMock).toHaveBeenCalledWith("prj_x/orphan.webp");
    expect(result.reclaimed).toBe(1);
  });
});
