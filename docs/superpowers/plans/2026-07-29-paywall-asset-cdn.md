# Paywall Asset CDN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project upload paywall images, video and Lottie files to Rovenue, normalise them, and serve them from an S3-compatible bucket/CDN.

**Architecture:** Bytes go up through the API (so magic-byte validation, normalisation, quota and audit stay synchronous in one place) and come down straight from the bucket (so the API is never in the serving path for a 50 MB video). The paywall tree keeps holding a plain URL string — no schema, validator, renderer or `render-fixtures.json` change — because the offline fallback-export file is read on-device where no server exists to resolve an id. A derived usage index recovers the one thing a real reference would have bought: warning before deleting something a published paywall still uses.

**Tech Stack:** Hono, Drizzle/Postgres, `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, `sharp` (libvips), MinIO (self-host) / R2 / S3 (cloud), Vitest + testcontainers, React (dashboard).

**Spec:** `docs/superpowers/specs/2026-07-29-paywall-asset-cdn-design.md`

## Global Constraints

- **No magic values.** Every size cap, dimension ceiling, grace window, rate-limit figure and policy version is a named constant in `packages/shared/src/assets/`. This applies to every task, not just the first.
- **`sharp >= 0.35.3`** (libvips 8.18.3). CVE-2026-33327 / 33328 / 35590 / 35591 affect < 0.35.0 and land in the GIF, TIFF and VIPS loaders; GIF is on our accept list. Never downgrade.
- **SVG is not an accepted format.** libvips loaders are allowlisted to JPEG, PNG, WebP and GIF; everything else is blocked at init.
- **Never put an S3 write inside a database transaction.** An S3 `put` cannot be rolled back. Create: object first, then commit the row. Delete: soft-delete the row first, then the object.
- **The filename is never consulted** for type detection. The kind comes from the URL path segment and the magic bytes must agree with it.
- TypeScript strict everywhere; Zod for API input; all responses are `{ data: T }` or `{ error: { code, message } }`.
- Postgres access via Drizzle repositories only. In `sql` templates, qualify columns (`"paywall_assets"."id"`).
- **Column naming in this repo is genuinely mixed, table by table, and raw SQL must match the actual table.** Table names are snake_case throughout. Column names are not: for the single column `projectId`, **34 tables** declare it as `text("projectId")` and **19** as `text("project_id")`. There is no rule to infer and no safe sample to generalise from — this plan has already shipped the bug twice, once by assuming snake_case everywhere and once by assuming camelCase for `billing_subscriptions` (it is `"project_id"`). **Open `packages/db/src/drizzle/schema.ts` and read the specific table's specific column before writing any raw `sql` template.** A wrong name typechecks and fails at runtime.
  Known values this plan depends on: `paywalls."publishedVersionId"`, `font_faces."byteSize"`, `billing_subscriptions."project_id"`, `billing_tier_limits."asset_storage_bytes_limit"`, and the new `paywall_asset*` tables in **camelCase** (`"projectId"`, `"byteSize"`, `"deletedAt"`, `"storageKey"`).
- `audit()` runs inside the caller's Drizzle transaction.
- Conventional commits. **Stay on the current branch** — do not create branches or worktrees.
- Tests: Vitest. `*.integration.test.ts` use testcontainers with real Postgres and real MinIO. A failure path tested by hand-constructing the error it is meant to catch, or an atomicity claim demonstrated over a mocked transaction, is not accepted as evidence.

---

## File Structure

**New — shared contract**
- `packages/shared/src/assets/constants.ts` — every cap, ceiling, window, policy version
- `packages/shared/src/assets/detect.ts` — `detectAssetKind`, magic-byte shape check
- `packages/shared/src/assets/name.ts` — author-supplied name validation
- `packages/shared/src/assets/index.ts` — barrel

**New — database**
- `packages/db/drizzle/migrations/0099_paywall_assets.sql`
- `packages/db/src/drizzle/repositories/assets.ts`

**New — API**
- `apps/api/src/lib/asset-store.ts` — the only place that knows S3 or the public URL shape
- `apps/api/src/services/assets/normalize.ts` — `sharp` wrapper, pure
- `apps/api/src/services/assets/sharp-hardening.ts` — loader allowlist, applied once at process start
- `apps/api/src/routes/dashboard/assets.ts` — upload / list / delete
- `apps/api/src/workers/asset-orphan-sweeper.ts`

**New — dashboard**
- `apps/dashboard/src/lib/hooks/useAssets.ts`
- `apps/dashboard/src/components/assets/asset-library.tsx`
- `apps/dashboard/src/components/assets/asset-picker-dialog.tsx`

**Modified**
- `packages/shared/src/index.ts` — `ERROR_CODE` additions, assets barrel re-export
- `packages/db/src/drizzle/schema.ts` — `paywallAssets`, `paywallAssetUsages`, `billingTierLimits.assetStorageBytesLimit`
- `packages/db/src/drizzle/repositories/paywalls.ts:166` — usage-index write inside `setPublishedVersion`
- `apps/api/src/lib/capabilities.ts` — `assets:write`
- `apps/api/src/lib/env.ts` — storage configuration
- `apps/api/src/routes/dashboard/index.ts` — mount the assets route
- `apps/dashboard/src/components/paywall-builder/inspector/fields.tsx` — asset picker on media URL fields
- `docker-compose.yml`, `.env.example`, `apps/api/Dockerfile`

> **Working-tree collision.** Another session has uncommitted changes across `apps/dashboard/src/components/paywall-builder/inspector/`. Task 11 lands there. Re-check `git status` before starting Task 11 and coordinate rather than overwriting.

---

## Task 1: Shared constants, error codes, and kind detection

**Files:**
- Create: `packages/shared/src/assets/constants.ts`
- Create: `packages/shared/src/assets/detect.ts`
- Create: `packages/shared/src/assets/name.ts`
- Create: `packages/shared/src/assets/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/assets/detect.test.ts`, `packages/shared/src/assets/name.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type AssetKind = "image" | "video" | "lottie"`
  - `type ImageSourceFormat = "png" | "jpeg" | "webp" | "gif"`
  - `detectAssetKind(bytes: Uint8Array): { kind: AssetKind; sourceFormat: ImageSourceFormat | null } | null`
  - `isValidAssetName(name: string): boolean`
  - `ASSET_MAX_BYTES: Record<AssetKind, number>`, `ASSET_IMAGE_MAX_EDGE_PX`, `ASSET_NORMALIZE_POLICY_VERSION`, `ASSET_CONTENT_TYPES`, `ASSET_FILE_EXTENSIONS`, `ASSET_CACHE_MAX_AGE_SECONDS`, `ASSET_ORPHAN_GRACE_HOURS`, `ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE`, `ASSET_NAME_MAX_LENGTH`
  - `ERROR_CODE.ASSET_FORMAT_UNSUPPORTED | ASSET_FILE_TOO_LARGE | ASSET_QUOTA_EXCEEDED | ASSET_STORAGE_UNAVAILABLE | ASSET_INVALID_NAME | ASSET_PROCESSING_FAILED`

- [ ] **Step 1: Write the failing detection tests**

Create `packages/shared/src/assets/detect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectAssetKind } from "./detect";

/** Builds a buffer whose first bytes are `magic`, padded to `length`. */
function withMagic(magic: number[], length = 64): Uint8Array {
  const b = new Uint8Array(length);
  b.set(magic, 0);
  return b;
}

describe("detectAssetKind", () => {
  it("detects PNG", () => {
    const b = withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectAssetKind(b)).toEqual({ kind: "image", sourceFormat: "png" });
  });

  it("detects JPEG", () => {
    expect(detectAssetKind(withMagic([0xff, 0xd8, 0xff]))).toEqual({
      kind: "image",
      sourceFormat: "jpeg",
    });
  });

  it("detects GIF87a and GIF89a", () => {
    // "GIF87a" / "GIF89a"
    expect(detectAssetKind(withMagic([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toEqual({
      kind: "image",
      sourceFormat: "gif",
    });
    expect(detectAssetKind(withMagic([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toEqual({
      kind: "image",
      sourceFormat: "gif",
    });
  });

  it("detects WebP, which needs both the RIFF prefix and the WEBP tag at offset 8", () => {
    const b = new Uint8Array(64);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    expect(detectAssetKind(b)).toEqual({ kind: "image", sourceFormat: "webp" });
  });

  it("rejects a RIFF container that is not WebP (e.g. WAV)", () => {
    const b = new Uint8Array(64);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    b.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(detectAssetKind(b)).toBeNull();
  });

  it("detects MP4 by the ftyp box at offset 4", () => {
    const b = new Uint8Array(64);
    b.set([0x00, 0x00, 0x00, 0x20], 0); // box size
    b.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
    expect(detectAssetKind(b)).toEqual({ kind: "video", sourceFormat: null });
  });

  it("detects Lottie JSON carrying both v and layers", () => {
    const json = JSON.stringify({ v: "5.7.4", fr: 30, layers: [] });
    expect(detectAssetKind(new TextEncoder().encode(json))).toEqual({
      kind: "lottie",
      sourceFormat: null,
    });
  });

  it("rejects JSON that parses but is not Lottie", () => {
    const json = JSON.stringify({ hello: "world" });
    expect(detectAssetKind(new TextEncoder().encode(json))).toBeNull();
  });

  it("rejects SVG — it is not an accepted format", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(detectAssetKind(new TextEncoder().encode(svg))).toBeNull();
  });

  it("rejects a truncated header without throwing", () => {
    expect(detectAssetKind(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectAssetKind(new Uint8Array())).toBeNull();
  });
});
```

Create `packages/shared/src/assets/name.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isValidAssetName, ASSET_NAME_MAX_LENGTH } from "./index";

describe("isValidAssetName", () => {
  it("accepts ordinary names", () => {
    expect(isValidAssetName("hero.png")).toBe(true);
    expect(isValidAssetName("Onboarding hero 2.webp")).toBe(true);
    expect(isValidAssetName("intro-video.mp4")).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(isValidAssetName("")).toBe(false);
  });

  it("rejects a name over the length cap", () => {
    expect(isValidAssetName("a".repeat(ASSET_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it("rejects a leading period (hidden file)", () => {
    expect(isValidAssetName(".hidden.png")).toBe(false);
  });

  it("rejects sequential periods (directory traversal shape)", () => {
    expect(isValidAssetName("a..b.png")).toBe(false);
    expect(isValidAssetName("../etc/passwd")).toBe(false);
  });

  it("rejects path separators", () => {
    expect(isValidAssetName("dir/hero.png")).toBe(false);
    expect(isValidAssetName("dir\\hero.png")).toBe(false);
  });

  it("rejects characters outside the allowlist", () => {
    expect(isValidAssetName("<script>.png")).toBe(false);
    expect(isValidAssetName("hero .png")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/shared test -- assets`
Expected: FAIL — `Cannot find module './detect'`.

- [ ] **Step 3: Write the constants**

Create `packages/shared/src/assets/constants.ts`:

```ts
// =============================================================
// Paywall asset CDN — the numbers, in one place
// =============================================================
//
// Every cap and ceiling this wave enforces lives here so a reviewer can
// see the whole envelope at once, and so no route, worker or renderer
// ever hard-codes one of them.

export type AssetKind = "image" | "video" | "lottie";
export type ImageSourceFormat = "png" | "jpeg" | "webp" | "gif";

export const ASSET_KINDS: readonly AssetKind[] = ["image", "video", "lottie"];

/** Per-file hard caps. These are flat, not plan-tiered, because Hono's
 *  `bodyLimit` fixes `maxSize` at route-registration time and cannot
 *  vary it per request — which is exactly why the upload surface is
 *  three route registrations rather than one (design spec §3.2). */
export const ASSET_MAX_BYTES: Record<AssetKind, number> = {
  image: 10 * 1024 * 1024,
  lottie: 2 * 1024 * 1024,
  video: 50 * 1024 * 1024,
};

/** The longest edge a normalised image is fitted into. Never upscaled.
 *  2048 covers a retina full-bleed paywall hero with room to spare. */
export const ASSET_IMAGE_MAX_EDGE_PX = 2048;

/** Bumped whenever the normalisation policy changes. Stored per asset.
 *  Originals are discarded (design spec §2.5), so this is the only way
 *  to answer "which assets were captured under the old policy". */
export const ASSET_NORMALIZE_POLICY_VERSION = 1;

/** WebP quality for the normalised derivative. */
export const ASSET_IMAGE_WEBP_QUALITY = 82;

export const ASSET_CONTENT_TYPES: Record<AssetKind, string> = {
  image: "image/webp",
  video: "video/mp4",
  lottie: "application/json",
};

export const ASSET_FILE_EXTENSIONS: Record<AssetKind, string> = {
  image: "webp",
  video: "mp4",
  lottie: "json",
};

/** Honest here, unlike the general case: an asset row is never
 *  overwritten (design spec §4.1), so a storage key's bytes are
 *  permanent and `immutable` is a true statement. */
export const ASSET_CACHE_MAX_AGE_SECONDS = 31536000;

/** How long a bucket object with no live row is left alone before the
 *  sweeper reclaims it. Without a grace window the sweeper races
 *  in-flight uploads whose row has not committed yet. */
export const ASSET_ORPHAN_GRACE_HOURS = 6;

/** Upload is the most expensive request in the product — sharp CPU,
 *  ingress bandwidth, durable storage — so it is the one that gets a
 *  route-scoped limiter. */
export const ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE = 20;

export const ASSET_NAME_MAX_LENGTH = 120;
```

- [ ] **Step 4: Write the detector**

Create `packages/shared/src/assets/detect.ts`:

```ts
import type { AssetKind, ImageSourceFormat } from "./constants";

// =============================================================
// detectAssetKind — what the bytes themselves claim to be
// =============================================================
//
// A shape check, not a parse — the same posture as `detectFontFormat`.
// The uploader's filename is never consulted, and the `kind` path
// segment is checked AGAINST this result rather than trusted.
//
// SVG is deliberately absent. It is text, not magic bytes, and
// accepting it would mean handing attacker-supplied XML to librsvg;
// the libvips loader allowlist blocks it at the other end too
// (design spec §5.4).

export interface DetectedAsset {
  kind: AssetKind;
  /** Only meaningful for `kind: "image"`; null otherwise. */
  sourceFormat: ImageSourceFormat | null;
}

const IMAGE_SIGNATURES: ReadonlyArray<{
  format: ImageSourceFormat;
  offset: number;
  magic: readonly number[];
}> = [
  { format: "png", offset: 0, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: "jpeg", offset: 0, magic: [0xff, 0xd8, 0xff] },
  { format: "gif", offset: 0, magic: [0x47, 0x49, 0x46, 0x38] }, // "GIF8"
];

const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"
const WEBP_TAG_OFFSET = 8;
const FTYP_MAGIC = [0x66, 0x74, 0x79, 0x70] as const; // "ftyp"
const FTYP_OFFSET = 4;

/** Enough bytes to hold the longest signature we check plus its offset. */
const MIN_BYTES_FOR_BINARY_SIGNATURE = 12;

function matches(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

/** A Lottie file is JSON, so it has no magic bytes. `v` (bodymovin
 *  version) and `layers` together are what distinguishes it from any
 *  other JSON an author might upload by mistake. */
function detectLottie(bytes: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.v === "string" && Array.isArray(obj.layers);
}

export function detectAssetKind(bytes: Uint8Array): DetectedAsset | null {
  if (bytes.length >= MIN_BYTES_FOR_BINARY_SIGNATURE) {
    for (const { format, offset, magic } of IMAGE_SIGNATURES) {
      if (matches(bytes, offset, magic)) {
        return { kind: "image", sourceFormat: format };
      }
    }
    // WebP needs both halves: "RIFF" alone is also WAV and AVI.
    if (matches(bytes, 0, RIFF_MAGIC) && matches(bytes, WEBP_TAG_OFFSET, WEBP_TAG)) {
      return { kind: "image", sourceFormat: "webp" };
    }
    if (matches(bytes, FTYP_OFFSET, FTYP_MAGIC)) {
      return { kind: "video", sourceFormat: null };
    }
  }
  if (detectLottie(bytes)) {
    return { kind: "lottie", sourceFormat: null };
  }
  return null;
}
```

- [ ] **Step 5: Write the name validator**

Create `packages/shared/src/assets/name.ts`:

```ts
import { ASSET_NAME_MAX_LENGTH } from "./constants";

// =============================================================
// isValidAssetName — the author-supplied display name
// =============================================================
//
// The storage key is application-generated, so the stored object's name
// is safe by construction. This guards the OTHER thing the name is: a
// value persisted and rendered in the dashboard, i.e. a stored-XSS
// sink. Allowlist, per OWASP, rather than a denylist.

/** Alphanumeric, hyphen, underscore, space and period. Note the absence
 *  of both path separators and every character that could open a tag. */
const ALLOWED = /^[A-Za-z0-9 ._-]+$/;

export function isValidAssetName(name: string): boolean {
  if (name.length === 0 || name.length > ASSET_NAME_MAX_LENGTH) return false;
  if (!ALLOWED.test(name)) return false;
  // A leading period makes a hidden file; sequential periods are the
  // shape of a traversal attempt even though the allowlist above
  // already excludes the separators one would need.
  if (name.startsWith(".")) return false;
  if (name.includes("..")) return false;
  return true;
}
```

Create `packages/shared/src/assets/index.ts`:

```ts
export * from "./constants";
export * from "./detect";
export * from "./name";
```

- [ ] **Step 6: Add the error codes and the barrel re-export**

In `packages/shared/src/index.ts`, add to the `ERROR_CODE` object after the fonts block (which ends with `FONT_FAMILY_NOT_FOUND`):

```ts
  // Paywall asset CDN (design spec §11). Six distinct machine-readable
  // rejections a dashboard client needs to tell apart — notably
  // ASSET_FILE_TOO_LARGE, which `bodyLimit`'s onError returns for the
  // transport-level rejection and the in-handler check returns for the
  // ordinary case, so a caller sees one code either way.
  ASSET_FORMAT_UNSUPPORTED: "ASSET_FORMAT_UNSUPPORTED",
  ASSET_FILE_TOO_LARGE: "ASSET_FILE_TOO_LARGE",
  ASSET_QUOTA_EXCEEDED: "ASSET_QUOTA_EXCEEDED",
  ASSET_STORAGE_UNAVAILABLE: "ASSET_STORAGE_UNAVAILABLE",
  ASSET_INVALID_NAME: "ASSET_INVALID_NAME",
  ASSET_PROCESSING_FAILED: "ASSET_PROCESSING_FAILED",
```

Then add the barrel re-export alongside the existing fonts export:

```ts
export * from "./assets";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/shared test -- assets`
Expected: PASS, all cases in both files.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm --filter @rovenue/shared build`
Expected: clean.

```bash
git add packages/shared/src/assets packages/shared/src/index.ts
git commit -m "feat(shared): asset kind detection, name validation and caps"
```

---

## Task 2: Database schema, migration and repository

**Files:**
- Create: `packages/db/drizzle/migrations/0099_paywall_assets.sql`
- Create: `packages/db/src/drizzle/repositories/assets.ts`
- Modify: `packages/db/src/drizzle/schema.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts` (barrel)
- Test: `packages/db/src/drizzle/repositories/assets.integration.test.ts`

**Interfaces:**
- Consumes: `AssetKind`, `ImageSourceFormat` from Task 1.
- Produces:
  - `createAsset(db, input: CreateAssetInput): Promise<PaywallAsset>`
  - `findAssetById(db, projectId, id): Promise<PaywallAsset | null>`
  - `findLiveAssetByHash(db, projectId, contentHash): Promise<PaywallAsset | null>`
  - `listAssets(db, projectId): Promise<PaywallAsset[]>`
  - `softDeleteAsset(db, projectId, id): Promise<PaywallAsset | null>`
  - `listOrphanCandidates(db, olderThan: Date): Promise<{ storageKey: string }[]>`
  - `CreateAssetInput` = `{ projectId, kind, name, storageKey, contentHash, contentType, byteSize, width, height, sourceFormat, sourceWidth, sourceHeight, policyVersion }`

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/drizzle/repositories/assets.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import * as assetRepo from "./assets";
import { makeTestDb, seedProject } from "../../../tests/helpers";

let db: Awaited<ReturnType<typeof makeTestDb>>;
let projectId: string;

beforeAll(async () => {
  db = await makeTestDb();
  projectId = await seedProject(db);
});

function input(overrides: Partial<assetRepo.CreateAssetInput> = {}) {
  const id = createId();
  return {
    projectId,
    kind: "image" as const,
    name: "hero.png",
    storageKey: `${projectId}/${id}.webp`,
    contentHash: createId().padEnd(64, "a"),
    contentType: "image/webp",
    byteSize: 1234,
    width: 800,
    height: 600,
    sourceFormat: "png" as const,
    sourceWidth: 1600,
    sourceHeight: 1200,
    policyVersion: 1,
    ...overrides,
  };
}

describe("assetRepo", () => {
  it("creates and reads back an asset", async () => {
    const created = await assetRepo.createAsset(db, input());
    const found = await assetRepo.findAssetById(db, projectId, created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.byteSize).toBe(1234);
    expect(found?.sourceWidth).toBe(1600);
  });

  it("finds a live asset by content hash", async () => {
    const hash = createId().padEnd(64, "b");
    const created = await assetRepo.createAsset(db, input({ contentHash: hash }));
    const found = await assetRepo.findLiveAssetByHash(db, projectId, hash);
    expect(found?.id).toBe(created.id);
  });

  it("rejects a second live row with the same (projectId, contentHash)", async () => {
    const hash = createId().padEnd(64, "c");
    await assetRepo.createAsset(db, input({ contentHash: hash }));
    await expect(
      assetRepo.createAsset(db, input({ contentHash: hash })),
    ).rejects.toThrow();
  });

  it("allows re-uploading a hash whose earlier row was soft-deleted", async () => {
    const hash = createId().padEnd(64, "d");
    const first = await assetRepo.createAsset(db, input({ contentHash: hash }));
    await assetRepo.softDeleteAsset(db, projectId, first.id);
    // The unique index is partial on `deleted_at is null`, so this must
    // now succeed — otherwise deleting an asset would permanently burn
    // its bytes' hash for that project.
    const second = await assetRepo.createAsset(db, input({ contentHash: hash }));
    expect(second.id).not.toBe(first.id);
  });

  it("hides soft-deleted assets from list and hash lookup", async () => {
    const hash = createId().padEnd(64, "e");
    const created = await assetRepo.createAsset(db, input({ contentHash: hash }));
    await assetRepo.softDeleteAsset(db, projectId, created.id);
    expect(await assetRepo.findLiveAssetByHash(db, projectId, hash)).toBeNull();
    const listed = await assetRepo.listAssets(db, projectId);
    expect(listed.map((a) => a.id)).not.toContain(created.id);
  });

  it("does not return another project's asset", async () => {
    const otherProject = await seedProject(db);
    const created = await assetRepo.createAsset(db, input());
    expect(await assetRepo.findAssetById(db, otherProject, created.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL pnpm --filter @rovenue/db test -- assets.integration`
Expected: FAIL — `Cannot find module './assets'`.

> `@rovenue/db` vitest needs `DATABASE_URL` exported in the environment.

- [ ] **Step 3: Write the migration**

Create `packages/db/drizzle/migrations/0099_paywall_assets.sql`:

```sql
-- Paywall asset CDN: uploaded images, video and Lottie files.
--
-- Rows are immutable once created (design spec §4.1): an asset is
-- created and deleted, never overwritten. That is what lets the
-- storage key omit a content hash and still guarantee a key never
-- serves two different byte sequences, and it is what makes the
-- `immutable` cache header on the served object an honest claim.

-- Column names are camelCase, matching the sibling paywall_versions and
-- font_faces tables. Only `billing_tier_limits` below is snake_case,
-- because that existing table already is.
CREATE TABLE "paywall_assets" (
  "id"             text PRIMARY KEY NOT NULL,
  "projectId"      text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind"           text NOT NULL,
  "name"           text NOT NULL,
  "storageKey"     text NOT NULL,
  "contentHash"    text NOT NULL,
  "contentType"    text NOT NULL,
  "byteSize"       integer NOT NULL,
  "width"          integer,
  "height"         integer,
  "sourceFormat"   text,
  "sourceWidth"    integer,
  "sourceHeight"   integer,
  "policyVersion"  integer NOT NULL,
  "createdAt"      timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt"      timestamp with time zone DEFAULT now() NOT NULL,
  "deletedAt"      timestamp with time zone
);

-- Partial, so that deleting an asset frees its hash for re-upload.
CREATE UNIQUE INDEX "paywall_assets_project_hash_key"
  ON "paywall_assets" ("projectId", "contentHash")
  WHERE "deletedAt" IS NULL;

CREATE INDEX "paywall_assets_project_idx"
  ON "paywall_assets" ("projectId") WHERE "deletedAt" IS NULL;

-- The sweeper scans by age across all projects.
CREATE INDEX "paywall_assets_created_at_idx" ON "paywall_assets" ("createdAt");

-- Which published paywall version references which asset. Derived data,
-- rewritten on every publish (design spec §7).
CREATE TABLE "paywall_asset_usages" (
  "assetId"   text NOT NULL REFERENCES "paywall_assets"("id") ON DELETE CASCADE,
  "paywallId" text NOT NULL REFERENCES "paywalls"("id") ON DELETE CASCADE,
  "versionId" text NOT NULL REFERENCES "paywall_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "paywall_asset_usages_pk" PRIMARY KEY ("assetId", "versionId")
);

CREATE INDEX "paywall_asset_usages_version_idx"
  ON "paywall_asset_usages" ("versionId");

-- Per-project storage cap. NULL means unlimited, matching how
-- `events_limit` and `sql_limit` already behave in this table.
-- bigint, not integer: 50 GB is 53,687,091,200.
ALTER TABLE "billing_tier_limits"
  ADD COLUMN "asset_storage_bytes_limit" bigint;

UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 262144000
  WHERE "tier" = 'free';                                    -- 250 MB
UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 5368709120
  WHERE "tier" = 'indie';                                   -- 5 GB
UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 53687091200
  WHERE "tier" = 'studio';                                  -- 50 GB
-- enterprise stays NULL (unlimited).
```

- [ ] **Step 4: Add the Drizzle schema**

In `packages/db/src/drizzle/schema.ts`, after the fonts block (which ends with the `FontFace` types), add:

```ts
// =============================================================
// paywall assets (paywall_assets / paywall_asset_usages)
// =============================================================
//
// Uploaded images, video and Lottie files served from an S3-compatible
// bucket. Rows are IMMUTABLE — created and deleted, never overwritten
// (design spec §4.1) — which is why `storageKey` carries no content
// hash: the id alone already guarantees a key's bytes are permanent.
//
// `contentHash` is still stored, for two jobs: the partial unique index
// that makes a repeat upload idempotent, and the ETag on the served
// object.

export const paywallAssets = pgTable(
  "paywall_assets",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    storageKey: text("storageKey").notNull(),
    contentHash: text("contentHash").notNull(),
    contentType: text("contentType").notNull(),
    byteSize: integer("byteSize").notNull(),
    width: integer("width"),
    height: integer("height"),
    sourceFormat: text("sourceFormat"),
    sourceWidth: integer("sourceWidth"),
    sourceHeight: integer("sourceHeight"),
    policyVersion: integer("policyVersion").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deletedAt", { withTimezone: true }),
  },
  // Every index the migration creates is mirrored here. schema.ts is the
  // only place a reader — or `drizzle-kit generate` — learns what indexes
  // exist, so one left out reads as absent and can be "re-added".
  (t) => ({
    hashKey: uniqueIndex("paywall_assets_project_hash_key")
      .on(t.projectId, t.contentHash)
      .where(sql`${t.deletedAt} is null`),
    projectIdx: index("paywall_assets_project_idx")
      .on(t.projectId)
      .where(sql`${t.deletedAt} is null`),
    createdAtIdx: index("paywall_assets_created_at_idx").on(t.createdAt),
  }),
);

export type PaywallAsset = typeof paywallAssets.$inferSelect;
export type NewPaywallAsset = typeof paywallAssets.$inferInsert;

export const paywallAssetUsages = pgTable(
  "paywall_asset_usages",
  {
    assetId: text("assetId")
      .notNull()
      .references(() => paywallAssets.id, { onDelete: "cascade" }),
    paywallId: text("paywallId")
      .notNull()
      .references(() => paywalls.id, { onDelete: "cascade" }),
    versionId: text("versionId")
      .notNull()
      .references(() => paywallVersions.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.assetId, t.versionId] }),
    versionIdx: index("paywall_asset_usages_version_idx").on(t.versionId),
  }),
);

export type PaywallAssetUsage = typeof paywallAssetUsages.$inferSelect;
```

Then add `assetStorageBytesLimit: bigint("asset_storage_bytes_limit", { mode: "number" })` to the `billingTierLimits` table definition at `packages/db/src/drizzle/schema.ts:2244`.

> Import `bigint` from `drizzle-orm/pg-core` if it is not already imported.

- [ ] **Step 5: Write the repository**

Create `packages/db/src/drizzle/repositories/assets.ts`:

```ts
import { and, eq, isNull, lt, desc } from "drizzle-orm";
import type { Db } from "../client";
import { paywallAssets, type PaywallAsset } from "../schema";
import type { AssetKind, ImageSourceFormat } from "@rovenue/shared";

// =============================================================
// Paywall assets — Drizzle repository
// =============================================================
//
// Every read filters `deletedAt is null`, so a deleted asset stops
// resolving everywhere at once. Deleted rows are kept as tombstones
// rather than removed: the audit trail and the usage index both point
// at them, and the bytes are already gone from the bucket by the time
// the row is soft-deleted (design spec §5.8 fixes that ordering).

export interface CreateAssetInput {
  projectId: string;
  kind: AssetKind;
  name: string;
  storageKey: string;
  contentHash: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sourceFormat: ImageSourceFormat | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  policyVersion: number;
}

export async function createAsset(
  db: Db,
  input: CreateAssetInput,
): Promise<PaywallAsset> {
  const [row] = await db.insert(paywallAssets).values(input).returning();
  return row!;
}

export async function findAssetById(
  db: Db,
  projectId: string,
  id: string,
): Promise<PaywallAsset | null> {
  const [row] = await db
    .select()
    .from(paywallAssets)
    .where(
      and(
        eq(paywallAssets.projectId, projectId),
        eq(paywallAssets.id, id),
        isNull(paywallAssets.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findLiveAssetByHash(
  db: Db,
  projectId: string,
  contentHash: string,
): Promise<PaywallAsset | null> {
  const [row] = await db
    .select()
    .from(paywallAssets)
    .where(
      and(
        eq(paywallAssets.projectId, projectId),
        eq(paywallAssets.contentHash, contentHash),
        isNull(paywallAssets.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listAssets(
  db: Db,
  projectId: string,
): Promise<PaywallAsset[]> {
  return db
    .select()
    .from(paywallAssets)
    .where(
      and(eq(paywallAssets.projectId, projectId), isNull(paywallAssets.deletedAt)),
    )
    .orderBy(desc(paywallAssets.createdAt));
}

export async function softDeleteAsset(
  db: Db,
  projectId: string,
  id: string,
): Promise<PaywallAsset | null> {
  const [row] = await db
    .update(paywallAssets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(paywallAssets.projectId, projectId),
        eq(paywallAssets.id, id),
        isNull(paywallAssets.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}
```

> The sweeper (Task 9) reads live storage keys with its own query rather than through this repository — it needs a `Set` of keys across all projects, which is not a shape any other caller wants. Do not add a speculative helper here for it.

Export it from the repositories barrel (`packages/db/src/drizzle/repositories/index.ts`) as `assetRepo`, matching how `fontRepo` is exported.

- [ ] **Step 6: Run the migration and the tests**

Run: `pnpm db:migrate && DATABASE_URL=$DATABASE_URL pnpm --filter @rovenue/db test -- assets.integration`
Expected: PASS, all six cases.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): paywall_assets, usage index and per-tier storage limit"
```

---

## Task 3: The `AssetStore` seam

**Files:**
- Create: `apps/api/src/lib/asset-store.ts`
- Modify: `apps/api/src/lib/env.ts`
- Test: `apps/api/tests/lib/asset-store.test.ts`

**Interfaces:**
- Consumes: `ASSET_CONTENT_TYPES`, `ASSET_FILE_EXTENSIONS`, `ASSET_CACHE_MAX_AGE_SECONDS`, `AssetKind` from Task 1.
- Produces:
  - `buildStorageKey(projectId: string, assetId: string, kind: AssetKind): string`
  - `publicUrl(storageKey: string): string`
  - `parseAssetUrl(url: string): { projectId: string; assetId: string } | null`
  - `putObject(key: string, body: Readable | Buffer, contentType: string): Promise<void>`
  - `deleteObject(key: string): Promise<void>`
  - `listAllKeys(): Promise<string[]>`
  - `isStorageConfigured(): boolean`

- [ ] **Step 1: Write the failing round-trip test**

Create `apps/api/tests/lib/asset-store.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// `vi.hoisted` runs BEFORE the imports below. This matters: `lib/env`
// parses process.env at import time, and a plain `beforeAll` would run
// after the module graph is already built — a known footgun in this
// repo, where top-of-file `process.env` assignments are dead code.
// The base deliberately carries BOTH hazards this module has to
// survive: a path prefix (path-style MinIO puts the bucket in the path)
// and a trailing slash. Testing against a bare origin would leave both
// code paths unexercised while looking fully covered.
vi.hoisted(() => {
  process.env.ASSET_PUBLIC_BASE_URL ??= "https://cdn.example.test/rovenue-assets/";
});

import { buildStorageKey, publicUrl, parseAssetUrl } from "../../src/lib/asset-store";

describe("asset URL shape", () => {
  const projectId = "prj_abc123";
  const assetId = "ast_def456";

  it("round-trips a built key through publicUrl and back", () => {
    const key = buildStorageKey(projectId, assetId, "image");
    const parsed = parseAssetUrl(publicUrl(key));
    expect(parsed).toEqual({ projectId, assetId });
  });

  it("round-trips every kind", () => {
    for (const kind of ["image", "video", "lottie"] as const) {
      const key = buildStorageKey(projectId, assetId, kind);
      expect(parseAssetUrl(publicUrl(key))).toEqual({ projectId, assetId });
    }
  });

  it("gives each kind its own extension", () => {
    expect(buildStorageKey(projectId, assetId, "image")).toMatch(/\.webp$/);
    expect(buildStorageKey(projectId, assetId, "video")).toMatch(/\.mp4$/);
    expect(buildStorageKey(projectId, assetId, "lottie")).toMatch(/\.json$/);
  });

  it("does not double the slash when the base URL has a trailing one", () => {
    // The hoisted base above ends in "/", so this exercises the strip
    // for real. Against a slash-less base the test would be
    // self-confirming — deleting the strip from `publicUrl` would leave
    // it green, because there would be nothing to strip.
    const key = buildStorageKey(projectId, assetId, "image");
    expect(publicUrl(key)).toBe(`https://cdn.example.test/rovenue-assets/${key}`);
    expect(publicUrl(key)).not.toContain("//prj_");
  });

  it("rejects a URL under our origin but outside our base path", () => {
    expect(
      parseAssetUrl(`https://cdn.example.test/other-bucket/${projectId}/${assetId}.webp`),
    ).toBeNull();
  });

  it("returns null for a URL that is not ours", () => {
    expect(parseAssetUrl("https://example.com/hero.png")).toBeNull();
    expect(parseAssetUrl("https://cdn.example.test/nope")).toBeNull();
    expect(parseAssetUrl("not a url")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- asset-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the storage env**

In `apps/api/src/lib/env.ts`, add to the schema (all optional, so a dev environment without MinIO still boots):

```ts
  ASSET_STORAGE_ENDPOINT: z.string().url().optional(),
  ASSET_STORAGE_REGION: z.string().optional(),
  ASSET_STORAGE_BUCKET: z.string().optional(),
  ASSET_STORAGE_ACCESS_KEY_ID: z.string().optional(),
  ASSET_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  ASSET_PUBLIC_BASE_URL: z.string().url().optional(),
```

- [ ] **Step 4: Write the store**

Create `apps/api/src/lib/asset-store.ts`:

```ts
import { Readable } from "node:stream";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  ASSET_CACHE_MAX_AGE_SECONDS,
  ASSET_FILE_EXTENSIONS,
  type AssetKind,
} from "@rovenue/shared";
import { env } from "./env";

// =============================================================
// AssetStore — the one place that knows S3, and the one place that
// knows the public URL shape
// =============================================================
//
// MinIO (self-host), R2 and S3 (cloud) all speak the S3 protocol, so
// there is one implementation and only the endpoint and credentials
// differ. Routes never import the AWS SDK.
//
// `publicUrl` and `parseAssetUrl` live together deliberately: they are
// inverses, and the lesson from `buildFontFaceFileUrl`
// (routes/v1/fonts.ts:36) is that a producer and a parser kept apart
// drift apart silently. The usage index (design spec §7) depends on
// the parse still matching what the producer emits, months later.
//
// The URL a device fetches is frozen into the bundled fallback-export
// file, so this shape is effectively permanent once assets ship.

/** `{projectId}/{assetId}.{ext}` — no content hash, because an asset row
 *  is never overwritten (design spec §4.1), so the id alone already
 *  guarantees this key's bytes never change. */
export function buildStorageKey(
  projectId: string,
  assetId: string,
  kind: AssetKind,
): string {
  return `${projectId}/${assetId}.${ASSET_FILE_EXTENSIONS[kind]}`;
}

/** Trailing-slash hazard, same as `buildFontFaceFileUrl`'s: a base of
 *  "https://cdn/" would otherwise produce "https://cdn//prj_…". */
export function publicUrl(storageKey: string): string {
  const base = (env.ASSET_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/${storageKey}`;
}

const KEY_PATTERN = /^([^/]+)\/([^/.]+)\.(webp|mp4|json)$/;

export function parseAssetUrl(
  url: string,
): { projectId: string; assetId: string } | null {
  const base = env.ASSET_PUBLIC_BASE_URL;
  if (!base) return null;
  let parsed: URL;
  let baseParsed: URL;
  try {
    parsed = new URL(url);
    baseParsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.origin !== baseParsed.origin) return null;

  // The base URL may carry a path prefix, and in one supported
  // deployment it always does: path-style MinIO puts the bucket in the
  // path (`http://host:9000/rovenue-assets`). Anchoring the pattern to
  // the whole pathname would make every parse return null there — and
  // a null here does not look like a failure, it looks like "no paywall
  // uses this asset", which is the answer that gets an in-use asset
  // deleted. So strip the base's own path before matching.
  const basePath = baseParsed.pathname.replace(/\/+$/, "");
  if (basePath && !parsed.pathname.startsWith(`${basePath}/`)) return null;
  const keyPath = parsed.pathname.slice(basePath.length).replace(/^\/+/, "");

  const match = KEY_PATTERN.exec(keyPath);
  if (!match) return null;
  return { projectId: match[1]!, assetId: match[2]! };
}

export function isStorageConfigured(): boolean {
  return Boolean(
    env.ASSET_STORAGE_ENDPOINT &&
      env.ASSET_STORAGE_BUCKET &&
      env.ASSET_STORAGE_ACCESS_KEY_ID &&
      env.ASSET_STORAGE_SECRET_ACCESS_KEY &&
      env.ASSET_PUBLIC_BASE_URL,
  );
}

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.ASSET_STORAGE_ENDPOINT,
      region: env.ASSET_STORAGE_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: env.ASSET_STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: env.ASSET_STORAGE_SECRET_ACCESS_KEY!,
      },
      // MinIO serves path-style; R2 and S3 accept it too.
      forcePathStyle: true,
    });
  }
  return client;
}

/** `Upload` rather than `PutObjectCommand`: it accepts a stream and
 *  drives S3 multipart itself, which is what keeps a 50 MB video from
 *  ever being fully resident (design spec §3.1). */
export async function putObject(
  key: string,
  body: Readable | Buffer,
  contentType: string,
): Promise<void> {
  await new Upload({
    client: s3(),
    params: {
      Bucket: env.ASSET_STORAGE_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: `public, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}, immutable`,
    },
  }).done();
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({ Bucket: env.ASSET_STORAGE_BUCKET!, Key: key }),
  );
}

/** Used only by the orphan sweeper. Paginates — a project with many
 *  assets will exceed the 1000-key page size. */
export async function listAllKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: env.ASSET_STORAGE_BUCKET!,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}
```

- [ ] **Step 5: Install the AWS SDK**

Run: `pnpm --filter @rovenue/api add @aws-sdk/client-s3 @aws-sdk/lib-storage`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api test -- asset-store`
Expected: PASS, all five cases.

- [ ] **Step 7: Mutation check — prove the round-trip test has teeth**

Temporarily change `buildStorageKey` to return a constant id:

```ts
return `${projectId}/CONSTANT_ID.${ASSET_FILE_EXTENSIONS[kind]}`;
```

Run: `pnpm --filter @rovenue/api test -- asset-store`
Expected: FAIL on the round-trip cases. **Then revert the mutation** and re-run to confirm green.

This is the same check the fonts `fileUrl` work used. A round-trip test that passes against a constant is testing nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/asset-store.ts apps/api/src/lib/env.ts apps/api/tests/lib/asset-store.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): AssetStore seam over S3-compatible storage"
```

---

## Task 4: Image normalisation and `sharp` hardening

**Files:**
- Create: `apps/api/src/services/assets/sharp-hardening.ts`
- Create: `apps/api/src/services/assets/normalize.ts`
- Modify: `apps/api/src/index.ts` (call the hardening once at startup)
- Test: `apps/api/tests/services/assets/normalize.test.ts`
- Test fixtures: `apps/api/tests/fixtures/assets/`

**Interfaces:**
- Consumes: `ASSET_IMAGE_MAX_EDGE_PX`, `ASSET_IMAGE_WEBP_QUALITY`, `ASSET_NORMALIZE_POLICY_VERSION` from Task 1.
- Produces:
  - `applySharpHardening(): void`
  - `normalizeImage(input: Buffer): Promise<NormalizedImage>`
  - `NormalizedImage` = `{ bytes: Buffer; width: number; height: number; sourceWidth: number; sourceHeight: number; policyVersion: number }`
  - Throws `AssetProcessingError` on a blocked loader, a bomb, or corrupt input.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/services/assets/normalize.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { applySharpHardening } from "../../../src/services/assets/sharp-hardening";
import {
  normalizeImage,
  AssetProcessingError,
} from "../../../src/services/assets/normalize";
import { ASSET_IMAGE_MAX_EDGE_PX } from "@rovenue/shared";

beforeAll(() => {
  applySharpHardening();
});

/** A solid-colour PNG of the given size, built in-process so the test
 *  needs no binary fixture checked into the repo. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

/** A PNG that CLAIMS `width` x `height` without allocating it — the
 *  decompression-bomb fixture.
 *
 *  Signature + IHDR alone is NOT enough, and getting this wrong makes
 *  the test prove nothing: with no IDAT, libvips rejects the file as a
 *  corrupt header BEFORE the pixel limit is ever consulted, so the test
 *  passes even with `limitInputPixels: false`. The fixture must
 *  therefore carry a valid (empty) IDAT and an IEND, so the file is
 *  well-formed and the ONLY thing wrong with it is its declared size.
 *
 *  The bomb test must additionally assert the rejection's cause carries
 *  libvips' pixel-limit message, distinct from the corrupt-input test's
 *  message — otherwise the two failure modes are indistinguishable and
 *  a real bomb (a valid, complete file that merely decompresses
 *  enormously) would slip through a suite that looks green. */
function pngWithDeclaredSize(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 2; // colour type: truecolour
  // bytes 10-12: compression, filter, interlace — all zero
  const type = Buffer.from("IHDR", "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([signature, length, type, data, crc]);
}

/** CRC-32 as PNG specifies it. Table built once, on first use. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe("normalizeImage", () => {
  it("converts a PNG to WebP", async () => {
    const out = await normalizeImage(await png(400, 300));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(out.width).toBe(400);
    expect(out.height).toBe(300);
  });

  it("records the source dimensions, which the discarded original no longer carries", async () => {
    const out = await normalizeImage(await png(4000, 1000));
    expect(out.sourceWidth).toBe(4000);
    expect(out.sourceHeight).toBe(1000);
  });

  it("fits the longest edge to the ceiling and preserves aspect ratio", async () => {
    const out = await normalizeImage(await png(4000, 1000));
    expect(out.width).toBe(ASSET_IMAGE_MAX_EDGE_PX);
    expect(out.height).toBe(ASSET_IMAGE_MAX_EDGE_PX / 4);
  });

  it("fits the longest edge when the image is portrait", async () => {
    const out = await normalizeImage(await png(1000, 4000));
    expect(out.height).toBe(ASSET_IMAGE_MAX_EDGE_PX);
    expect(out.width).toBe(ASSET_IMAGE_MAX_EDGE_PX / 4);
  });

  it("never upscales a small image", async () => {
    const out = await normalizeImage(await png(100, 80));
    expect(out.width).toBe(100);
    expect(out.height).toBe(80);
  });

  it("strips metadata, including EXIF GPS", async () => {
    const withExif = await sharp(await png(200, 200))
      .withExif({ IFD0: { Copyright: "someone" }, GPS: { GPSLatitudeRef: "N" } })
      .jpeg()
      .toBuffer();
    const out = await normalizeImage(withExif);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("preserves animation when converting an animated GIF", async () => {
    // Two stacked frames, declared as an animated GIF.
    const frames = await sharp({
      create: { width: 32, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .gif()
      .toBuffer();
    const animated = await sharp(frames, { animated: true }).gif().toBuffer();
    const out = await normalizeImage(animated);
    const meta = await sharp(out.bytes, { animated: true }).metadata();
    expect(meta.format).toBe("webp");
    // The format assertion alone would pass for a flattened first frame,
    // which is exactly the failure this test exists to catch.
    expect(meta.pages).toBeGreaterThan(1);
  });

  it("rejects a decompression bomb rather than allocating it", async () => {
    // The fixture must DECLARE huge dimensions without the test itself
    // allocating them — `sharp({create: {width: 30000, height: 30000}})`
    // would need ~2.7 GB of RGB before it ever reached the code under
    // test, which is the very failure the limit exists to prevent.
    //
    // libvips reads dimensions from the header, so a hand-built PNG
    // whose IHDR claims a huge size is enough to trip the limit. Build
    // the 8-byte PNG signature, then an IHDR chunk (length, "IHDR",
    // width, height, bit depth 8, colour type 2, three zero bytes)
    // with a correct CRC32 over the chunk type and data. No IDAT is
    // needed: the pixel-count check must reject it before any decode.
    const bomb = pngWithDeclaredSize(30000, 30000);
    await expect(normalizeImage(bomb)).rejects.toBeInstanceOf(AssetProcessingError);
  });

  it("rejects SVG, whose loader is blocked", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await expect(normalizeImage(svg)).rejects.toBeInstanceOf(AssetProcessingError);
  });

  it("rejects corrupt input", async () => {
    await expect(normalizeImage(Buffer.from("not an image"))).rejects.toBeInstanceOf(
      AssetProcessingError,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- normalize`
Expected: FAIL — module not found.

- [ ] **Step 3: Install sharp at the required floor**

Run: `pnpm --filter @rovenue/api add sharp@^0.35.3`

Then confirm the resolved version is at or above the floor:

Run: `pnpm --filter @rovenue/api exec node -e "console.log(require('sharp/package.json').version)"`
Expected: `0.35.3` or higher. **If it resolves lower, stop** — the CVE floor in Global Constraints is not negotiable.

- [ ] **Step 4: Write the hardening**

Create `apps/api/src/services/assets/sharp-hardening.ts`:

```ts
import sharp from "sharp";

// =============================================================
// sharp / libvips hardening — applied once, at process start
// =============================================================
//
// We hand attacker-supplied bytes to an image decoder, so the decoder
// gets locked down to the smallest surface that does the job.
//
// The allowlist is the primary control, not `VIPS_BLOCK_UNTRUSTED`.
// "Untrusted" is upstream's classification and can be re-tagged between
// releases; "these four loaders and nothing else" is ours and does not
// move. `VIPS_BLOCK_UNTRUSTED` is still set in the image as a second
// layer (design spec §5.4).
//
// SVG is the specific reason this exists. Rasterising SVG would have
// been genuinely useful — neither SwiftUI nor Android Views render SVG
// natively — but it means handing XML to librsvg, which has a history
// of directory-traversal and external-resource issues, from an
// authenticated dashboard user. Not worth it.
//
// sharp >= 0.35.3 is a hard floor for CVE-2026-33327 / 33328 / 35590 /
// 35591, which land in the GIF, TIFF and VIPS loaders. GIF is on our
// accept list.

/** libvips operation classes for the loaders we accept.
 *
 *  GIF is `VipsForeignLoadNsgif`, NOT `VipsForeignLoadGif` — libvips
 *  moved to libnsgif and the class name followed. This matters more
 *  than a typo normally would: unblocking a class name that does not
 *  exist is a silent no-op, so the wrong name leaves GIF BLOCKED while
 *  the code reads as if it were allowed. Verify any change here by
 *  round-tripping a real file of each type, not by reading the list. */
const ALLOWED_LOADERS = [
  "VipsForeignLoadJpeg",
  "VipsForeignLoadPng",
  "VipsForeignLoadWebp",
  "VipsForeignLoadNsgif",
] as const;

let applied = false;

export function applySharpHardening(): void {
  if (applied) return;
  // Block every loader, then re-enable only ours. Blocking the base
  // class and unblocking children is what makes this an allowlist
  // rather than a denylist that new upstream loaders slip past.
  sharp.block({ operation: ["VipsForeignLoad"] });
  sharp.unblock({ operation: [...ALLOWED_LOADERS] });
  applied = true;
}
```

> If the installed sharp exposes a different block/unblock signature, adapt this call — but the invariant it must produce is unchanged: only the four listed loaders can run. Verify with the SVG rejection test in Step 1, which is the observable proof.

- [ ] **Step 5: Write the normaliser**

Create `apps/api/src/services/assets/normalize.ts`:

```ts
import sharp from "sharp";
import {
  ASSET_IMAGE_MAX_EDGE_PX,
  ASSET_IMAGE_WEBP_QUALITY,
  ASSET_NORMALIZE_POLICY_VERSION,
} from "@rovenue/shared";

// =============================================================
// normalizeImage — the one derivative an uploaded image becomes
// =============================================================
//
// Pure: no database, no storage. One canonical WebP, because the tree
// holds a single plain URL string and therefore cannot carry a
// responsive candidate set (design spec §2.4).
//
// The original is DISCARDED after this runs, which makes the policy
// permanent per asset — hence `sourceWidth`/`sourceHeight`/
// `policyVersion` on the way out. They cannot bring the bytes back,
// but they make "which assets were captured under the old policy"
// answerable.

export class AssetProcessingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetProcessingError";
  }
}

export interface NormalizedImage {
  bytes: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  policyVersion: number;
}

export async function normalizeImage(input: Buffer): Promise<NormalizedImage> {
  try {
    // Both options are already the values we want by default. They are
    // written down anyway so an upstream default change cannot silently
    // remove the decompression-bomb bound, and because sharp's own
    // documentation says to use failOn: 'warning' with untrusted input.
    const pipeline = sharp(input, {
      animated: true,
      limitInputPixels: 268402689,
      failOn: "warning",
    });

    const meta = await pipeline.metadata();
    const sourceWidth = meta.width ?? 0;
    // For an animated image sharp reports the "toilet roll" height;
    // `pageHeight` is the real frame height.
    const sourceHeight = meta.pageHeight ?? meta.height ?? 0;
    if (sourceWidth === 0 || sourceHeight === 0) {
      throw new AssetProcessingError("Image has no usable dimensions");
    }

    const { data, info } = await pipeline
      .resize({
        width: ASSET_IMAGE_MAX_EDGE_PX,
        height: ASSET_IMAGE_MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      // No `.withMetadata()` — omitting it is what strips EXIF, ICC and
      // everything else, GPS coordinates included.
      .webp({ quality: ASSET_IMAGE_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      bytes: data,
      width: info.width,
      height: meta.pages && meta.pages > 1 ? info.height / meta.pages : info.height,
      sourceWidth,
      sourceHeight,
      policyVersion: ASSET_NORMALIZE_POLICY_VERSION,
    };
  } catch (err) {
    if (err instanceof AssetProcessingError) throw err;
    throw new AssetProcessingError("Failed to process image", { cause: err });
  }
}
```

- [ ] **Step 6: Call the hardening at startup**

In `apps/api/src/index.ts`, near the other process-level setup, add:

```ts
import { applySharpHardening } from "./services/assets/sharp-hardening";

applySharpHardening();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api test -- normalize`
Expected: PASS, all eleven cases — in particular the SVG and bomb rejections, which are what prove the hardening is actually in force.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/assets apps/api/src/index.ts apps/api/tests/services/assets apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): image normalisation with a libvips loader allowlist"
```

---

## Task 5: Capability and atomic quota accounting

**Files:**
- Modify: `apps/api/src/lib/capabilities.ts`
- Create: `apps/api/src/services/assets/quota.ts`
- Test: `apps/api/tests/services/assets/quota.integration.test.ts`

**Interfaces:**
- Consumes: `assetRepo` from Task 2.
- Produces:
  - `getStorageUsage(db, projectId): Promise<{ usedBytes: number; limitBytes: number | null }>`
  - `reserveStorage(db, projectId, bytes): Promise<boolean>` — atomic; `false` means the reservation would exceed the cap
  - Capability `"assets:write"`

- [ ] **Step 1: Write the failing concurrency test**

Create `apps/api/tests/services/assets/quota.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import {
  reserveStorage,
  releaseReservation,
  getStorageUsage,
  UNLIMITED_RESERVATION,
} from "../../../src/services/assets/quota";
import { makeTestDb, seedProject, setTierLimit } from "../../helpers";

let db: Awaited<ReturnType<typeof makeTestDb>>;

beforeAll(async () => {
  db = await makeTestDb();
});

describe("storage quota", () => {
  it("reports usage and the tier limit", async () => {
    const projectId = await seedProject(db, { tier: "free" });
    await setTierLimit(db, "free", 1000);
    const usage = await getStorageUsage(db, projectId);
    expect(usage.usedBytes).toBe(0);
    expect(usage.limitBytes).toBe(1000);
  });

  it("allows a reservation that fits and returns its id", async () => {
    const projectId = await seedProject(db, { tier: "free" });
    await setTierLimit(db, "free", 1000);
    expect(await reserveStorage(db, projectId, 600)).toEqual(expect.any(String));
  });

  it("refuses a reservation that would exceed the cap", async () => {
    const projectId = await seedProject(db, { tier: "free" });
    await setTierLimit(db, "free", 1000);
    expect(await reserveStorage(db, projectId, 600)).toEqual(expect.any(String));
    expect(await reserveStorage(db, projectId, 600)).toBeNull();
  });

  it("frees the reserved bytes again once the reservation is released", async () => {
    const projectId = await seedProject(db, { tier: "free" });
    await setTierLimit(db, "free", 1000);
    const first = await reserveStorage(db, projectId, 900);
    expect(await reserveStorage(db, projectId, 900)).toBeNull();
    await releaseReservation(db, first!);
    // Without the release this stays null forever (until the sweeper),
    // because the reservation keeps counting against the cap.
    expect(await reserveStorage(db, projectId, 900)).toEqual(expect.any(String));
  });

  it("treats a NULL tier limit as unlimited", async () => {
    const projectId = await seedProject(db, { tier: "enterprise" });
    await setTierLimit(db, "enterprise", null);
    expect(await reserveStorage(db, projectId, 10 ** 12)).toBe(UNLIMITED_RESERVATION);
  });

  it("falls back to the free cap for a project with no subscription row", async () => {
    const projectId = await seedProject(db, { withSubscription: false });
    await setTierLimit(db, "free", 1000);
    // Must NOT be unlimited: failing open here would hand every
    // brand-new project unmetered storage.
    expect(await reserveStorage(db, projectId, 2000)).toBeNull();
  });

  // This is the whole point of the task. A read-then-write check lets
  // both of these through; only an atomic conditional UPDATE does not.
  // It must run against real Postgres — a mocked transaction cannot
  // substantiate an atomicity claim.
  it("does not exceed the cap under concurrent reservations", async () => {
    const projectId = await seedProject(db, { tier: "free" });
    await setTierLimit(db, "free", 1000);

    const CONCURRENCY = 20;
    const EACH = 100;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => reserveStorage(db, projectId, EACH)),
    );

    const granted = results.filter(Boolean).length;
    expect(granted).toBe(10); // 10 * 100 = 1000, exactly the cap
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- quota.integration`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the capability**

In `apps/api/src/lib/capabilities.ts`, add to the `Capability` union after `"fonts:write"`:

```ts
  | "assets:write"
```

And to `CAPABILITY_ROLES`, directly after the `fonts:write` entry:

```ts
  // Asset uploads are a project asset like fonts and products —
  // DEVELOPER and above, not GROWTH.
  "assets:write":           ["OWNER", "ADMIN", "DEVELOPER"],
```

- [ ] **Step 4: Write the quota service**

Create `apps/api/src/services/assets/quota.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "@rovenue/db";
import { env } from "../../lib/env";

// =============================================================
// Storage quota — checked and reserved in one statement
// =============================================================
//
// A read-then-write check is a TOCTOU race: two concurrent uploads both
// read a figure under the cap and both proceed. Fonts wave E1
// documented and accepted exactly that race for its family lookup,
// where the loser was one bad row. Here the loser is unbounded
// overshoot of a paid limit, so the check and the reservation happen in
// the same conditional UPDATE.
//
// Usage is derived from the live asset rows rather than kept in a
// separate counter column, so it cannot drift from what actually
// exists. The WHERE clause re-evaluates the sum at write time, under
// the row lock the UPDATE takes.
//
// HOST_MODE=self has no billing, so it has no cap.

export interface StorageUsage {
  usedBytes: number;
  /** null means unlimited. */
  limitBytes: number | null;
}

async function tierLimitBytes(db: Db, projectId: string): Promise<number | null> {
  if (env.HOST_MODE === "self") return null;
  const rows = await db.execute(sql`
    SELECT "billing_tier_limits"."asset_storage_bytes_limit" AS limit_bytes
    FROM "billing_subscriptions"
    JOIN "billing_tier_limits"
      ON "billing_tier_limits"."tier" = "billing_subscriptions"."tier"
     AND "billing_tier_limits"."cycle" = "billing_subscriptions"."cycle"
    WHERE "billing_subscriptions"."project_id" = ${projectId}
    LIMIT 1
  `);
  const row = (rows as unknown as { rows: { limit_bytes: string | null }[] }).rows[0];
  // No subscription row must NOT mean unlimited — that fails OPEN on a
  // paid limit, and every project starts life without one. Fall back to
  // the free tier's cap, which is what such a project is entitled to.
  if (!row) return freeTierLimitBytes(db);
  if (row.limit_bytes === null) return null; // enterprise: genuinely unlimited
  return Number(row.limit_bytes);
}

async function freeTierLimitBytes(db: Db): Promise<number | null> {
  // `billing_tier_limits` is keyed on (tier, cycle), so filtering by
  // tier alone returns TWO rows and `LIMIT 1` picks between them
  // nondeterministically. If either row's limit were NULL that would
  // intermittently read as "unlimited" — a fail-open on the fallback
  // path that exists precisely to avoid failing open.
  const rows = await db.execute(sql`
    SELECT "billing_tier_limits"."asset_storage_bytes_limit" AS limit_bytes
    FROM "billing_tier_limits"
    WHERE "billing_tier_limits"."tier" = 'free'
      AND "billing_tier_limits"."cycle" = 'monthly'
    LIMIT 1
  `);
  const row = (rows as unknown as { rows: { limit_bytes: string | null }[] }).rows[0];
  if (!row || row.limit_bytes === null) return null;
  return Number(row.limit_bytes);
}

async function usedBytes(db: Db, projectId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM("paywall_assets"."byteSize"), 0) AS used
    FROM "paywall_assets"
    WHERE "paywall_assets"."projectId" = ${projectId}
      AND "paywall_assets"."deletedAt" IS NULL
  `);
  const row = (rows as unknown as { rows: { used: string }[] }).rows[0];
  return Number(row?.used ?? 0);
}

export async function getStorageUsage(
  db: Db,
  projectId: string,
): Promise<StorageUsage> {
  const [used, limit] = await Promise.all([
    usedBytes(db, projectId),
    tierLimitBytes(db, projectId),
  ]);
  return { usedBytes: used, limitBytes: limit };
}

/**
 * Reserve `bytes` against the project's cap. Returns false if the
 * reservation would exceed it.
 *
 * The reservation is a row in `paywall_asset_reservations` inserted
 * only when the live total plus this request still fits, evaluated
 * inside the INSERT ... SELECT ... WHERE so no other transaction can
 * interleave between the check and the write. The caller commits the
 * real asset row in the same transaction and the reservation is
 * released; an upload that dies before committing leaves a reservation
 * the sweeper clears alongside its orphaned object.
 */
export async function reserveStorage(
  db: Db,
  projectId: string,
  bytes: number,
): Promise<string | null> {
  const limit = await tierLimitBytes(db, projectId);
  if (limit === null) return UNLIMITED_RESERVATION;

  const result = await db.execute(sql`
    INSERT INTO "paywall_asset_reservations" ("id", "projectId", "bytes", "createdAt")
    SELECT ${createId()}, ${projectId}, ${bytes}, now()
    WHERE (
      COALESCE((
        SELECT SUM("paywall_assets"."byteSize") FROM "paywall_assets"
        WHERE "paywall_assets"."projectId" = ${projectId}
          AND "paywall_assets"."deletedAt" IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM("paywall_asset_reservations"."bytes")
        FROM "paywall_asset_reservations"
        WHERE "paywall_asset_reservations"."projectId" = ${projectId}
      ), 0)
      + ${bytes}
    ) <= ${limit}
    RETURNING "id"
  `);
  const row = (result as unknown as { rows: { id: string }[] }).rows[0];
  return row?.id ?? null;
}

/** Sentinel for an unlimited project, where no row was inserted and so
 *  there is nothing to release. `releaseReservation` ignores it. */
export const UNLIMITED_RESERVATION = "unlimited";

/**
 * Release a reservation once its asset row is committed. MUST run in
 * the same transaction as the row insert: a reservation that outlives
 * its upload holds the bytes against the cap TWICE — once as the
 * reservation, once as the committed row — until the sweeper clears it
 * hours later.
 */
export async function releaseReservation(db: Db, id: string): Promise<void> {
  if (id === UNLIMITED_RESERVATION) return;
  await db.execute(sql`
    DELETE FROM "paywall_asset_reservations"
    WHERE "paywall_asset_reservations"."id" = ${id}
  `);
}
```

> **Serialisation note.** `INSERT … SELECT … WHERE` under Postgres' default READ COMMITTED can still let two concurrent inserts each see a pre-insert sum. Take a per-project advisory lock for the duration of the reservation so the check and the insert cannot interleave: `SELECT pg_advisory_xact_lock(hashtext(${projectId}))` as the first statement of the surrounding transaction. The concurrency test in Step 1 is what proves this is sufficient — if it reports more than 10 grants, the locking is wrong, not the test.

- [ ] **Step 5: Add the reservations table to the migration**

Append to `packages/db/drizzle/migrations/0099_paywall_assets.sql`:

```sql
-- Short-lived rows holding bytes an in-flight upload has claimed but
-- not yet committed. Without them two concurrent uploads both measure
-- a pre-upload total and both fit.
-- `id` has no DB default: the caller passes a cuid2, matching every
-- other id in this schema. A `gen_random_uuid()` default would make
-- this the one table whose ids are shaped differently.
CREATE TABLE "paywall_asset_reservations" (
  "id"        text PRIMARY KEY NOT NULL,
  "projectId" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "bytes"     integer NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "paywall_asset_reservations_project_idx"
  ON "paywall_asset_reservations" ("projectId");
CREATE INDEX "paywall_asset_reservations_created_at_idx"
  ON "paywall_asset_reservations" ("createdAt");
```

Add the matching Drizzle table to `packages/db/src/drizzle/schema.ts` alongside `paywallAssets`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm db:migrate && pnpm --filter @rovenue/api test -- quota.integration`
Expected: PASS, all five cases — the concurrency case granting exactly 10.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/capabilities.ts apps/api/src/services/assets/quota.ts apps/api/tests/services/assets packages/db
git commit -m "feat(api): assets:write capability and atomic storage quota"
```

---

## Task 6: Upload routes

**Files:**
- Create: `apps/api/src/routes/dashboard/assets.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`
- Test: `apps/api/tests/routes/dashboard/assets.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `assetsRoute` (Hono), mounted at `/dashboard/projects/:projectId/assets`.

**Endpoints:**
- `POST …/assets/image?name=<name>` — raw body
- `POST …/assets/video?name=<name>` — raw body
- `POST …/assets/lottie?name=<name>` — raw body

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/tests/routes/dashboard/assets.test.ts`. Cover, at minimum:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// The store is mocked here; Task 8's integration test exercises the
// real MinIO path. This suite is about the gate ORDER and the typed
// envelopes, which do not need a bucket.
vi.mock("../../../src/lib/asset-store", () => ({
  buildStorageKey: (p: string, a: string) => `${p}/${a}.webp`,
  publicUrl: (k: string) => `https://cdn.test/${k}`,
  parseAssetUrl: () => null,
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  isStorageConfigured: () => true,
}));

describe("POST /dashboard/projects/:projectId/assets/:kind", () => {
  it("rejects a body over the per-kind cap with ASSET_FILE_TOO_LARGE", async () => {
    // Send Content-Length above ASSET_MAX_BYTES.image; bodyLimit must
    // reject off the header without reading the body.
  });

  it("uses the LOTTIE cap on the lottie route, not the video cap", async () => {
    // A 5 MB body is fine for video and too large for lottie. This is
    // what proves the three registrations are independently bound
    // rather than all sharing the loosest limit.
  });

  it("rejects bytes that disagree with the kind in the path", async () => {
    // MP4 bytes posted to .../assets/image -> ASSET_FORMAT_UNSUPPORTED
  });

  it("rejects SVG bytes with ASSET_FORMAT_UNSUPPORTED", async () => {});

  it("rejects an invalid name with ASSET_INVALID_NAME", async () => {
    // "../etc/passwd"
  });

  it("returns ASSET_QUOTA_EXCEEDED before running sharp when the project is full", async () => {
    // Assert the normalise spy was NOT called — this is what pins the
    // gate order, not just the status code.
  });

  it("returns ASSET_STORAGE_UNAVAILABLE when storage is unconfigured", async () => {});

  it("returns the existing asset for a byte-identical re-upload", async () => {
    // One row, one publicUrl, quota charged once.
  });

  it("requires assets:write", async () => {
    // A CUSTOMER_SUPPORT member gets 403.
  });

  it("writes an audit entry on success", async () => {});
});
```

Fill each body out following the existing patterns in `apps/api/tests/routes/dashboard/fonts.test.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- routes/dashboard/assets`
Expected: FAIL — route not found.

- [ ] **Step 3: Write the route**

Create `apps/api/src/routes/dashboard/assets.ts`:

```ts
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, MemberRole } from "@rovenue/db";
import {
  ERROR_CODE,
  ASSET_MAX_BYTES,
  ASSET_CONTENT_TYPES,
  ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
  detectAssetKind,
  isValidAssetName,
  type AssetKind,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { assertProjectCapability } from "../../lib/capabilities";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { fail, ok } from "../../lib/response";
import * as store from "../../lib/asset-store";
import { normalizeImage, AssetProcessingError } from "../../services/assets/normalize";
import {
  reserveStorage,
  releaseReservation,
  getStorageUsage,
} from "../../services/assets/quota";

// =============================================================
// Dashboard: paywall assets — upload, list, delete
// =============================================================
//
// The upload transport is a RAW BODY, not multipart, and that is the
// load-bearing decision here. Hono's `parseBody()` fully buffers the
// request body; at a 50 MB video cap, five concurrent uploads would be
// 250 MB resident in a process that API_REPLICAS multiplies. Fonts
// (routes/dashboard/fonts.ts) could afford multipart because it carried
// four metadata fields and a 2 MB cap. Here the metadata is two query
// params, so multipart buys nothing and costs the buffering.
//
// `bodyLimit` is bound THREE TIMES because its `maxSize` is fixed at
// route-registration time and cannot vary per request. One registration
// would have to use the loosest cap, letting an image upload accept a
// 50 MB body. So the kind is a path segment and each registration binds
// its own kind's real cap.
//
// Gate order is cheapest-first, with one deliberate change from fonts:
// the quota pre-check runs BEFORE format detection, because the next
// step after detection runs sharp, and spending CPU on a project that
// cannot store the result is pointless. Quota is then checked a second
// time against the true post-normalisation size — normalisation
// SHRINKS the input, so a pre-check alone would reject uploads that
// would in fact have fit.

const KIND_TOO_LARGE_MESSAGE: Record<AssetKind, string> = {
  image: `File exceeds the ${ASSET_MAX_BYTES.image}-byte image limit`,
  video: `File exceeds the ${ASSET_MAX_BYTES.video}-byte video limit`,
  lottie: `File exceeds the ${ASSET_MAX_BYTES.lottie}-byte Lottie limit`,
};

function uploadHandler(kind: AssetKind) {
  return async (c: Parameters<Parameters<Hono["post"]>[1]>[0]) => {
    const projectId = c.req.param("projectId");
    const user = c.get("user");
    const name = c.req.query("name") ?? "";

    if (!isValidAssetName(name)) {
      return fail(c, 400, ERROR_CODE.ASSET_INVALID_NAME, "Invalid asset name");
    }
    await assertProjectCapability(projectId, user.id, "assets:write");

    if (!store.isStorageConfigured()) {
      return fail(
        c,
        503,
        ERROR_CODE.ASSET_STORAGE_UNAVAILABLE,
        "Asset storage is not configured",
      );
    }

    // Gate: is the project already at its cap? Cheap, and it avoids
    // running sharp for a result that cannot be stored.
    const usage = await getStorageUsage(drizzle.db, projectId);
    if (usage.limitBytes !== null && usage.usedBytes >= usage.limitBytes) {
      return fail(c, 402, ERROR_CODE.ASSET_QUOTA_EXCEEDED, "Storage quota exhausted");
    }

    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.byteLength > ASSET_MAX_BYTES[kind]) {
      return fail(c, 413, ERROR_CODE.ASSET_FILE_TOO_LARGE, KIND_TOO_LARGE_MESSAGE[kind]);
    }

    const detected = detectAssetKind(raw);
    if (!detected || detected.kind !== kind) {
      return fail(
        c,
        400,
        ERROR_CODE.ASSET_FORMAT_UNSUPPORTED,
        `Bytes do not look like a ${kind}`,
      );
    }

    let bytes = raw;
    let width: number | null = null;
    let height: number | null = null;
    let sourceWidth: number | null = null;
    let sourceHeight: number | null = null;
    let policyVersion = 0;

    if (kind === "image") {
      try {
        const normalized = await normalizeImage(raw);
        bytes = normalized.bytes;
        width = normalized.width;
        height = normalized.height;
        sourceWidth = normalized.sourceWidth;
        sourceHeight = normalized.sourceHeight;
        policyVersion = normalized.policyVersion;
      } catch (err) {
        if (err instanceof AssetProcessingError) {
          return fail(c, 400, ERROR_CODE.ASSET_PROCESSING_FAILED, err.message);
        }
        throw err;
      }
    }

    const contentHash = createHash("sha256").update(bytes).digest("hex");

    // Idempotent upload: identical bytes return the existing row rather
    // than creating a second one, so quota is not charged twice.
    const existing = await drizzle.assetRepo.findLiveAssetByHash(
      drizzle.db,
      projectId,
      contentHash,
    );
    if (existing) {
      return c.json(ok(toDto(existing)));
    }

    const reservationId = await reserveStorage(
      drizzle.db,
      projectId,
      bytes.byteLength,
    );
    if (reservationId === null) {
      return fail(c, 402, ERROR_CODE.ASSET_QUOTA_EXCEEDED, "Storage quota exhausted");
    }

    const assetId = createId();
    const storageKey = store.buildStorageKey(projectId, assetId, kind);

    // Object FIRST, row second, and deliberately NOT in one
    // transaction: an S3 put cannot be rolled back, so a transaction
    // that fails after the put would leave an object that quota — which
    // counts rows — cannot see. The orphan sweeper reclaims the
    // reverse failure.
    await store.putObject(storageKey, bytes, ASSET_CONTENT_TYPES[kind]);

    const asset = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.assetRepo.createAsset(tx, {
        projectId,
        kind,
        name,
        storageKey,
        contentHash,
        contentType: ASSET_CONTENT_TYPES[kind],
        byteSize: bytes.byteLength,
        width,
        height,
        sourceFormat: detected.sourceFormat,
        sourceWidth,
        sourceHeight,
        policyVersion,
      });
      // `audit(entry, callerTx?)` — the entry comes FIRST and the
      // transaction second. Field names are `userId` / `resource` /
      // `resourceId` (see the `AuditEntry` interface in
      // apps/api/src/lib/audit.ts), and actions are past tense
      // (`asset.uploaded`, matching `font.uploaded`).
      await audit(
        {
          projectId,
          userId: user.id,
          action: "asset.uploaded",
          resource: "paywall_asset",
          resourceId: row.id,
          after: { kind, name, byteSize: row.byteSize, contentHash: row.contentHash },
          ...extractRequestContext(c),
        },
        tx,
      );
      // Same transaction as the insert, deliberately. The reservation
      // and the committed row both count against the cap, so a
      // reservation that outlives its upload charges the bytes twice
      // until the sweeper clears it hours later.
      await releaseReservation(tx, reservationId);
      return row;
    });

    return c.json(ok(toDto(asset)), 201);
  };
}

function toDto(asset: { storageKey: string } & Record<string, unknown>) {
  return { ...asset, url: store.publicUrl(asset.storageKey) };
}

export const assetsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .use(
    "*",
    endpointRateLimit({
      name: "asset-upload",
      max: ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
      identify: (c) => `${c.req.param("projectId")}`,
    }),
  );

// Three registrations, one handler factory — see the module comment.
for (const kind of ["image", "video", "lottie"] as const) {
  assetsRoute.post(
    `/${kind}`,
    bodyLimit({
      maxSize: ASSET_MAX_BYTES[kind],
      onError: (c) =>
        c.json(
          { error: { code: ERROR_CODE.ASSET_FILE_TOO_LARGE, message: KIND_TOO_LARGE_MESSAGE[kind] } },
          413,
        ),
    }),
    uploadHandler(kind),
  );
}
```

> **Video streaming refinement.** The handler above buffers via `arrayBuffer()`, which is correct for images and Lottie but defeats the purpose for video. For `kind === "video"`, pipe `c.req.raw.body` through a hashing transform straight into `store.putObject` instead, and take the byte count from the transform. Implement that in this task and cover it with the 50 MB case in Task 8's integration test.

- [ ] **Step 4: Mount the route**

In `apps/api/src/routes/dashboard/index.ts`, alongside the fonts mount:

```ts
.route("/projects/:projectId/assets", assetsRoute)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api test -- routes/dashboard/assets`
Expected: PASS, all ten cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/assets.ts apps/api/src/routes/dashboard/index.ts apps/api/tests/routes/dashboard/assets.test.ts
git commit -m "feat(api): raw-body asset upload routes with per-kind limits"
```

---

## Task 7: List and delete routes

**Files:**
- Modify: `apps/api/src/routes/dashboard/assets.ts`
- Test: `apps/api/tests/routes/dashboard/assets.test.ts`

**Interfaces:**
- Produces:
  - `GET …/assets` → `{ data: { assets: AssetDto[]; usage: { usedBytes, limitBytes } } }`
  - `GET …/assets/:id/usage` → `{ data: { publishedPaywalls: { id: string; name: string }[] } }`
  - `DELETE …/assets/:id` → `{ data: { deleted: true } }`

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/tests/routes/dashboard/assets.test.ts`:

```ts
describe("GET /dashboard/projects/:projectId/assets", () => {
  it("lists live assets with their public URLs and the project's usage", async () => {});
  it("omits soft-deleted assets", async () => {});
  it("does not leak another project's assets", async () => {});
});

describe("GET .../assets/:id/usage", () => {
  it("returns the published paywalls referencing the asset", async () => {});
  it("returns an empty list for an asset only a draft references", async () => {
    // The index covers published versions only (design spec §7). This
    // test pins that boundary so it reads as intended, not as a bug.
  });
});

describe("DELETE .../assets/:id", () => {
  it("soft-deletes the row and then deletes the object, in that order", async () => {
    // Assert the ordering explicitly: the row must be tombstoned before
    // deleteObject is called. The reverse order would leave a live row
    // pointing at nothing, which is a 404 for every published paywall.
  });
  it("returns 404 for another project's asset", async () => {});
  it("requires assets:write", async () => {});
  it("writes an audit entry", async () => {});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @rovenue/api test -- routes/dashboard/assets`
Expected: FAIL on the new cases.

- [ ] **Step 3: Add the handlers**

Append to `apps/api/src/routes/dashboard/assets.ts`:

```ts
assetsRoute
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const [assets, usage] = await Promise.all([
      drizzle.assetRepo.listAssets(drizzle.db, projectId),
      getStorageUsage(drizzle.db, projectId),
    ]);
    return c.json(ok({ assets: assets.map(toDto), usage }));
  })
  .get("/:id/usage", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const asset = await drizzle.assetRepo.findAssetById(drizzle.db, projectId, id);
    if (!asset) {
      return fail(c, 404, ERROR_CODE.NOT_FOUND, "Asset not found");
    }
    const publishedPaywalls = await drizzle.assetRepo.listPublishedUsage(
      drizzle.db,
      id,
    );
    return c.json(ok({ publishedPaywalls }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "assets:write");

    const asset = await drizzle.assetRepo.findAssetById(drizzle.db, projectId, id);
    if (!asset) {
      return fail(c, 404, ERROR_CODE.NOT_FOUND, "Asset not found");
    }

    // Row first, object second (design spec §5.8). A failed object
    // delete leaves an orphan the sweeper reclaims; the reverse order
    // would leave a live row pointing at nothing.
    await drizzle.db.transaction(async (tx) => {
      await drizzle.assetRepo.softDeleteAsset(tx, projectId, id);
      await audit(
        {
          projectId,
          userId: user.id,
          action: "asset.deleted",
          resource: "paywall_asset",
          resourceId: id,
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    // The row is already tombstoned and the delete has substantially
    // succeeded, so a storage failure here must NOT surface as a 500 —
    // that would tell the caller the delete failed when it did not, and
    // invite a retry that can only 404. Log it and let the orphan
    // sweeper reclaim the object.
    try {
      await store.deleteObject(asset.storageKey);
    } catch (err) {
      logger.error(
        { err, assetId: id, storageKey: asset.storageKey },
        "asset row deleted but storage object delete failed; sweeper will reclaim",
      );
    }

    return c.json(ok({ deleted: true }));
  });
```

- [ ] **Step 4: Add `listPublishedUsage` to the repository**

In `packages/db/src/drizzle/repositories/assets.ts`:

```ts
/** Published paywalls referencing this asset. Scoped to a paywall's
 *  CURRENT published version, not every version that ever used it —
 *  the warning is about what breaks now, not what once referenced it. */
export async function listPublishedUsage(
  db: Db,
  assetId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT "paywalls"."id" AS id, "paywalls"."name" AS name
    FROM "paywall_asset_usages"
    JOIN "paywalls"
      ON "paywalls"."id" = "paywall_asset_usages"."paywallId"
     AND "paywalls"."publishedVersionId" = "paywall_asset_usages"."versionId"
    WHERE "paywall_asset_usages"."assetId" = ${assetId}
  `);
  return (rows as unknown as { rows: { id: string; name: string }[] }).rows;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api test -- routes/dashboard/assets`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/assets.ts packages/db/src/drizzle/repositories/assets.ts apps/api/tests/routes/dashboard/assets.test.ts
git commit -m "feat(api): asset list, usage lookup and delete"
```

---

## Task 8: End-to-end integration against real MinIO

**Files:**
- Test: `apps/api/tests/routes/dashboard/assets.integration.test.ts`
- Modify: `apps/api/tests/helpers.ts` (MinIO testcontainer)

**Interfaces:**
- Consumes: everything from Tasks 1–7. Produces no production code — this task's deliverable is evidence.

- [ ] **Step 1: Add a MinIO testcontainer helper**

In `apps/api/tests/helpers.ts`:

```ts
import { GenericContainer } from "testcontainers";

export async function startMinio() {
  const container = await new GenericContainer("minio/minio:latest")
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: "testkey",
      MINIO_ROOT_PASSWORD: "testsecret",
    })
    .withExposedPorts(9000)
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  process.env.ASSET_STORAGE_ENDPOINT = endpoint;
  process.env.ASSET_STORAGE_BUCKET = "rovenue-test";
  process.env.ASSET_STORAGE_ACCESS_KEY_ID = "testkey";
  process.env.ASSET_STORAGE_SECRET_ACCESS_KEY = "testsecret";
  process.env.ASSET_PUBLIC_BASE_URL = `${endpoint}/rovenue-test`;
  // Create the bucket before any test runs.
  return container;
}
```

> The service ClickHouse client reads a frozen env parsed at import; check whether `apps/api/src/lib/env.ts` does the same. If it does, mutate `env` directly rather than `process.env`, as the ClickHouse integration tests already have to.

- [ ] **Step 2: Write the integration tests**

Create `apps/api/tests/routes/dashboard/assets.integration.test.ts`:

```ts
describe("asset upload against real storage", () => {
  it("stores an image and serves the bytes back from its public URL", async () => {
    // Upload a PNG -> assert 201, a row exists, and fetching the
    // returned `url` yields WebP bytes.
  });

  it("streams a 50 MB video without buffering it whole", async () => {
    // Upload at the cap. Assert success and that peak RSS during the
    // upload stays well below the file size — this is the claim the
    // raw-body transport exists to make, and it is worth measuring
    // rather than assuming.
  });

  it("charges quota once for a byte-identical re-upload", async () => {
    // Two uploads, one row, one object, usedBytes unchanged after the
    // second.
  });

  it("removes the object when the asset is deleted", async () => {
    // After DELETE, fetching the public URL 404s.
  });

  it("frees the content hash for re-upload after deletion", async () => {
    // The unique index is partial on deleted_at; upload, delete,
    // upload the same bytes again -> succeeds with a new id.
  });

  it("does not exceed the tier cap under concurrent uploads", async () => {
    // Real Postgres, real concurrency, real objects.
  });
});
```

- [ ] **Step 3: Run and verify**

Run: `pnpm --filter @rovenue/api test -- assets.integration`
Expected: PASS. Note the actual peak-RSS figure from the video case in the commit message — an unmeasured streaming claim is not evidence.

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests
git commit -m "test(api): asset pipeline end-to-end against real MinIO"
```

---

## Task 9: Orphan sweeper

**Files:**
- Create: `apps/api/src/workers/asset-orphan-sweeper.ts`
- Test: `apps/api/tests/workers/asset-orphan-sweeper.integration.test.ts`

**Interfaces:**
- Consumes: `store.listAllKeys`, `store.deleteObject`, `assetRepo`, `ASSET_ORPHAN_GRACE_HOURS`.
- Produces: `sweepOrphanedAssets(): Promise<{ reclaimed: number }>`

- [ ] **Step 1: Write the failing test**

```ts
describe("sweepOrphanedAssets", () => {
  it("reclaims an object older than the grace window with no live row", async () => {});

  it("leaves an object inside the grace window alone", async () => {
    // This is the case that matters: an upload that has put its object
    // but not yet committed its row looks exactly like an orphan. The
    // grace window is the only thing separating them, so a sweeper that
    // fails this test destroys live uploads.
  });

  it("leaves an object with a live row alone regardless of age", async () => {});

  it("clears reservation rows older than the grace window", async () => {});

  it("reports how many objects it reclaimed", async () => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/api test -- asset-orphan-sweeper`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the sweeper**

```ts
import { sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { ASSET_ORPHAN_GRACE_HOURS } from "@rovenue/shared";
import * as store from "../lib/asset-store";
import { logger } from "../lib/logger";

// =============================================================
// asset-orphan-sweeper
// =============================================================
//
// The other half of "never put an S3 write inside a transaction"
// (design spec §5.8). Creating writes the object first and commits the
// row second; if the commit fails, the object is orphaned. Deleting
// tombstones the row first and deletes the object second; if the object
// delete fails, the object is orphaned. Both land here.
//
// The grace window is not a tuning knob — it is correctness. An upload
// that has put its object but not yet committed its row is
// INDISTINGUISHABLE from an orphan, so sweeping without a window
// destroys live uploads.

const MS_PER_HOUR = 60 * 60 * 1000;

export async function sweepOrphanedAssets(): Promise<{ reclaimed: number }> {
  if (!store.isStorageConfigured()) return { reclaimed: 0 };

  const cutoff = new Date(Date.now() - ASSET_ORPHAN_GRACE_HOURS * MS_PER_HOUR);

  const liveKeys = new Set(
    (
      await drizzle.db.execute(sql`
        SELECT "paywall_assets"."storageKey" AS "storageKey"
        FROM "paywall_assets"
        WHERE "paywall_assets"."deletedAt" IS NULL
      `)
    ).rows.map((r: { storageKey: string }) => r.storageKey),
  );

  const allKeys = await store.listAllKeys();
  let reclaimed = 0;
  for (const key of allKeys) {
    if (liveKeys.has(key)) continue;
    // Age comes from the object's own LastModified, not the DB — an
    // orphan by definition may have no row to read a timestamp from.
    const lastModified = await store.getObjectLastModified(key);
    // A null means we could NOT establish the object's age. Skip it.
    //
    // The tempting reading is "HeadObject said NotFound, so the object
    // is already gone, so deleting is a harmless no-op" — and for that
    // specific race it is. But nothing here distinguishes that race
    // from a false NotFound under read-after-write lag, and this is
    // the one component in the product that deletes customer data on
    // its own initiative. "Could not confirm" must not resolve to
    // "delete"; the sweeper runs again on the next cycle, so skipping
    // costs a few hours of retained bytes, while deleting wrongly
    // costs an asset that a published paywall is serving.
    if (lastModified === null || lastModified > cutoff) continue;
    await store.deleteObject(key);
    reclaimed += 1;
  }

  await drizzle.db.execute(sql`
    DELETE FROM "paywall_asset_reservations"
    WHERE "paywall_asset_reservations"."createdAt" < ${cutoff}
  `);

  logger.info({ reclaimed }, "asset orphan sweep complete");
  return { reclaimed };
}
```

Add `getObjectLastModified(key: string): Promise<Date | null>` to `asset-store.ts` using `HeadObjectCommand`.

- [ ] **Step 4: Schedule it**

Register the sweeper on the same daily cadence as the other maintenance workers, in the dedicated dispatcher process rather than every API replica.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api test -- asset-orphan-sweeper`
Expected: PASS, all five cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workers/asset-orphan-sweeper.ts apps/api/src/lib/asset-store.ts apps/api/tests/workers
git commit -m "feat(api): reclaim orphaned asset objects on a grace window"
```

---

## Task 10: Usage index written at publish

**Files:**
- Modify: `packages/db/src/drizzle/repositories/paywalls.ts:166`
- Create: `packages/shared/src/paywall/collect-urls.ts`
- Test: `packages/shared/src/paywall/collect-urls.test.ts`
- Test: `packages/db/src/drizzle/repositories/assets.integration.test.ts`

**Interfaces:**
- Produces:
  - `collectMediaUrls(config: PaywallConfig): string[]`
  - `replaceUsageForVersion(tx, { paywallId, versionId, assetIds }): Promise<void>`

- [ ] **Step 1: Write the failing URL-collection test**

```ts
describe("collectMediaUrls", () => {
  it("collects image light and dark URLs", async () => {});
  it("collects video url and posterUrl", async () => {});
  it("collects lottie url", async () => {});
  it("collects URLs from nested containers", async () => {});
  it("collects URLs from conditional overrides, not just base props", async () => {
    // Overrides can carry their own url (OVERRIDABLE_PROP_KEYS.video
    // includes "url" and "posterUrl"). An override-only asset that the
    // index misses would be deleted without a warning.
  });
  it("collects URLs from cellTemplate subtrees", async () => {});
  it("returns no duplicates", async () => {});
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Walk the tree, reading `url.light` / `url.dark` / `posterUrl` from `image`, `video` and `lottie` nodes, including every node's conditional overrides and any `cellTemplate` subtree.

- [ ] **Step 3: Write the failing publish test**

```ts
it("writes usage rows when a version is published", async () => {});
it("replaces, not appends, when the same version is republished", async () => {});
it("clears rows for an asset the new version no longer references", async () => {});
it("ignores external URLs that are not ours", async () => {});
```

- [ ] **Step 4: Wire it into `setPublishedVersion`**

Inside the existing transaction at `packages/db/src/drizzle/repositories/paywalls.ts:166`: collect the version's media URLs, map them through `parseAssetUrl`, drop nulls, and replace that `versionId`'s rows.

> `parseAssetUrl` lives in `apps/api/src/lib/asset-store.ts`, which `@rovenue/db` cannot import. Pass the resolver in as a parameter from the API layer rather than inverting the dependency.

- [ ] **Step 5: Run the tests, then commit**

```bash
git add packages/shared/src/paywall/collect-urls.ts packages/db/src/drizzle/repositories/paywalls.ts packages/shared/src/paywall/collect-urls.test.ts
git commit -m "feat(paywall): record asset usage when a version is published"
```

---

## Task 11: Dashboard asset library and builder picker

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useAssets.ts`
- Create: `apps/dashboard/src/components/assets/asset-library.tsx`
- Create: `apps/dashboard/src/components/assets/asset-picker-dialog.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/fields.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `apps/dashboard/src/components/assets/asset-library.test.tsx`

> **Re-check `git status` before starting.** Another session had uncommitted changes across `inspector/` when this plan was written. Coordinate rather than overwrite.

**Interfaces:**
- Consumes: the Task 6/7 endpoints.
- Produces: `useAssets(projectId)`, `useUploadAsset(projectId)`, `useDeleteAsset(projectId)`, `<AssetLibrary />`, `<AssetPickerDialog onSelect={(url) => …} kind={...} />`

- [ ] **Step 1: Write the failing component tests**

```tsx
describe("AssetLibrary", () => {
  it("renders each asset with its kind, dimensions and size", () => {});
  it("shows storage used against the tier limit", () => {});
  it("shows 'unlimited' rather than a bar when limitBytes is null", () => {});
  it("reports upload progress rather than a bare spinner", () => {
    // A 50 MB video on a slow uplink is a minutes-long operation; an
    // indeterminate spinner reads as a hang.
  });
  it("warns with the published-paywall count before deleting", () => {});
  it("says 'published paywalls', not 'paywalls', in the warning", () => {
    // The index covers published versions only. Copy that implies
    // drafts are included would make a zero misleading.
  });
  it("surfaces a typed upload error to the user", () => {
    // ASSET_FILE_TOO_LARGE, ASSET_FORMAT_UNSUPPORTED and
    // ASSET_QUOTA_EXCEEDED must each produce a distinct message.
  });
});

describe("AssetPickerDialog", () => {
  it("lists only assets matching the field's kind", () => {});
  it("returns the asset's public URL on select", () => {});
  it("leaves a hand-typed external URL working", () => {
    // Uploading is an option, not a requirement — the field still
    // accepts any URL.
  });
});
```

- [ ] **Step 2: Run to verify they fail, then implement**

Follow `apps/dashboard/src/lib/hooks/useFonts.ts` for the hook shape and the existing dialog components for the picker. Add every user-facing string to `en.json` — no template-literal `t()` keys.

- [ ] **Step 3: Run the tests, typecheck, then commit**

```bash
pnpm --filter @rovenue/dashboard test -- assets
pnpm --filter @rovenue/dashboard build
```

```bash
git add apps/dashboard/src
git commit -m "feat(dashboard): asset library and paywall builder asset picker"
```

---

## Task 12: Deployment configuration

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `apps/api/Dockerfile`
- Create: `deploy/minio/README.md`

- [ ] **Step 1: Add MinIO to compose (self-hosted only)**

A `minio` service with a persistent volume, plus a one-shot `mc` init container that creates the bucket, sets **anonymous read on objects** and leaves **listing disabled**.

This is the **self-hosted** path. The cloud deployment uses R2, and the two are not configured the same way even though they run identical code — see Step 1b.

- [ ] **Step 1b: Public read on R2 is not an ACL**

`mc anonymous set download` is MinIO-specific. **R2 does not implement S3 object ACLs at all** — a `putObject` carrying an ACL is ignored, and there is no per-object public flag to set. Public read on R2 comes from the *bucket*: either an `r2.dev` development subdomain or, for production, a **custom domain bound through Cloudflare**.

Use the custom domain. Two reasons beyond tidiness:

- `r2.dev` is rate-limited and explicitly not for production traffic.
- §6 requires the asset origin to sit **outside the session cookie's scope**. A custom domain is the only way to control that; it is also what puts Cloudflare's cache in front, which is the whole point of §2.2 keeping the API out of the serving path.

Note the two env vars are deliberately different values on R2 and must not be conflated:
- `ASSET_STORAGE_ENDPOINT` = `https://<accountid>.r2.cloudflarestorage.com` (the S3 write API)
- `ASSET_PUBLIC_BASE_URL` = `https://cdn.<domain>` (the public read origin)

On MinIO they happen to share a host, which is exactly why a MinIO-only test would not catch conflating them.

Verify on R2 specifically, since neither the unit tests nor the MinIO integration tests exercise it: an uploaded object is publicly readable at `ASSET_PUBLIC_BASE_URL`, the bucket is **not** listable, and `Cache-Control: immutable` survives to the client.

- [ ] **Step 2: Set `VIPS_BLOCK_UNTRUSTED` in the API image**

In `apps/api/Dockerfile`'s runtime stage:

```dockerfile
ENV VIPS_BLOCK_UNTRUSTED=1
```

Second layer only — the loader allowlist from Task 4 is the primary control.

- [ ] **Step 3: Document the env vars in `.env.example`**

All six `ASSET_STORAGE_*` / `ASSET_PUBLIC_BASE_URL` variables, with a note that uploads degrade to `ASSET_STORAGE_UNAVAILABLE` when unset.

- [ ] **Step 4: Verify sharp's musl binary is present in the built image**

The API image is `node:22-alpine`. sharp ships prebuilt musl binaries, and the `deps` stage installs inside the same image — but verify rather than reason:

```bash
docker compose build api
docker compose run --rm api node -e "const s=require('sharp'); console.log(s.versions); s({create:{width:8,height:8,channels:3,background:'#000'}}).webp().toBuffer().then(b=>console.log('ok',b.length))"
```

Expected: version output and `ok <n>`. **If this fails, the feature does not work in production** regardless of how green the local tests are.

- [ ] **Step 5: Verify the asset domain does not receive the session cookie**

Confirm the Better Auth cookie's `Domain` attribute does not cover the asset host. If it is set to `.rovenue.app` and assets are served from `cdn.rovenue.app`, every asset request carries the session cookie — fix the cookie scope, not the asset host.

- [ ] **Step 6: Full clean build**

```bash
rm -rf node_modules && pnpm install --frozen-lockfile && pnpm build --force
```

Local `node_modules` drift has masked deploy blockers in this repo before.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml .env.example apps/api/Dockerfile deploy/minio
git commit -m "chore(deploy): MinIO service and asset storage configuration"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2.1 scope / §3 architecture | 1–4 |
| §2.2 byte path | 3, 6 |
| §2.3 plain URL + usage index | 10 |
| §2.4 / §5.5 normalisation | 4 |
| §2.5 source metadata | 1, 2, 4 |
| §2.6 / §8 quota | 5 |
| §2.7 AssetStore seam | 3 |
| §3.1 raw-body transport | 6, 8 |
| §3.2 three `bodyLimit` bindings | 6 |
| §4 data model | 2 |
| §4.1 immutability | 2 |
| §4.2 idempotent upload | 2, 6, 8 |
| §5.1 gate order | 6 |
| §5.2 capability | 5 |
| §5.3 kind detection | 1, 6 |
| §5.4 sharp hardening, version floor, name validation | 1, 4, 12 |
| §5.6 video verbatim | 6 |
| §5.7 poster non-goal | 11 (help text) |
| §5.8 tx ordering + sweeper | 6, 7, 9 |
| §5.9 rate limiting | 6 |
| §6 serving headers, bucket ACL, cookie scope | 3, 12 |
| §7 usage index + boundary copy | 10, 11 |
| §9 dashboard | 11 |
| §10 configuration | 3, 12 |
| §11 error codes | 1 |
| §12 testing | throughout, 8 |

No spec section is unimplemented.

**Known soft spots, called out rather than hidden**

- Task 6 Step 3 gives the buffered handler in full and describes the video streaming variant in prose rather than code. The integration test in Task 8 is what holds it honest — including the peak-RSS measurement, which is the only thing that distinguishes real streaming from a buffered implementation that happens to work.
- Task 4's `sharp.block` call may need adapting to the installed version's signature. The SVG rejection test is the observable contract; the exact call is not.
- Tasks 7, 9, 10 and 11 give test names and intent rather than full bodies for the more mechanical cases. Each names what it must prove.
- Task 5's advisory-lock note is load-bearing: without it the `INSERT … SELECT … WHERE` is still racy under READ COMMITTED. The concurrency test is the gate.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-paywall-asset-cdn.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.
