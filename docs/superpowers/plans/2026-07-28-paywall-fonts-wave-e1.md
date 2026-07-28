# Paywall fonts wave E1 (the asset pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project upload, list and delete font files, and serve them to devices from an immutably-cached endpoint.

**Architecture:** Two Postgres tables — a `font_families` grouping row and `font_faces` rows holding the bytes as `bytea` — because this repo has no asset storage and a mounted volume would break under `API_REPLICAS`. Upload is the product's first multipart endpoint: it validates size, count and **magic bytes**, and deliberately never parses the font. Devices fetch a face from a public-key-authenticated route that caches for a year, since a face's bytes never change.

**Tech Stack:** Hono + TypeScript (strict), Zod, Drizzle + PostgreSQL, Vitest (unit + testcontainers integration), React (Vite) for the dashboard screen.

**Spec:** `docs/superpowers/specs/2026-07-28-paywall-fonts-wave-e1-design.md`. Read §3 (the security posture) and §4.1 (what deleting a font does) before starting.

## Global Constraints

- **No magic values.** Every literal is a named constant.
- `FONT_FACE_MAX_BYTES = 2 * 1024 * 1024`; `FONT_FACES_MAX_PER_PROJECT = 24`; `FONT_FILE_CACHE_MAX_AGE_SECONDS = 31536000`; `FONT_ALLOWED_FORMATS = ["otf", "ttf", "woff2"]`.
- **The server never parses a font.** Family name, weight and style are declared by the uploader. Magic bytes are a shape check, not a parse. Do not add a font-parsing dependency.
- **Format is decided by our own magic-byte table**, never by the filename and never by a library's opinion.
- Postgres access via Drizzle only — repositories under `packages/db/src/drizzle/repositories`. Raw SQL only via the `sql` template when truly necessary, and in `sql` qualify columns (`"font_faces"."id"`) — a bare `${table.col}` renders unqualified and breaks correlated subqueries.
- All responses are `{ data: T }` or `{ error: { code, message } }`. Use the existing `ok()` helper.
- All IDs are cuid2; timestamps UTC.
- Deleting a family a paywall references **is allowed** — see spec §4.1. Do not add a blocking check.
- Never create or switch branches or worktrees; commit on the current branch. `git add` only the files the task touches — never `git add -A`. **A parallel agent is active in this repo** and is also landing migrations; on an `index.lock` error, wait ~5 seconds and retry.
- **A test that passes with the feature broken is worse than no test.** Mutation-check every claim; where no test can catch a defect, say so plainly. **Never describe a test you did not write.**

---

## File Structure

**Database** (Task 1)
- `packages/db/src/drizzle/schema.ts` — `fontFamilies`, `fontFaces` tables
- `packages/db/drizzle/migrations/00NN_paywall_fonts.sql` — see the numbering warning in Task 1
- `packages/db/src/drizzle/repositories/fonts.ts` (new) — reads and writes
- `packages/db/src/drizzle/repositories/index.ts` — barrel export

**Format validation** (Task 2)
- `packages/shared/src/fonts/format.ts` (new) — the magic-byte table, pure
- `packages/shared/src/fonts/index.ts` (new) — barrel

**API** (Tasks 3–5)
- `apps/api/src/routes/dashboard/fonts.ts` (new) — upload, list, delete
- `apps/api/src/routes/dashboard/index.ts` — mount
- `apps/api/src/routes/v1/fonts.ts` (new) — the public file route
- `apps/api/src/routes/v1/index.ts` — mount

**Dashboard** (Task 6)
- `apps/dashboard/src/pages/settings/fonts.tsx` (new) and its route registration
- `apps/dashboard/src/lib/hooks/useFonts.ts` (new)
- `apps/dashboard/src/i18n/locales/en.json`

---

### Task 1: Tables, migration and repository

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/00NN_paywall_fonts.sql`
- Create: `packages/db/src/drizzle/repositories/fonts.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts`
- Test: `packages/db/src/drizzle/repositories/fonts.integration.test.ts`

**Interfaces:**
- Produces: `fontFamilies`, `fontFaces` (Drizzle tables); and from the repo —
  `createFamily(db, { projectId, name }): Promise<FontFamily>`,
  `upsertFace(db, { familyId, weight, style, format, bytes }): Promise<FontFace>`,
  `listFamiliesWithFaces(db, projectId): Promise<FamilyWithFaces[]>` (**metadata only, never bytes**),
  `findFaceBytes(db, faceId): Promise<{ bytes: Buffer; format: string; projectId: string } | null>`,
  `countFacesForProject(db, projectId): Promise<number>`,
  `softDeleteFamily(db, familyId): Promise<void>`.

**⚠ Migration numbering:** the highest migration when this plan was written was `0096_paywall_preview_sessions.sql`, landed by a parallel agent working on a different phase. **Run `ls packages/db/drizzle/migrations | sort | tail -3` immediately before you generate yours** and take the next free number. If you collide with a migration that appeared while you worked, renumber yours — do not renumber theirs.

- [ ] **Step 1: Write the failing integration test**

`fonts.integration.test.ts` — these use testcontainers against real Postgres, because `bytea` round-tripping, the uniqueness constraint and cascade deletes are exactly what a mocked DB would lie about.

```ts
it("round-trips face bytes unchanged", async () => {
  const family = await drizzle.fontRepo.createFamily(db, { projectId, name: "Brand Sans" });
  const bytes = Buffer.from([0x4f, 0x54, 0x54, 0x4f, 0x01, 0x02, 0x03]);
  const face = await drizzle.fontRepo.upsertFace(db, {
    familyId: family.id, weight: 400, style: "normal", format: "otf", bytes,
  });
  const found = await drizzle.fontRepo.findFaceBytes(db, face.id);
  expect(found?.bytes.equals(bytes)).toBe(true);
});

it("replaces the face for a repeated weight and style rather than duplicating", async () => {
  const family = await drizzle.fontRepo.createFamily(db, { projectId, name: "Brand Sans" });
  await drizzle.fontRepo.upsertFace(db, { familyId: family.id, weight: 400, style: "normal", format: "otf", bytes: Buffer.from([1]) });
  await drizzle.fontRepo.upsertFace(db, { familyId: family.id, weight: 400, style: "normal", format: "otf", bytes: Buffer.from([2]) });
  const [withFaces] = await drizzle.fontRepo.listFamiliesWithFaces(db, projectId);
  expect(withFaces?.faces).toHaveLength(1);
});

it("deleting a family removes its faces", async () => {
  const family = await drizzle.fontRepo.createFamily(db, { projectId, name: "Brand Sans" });
  const face = await drizzle.fontRepo.upsertFace(db, { familyId: family.id, weight: 400, style: "normal", format: "otf", bytes: Buffer.from([1]) });
  await drizzle.fontRepo.softDeleteFamily(db, family.id);
  expect(await drizzle.fontRepo.listFamiliesWithFaces(db, projectId)).toHaveLength(0);
  expect(await drizzle.fontRepo.findFaceBytes(db, face.id)).toBeNull();
});

it("listFamiliesWithFaces does not select the bytes column", async () => {
  const family = await drizzle.fontRepo.createFamily(db, { projectId, name: "Brand Sans" });
  await drizzle.fontRepo.upsertFace(db, { familyId: family.id, weight: 400, style: "normal", format: "otf", bytes: Buffer.from([1, 2, 3]) });
  const [withFaces] = await drizzle.fontRepo.listFamiliesWithFaces(db, projectId);
  expect(withFaces?.faces[0]).not.toHaveProperty("bytes");
  expect(withFaces?.faces[0]?.byteSize).toBe(3);
});
```

That last test is the one worth getting right: asserting only the response shape would pass while the blob was being read and thrown away. Asserting the absence of the property, plus the denormalised `byteSize`, pins that the cheap query stayed cheap.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/db && DATABASE_URL=<your test url> npx vitest run src/drizzle/repositories/fonts.integration.test.ts`
Expected: FAIL — `fontRepo` does not exist. Note `@rovenue/db`'s vitest needs `DATABASE_URL` exported.

- [ ] **Step 3: Add the tables**

In `schema.ts`, following the `paywalls` table's conventions (`text("id").primaryKey().$defaultFn(() => createId())`, `projectId` referencing `projects.id` with `onDelete: "cascade"`):

```ts
export const fontFamilies = pgTable("font_families", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  projectId: text("projectId").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deletedAt", { withTimezone: true }),
});

export const fontFaces = pgTable(
  "font_faces",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    familyId: text("familyId").notNull().references(() => fontFamilies.id, { onDelete: "cascade" }),
    weight: integer("weight").notNull(),
    style: text("style").notNull(),
    format: text("format").notNull(),
    bytes: customType<{ data: Buffer }>({ dataType: () => "bytea" })("bytes").notNull(),
    byteSize: integer("byteSize").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ faceKey: uniqueIndex("font_faces_family_weight_style_key").on(t.familyId, t.weight, t.style) }),
);
```

If the file already has a `bytea` custom type helper, use it rather than declaring a second one.

- [ ] **Step 4: Generate and check the migration**

Run: `pnpm db:migrate:generate`

Then **read the generated SQL before committing it.** A known gotcha in this repo: `drizzle-kit generate` has previously swept hand-written DDL from earlier migrations into a new file. Trim anything that is not these two tables.

- [ ] **Step 5: Write the repository**

`softDeleteFamily` sets `deletedAt`; every read filters it out. `findFaceBytes` returns `null` for a face whose family is soft-deleted — that is what the third test pins, and it is what keeps a deleted font from continuing to serve.

- [ ] **Step 6: Run the tests**

Run the same command as Step 2. Expected: all four PASS.

- [ ] **Step 7: Mutation-check**

Drop the unique index from the migration and confirm the replace test fails. Restore. Then make `listFamiliesWithFaces` select `bytes` and confirm the fourth test fails. Restore.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations packages/db/src/drizzle/repositories/fonts.ts packages/db/src/drizzle/repositories/index.ts packages/db/src/drizzle/repositories/fonts.integration.test.ts
git commit -m "feat(db): font families and faces"
```

---

### Task 2: Magic-byte format validation

**Files:**
- Create: `packages/shared/src/fonts/format.ts`
- Create: `packages/shared/src/fonts/index.ts`
- Test: `packages/shared/src/fonts/format.test.ts`

**Interfaces:**
- Produces: `FONT_ALLOWED_FORMATS`, `FONT_FACE_MAX_BYTES`, `FONT_FACES_MAX_PER_PROJECT`, `FONT_FILE_CACHE_MAX_AGE_SECONDS`, `FONT_CONTENT_TYPES: Record<FontFormat, string>`, `type FontFormat = "otf" | "ttf" | "woff2"`, and `detectFontFormat(bytes: Uint8Array): FontFormat | null`.

This is the security core of the wave and it is entirely pure, so it gets real tests rather than a smoke item. **The server never parses the font** — this reads a handful of leading bytes and nothing more.

- [ ] **Step 1: Write the failing tests**

```ts
it("detects OTF from its OTTO signature", () => {
  expect(detectFontFormat(new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x00]))).toBe("otf");
});

it("detects TTF from both of its signatures", () => {
  expect(detectFontFormat(new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]))).toBe("ttf");
  expect(detectFontFormat(new Uint8Array([0x74, 0x72, 0x75, 0x65, 0x00]))).toBe("ttf"); // "true"
});

it("detects WOFF2 from its wOF2 signature", () => {
  expect(detectFontFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00]))).toBe("woff2");
});

it("rejects WOFF1, which the platforms cannot all load", () => {
  expect(detectFontFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0x00]))).toBeNull(); // "wOFF"
});

it("rejects a file too short to carry a signature", () => {
  expect(detectFontFormat(new Uint8Array([0x4f, 0x54]))).toBeNull();
});

it("rejects arbitrary content", () => {
  expect(detectFontFormat(new TextEncoder().encode("<html>"))).toBeNull();
});
```

Use **real byte prefixes**, as above. A helper that returns what the test wants would prove nothing — this function's whole job is reading actual bytes.

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/shared && npx vitest run src/fonts/format.test.ts`

- [ ] **Step 3: Implement**

```ts
export type FontFormat = "otf" | "ttf" | "woff2";

export const FONT_ALLOWED_FORMATS: readonly FontFormat[] = ["otf", "ttf", "woff2"];

/** One uploaded face. 2 MB comfortably holds a full-featured OTF. */
export const FONT_FACE_MAX_BYTES = 2 * 1024 * 1024;
/** Four families at six weights — a bound on storage, not a ration. */
export const FONT_FACES_MAX_PER_PROJECT = 24;
/** A face's bytes never change (a re-upload creates a new row), so the
 *  served file is immutable for a year. */
export const FONT_FILE_CACHE_MAX_AGE_SECONDS = 31536000;

export const FONT_CONTENT_TYPES: Record<FontFormat, string> = {
  otf: "font/otf",
  ttf: "font/ttf",
  woff2: "font/woff2",
};

/** Leading-byte signatures. WOFF1 is deliberately absent: not every
 *  platform loader accepts it, and accepting an upload that works on one
 *  platform only is the failure this wave's design removed. */
const SIGNATURES: ReadonlyArray<{ format: FontFormat; magic: readonly number[] }> = [
  { format: "otf", magic: [0x4f, 0x54, 0x54, 0x4f] },            // "OTTO"
  { format: "ttf", magic: [0x00, 0x01, 0x00, 0x00] },
  { format: "ttf", magic: [0x74, 0x72, 0x75, 0x65] },            // "true"
  { format: "woff2", magic: [0x77, 0x4f, 0x46, 0x32] },          // "wOF2"
];

const SIGNATURE_LENGTH = 4;

/** The format a file's own bytes claim, or null. NOT a parse — this reads
 *  four bytes. Font parsers have a long history of memory-safety bugs and
 *  running one over an attacker-supplied file on our servers, to save the
 *  uploader typing a family name, is a bad trade. */
export function detectFontFormat(bytes: Uint8Array): FontFormat | null {
  if (bytes.length < SIGNATURE_LENGTH) return null;
  for (const { format, magic } of SIGNATURES) {
    if (magic.every((b, i) => bytes[i] === b)) return format;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/shared && npx vitest run src/fonts/format.test.ts`
Expected: all PASS. Then run the whole shared suite to confirm the new barrel breaks nothing.

- [ ] **Step 5: Mutation-check**

Add WOFF1's `wOFF` signature to the table and confirm the "rejects WOFF1" test fails. Restore. Then drop the length guard and confirm the too-short test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/fonts
git commit -m "feat(shared): detect font format from magic bytes"
```

---

### Task 3: Upload endpoint

**Files:**
- Create: `apps/api/src/routes/dashboard/fonts.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`
- Test: `apps/api/tests/routes/dashboard/fonts.test.ts`

**Interfaces:**
- Consumes: `drizzle.fontRepo` (Task 1); `detectFontFormat`, `FONT_FACE_MAX_BYTES`, `FONT_FACES_MAX_PER_PROJECT` (Task 2).
- Produces: `POST /dashboard/projects/:projectId/fonts` accepting multipart with fields `file`, `familyName` **or** `familyId`, `weight`, `style`.

This is the product's **first multipart endpoint**. Follow `audiences.ts` for the surrounding shape: `requireDashboardAuth`, `assertProjectAccess`, `assertProjectCapability`, `validate` with Zod for the non-file fields, `ok()` for the response, and `audit()` inside the caller's transaction.

Hono parses multipart via `await c.req.parseBody()`; the file arrives as a `File`.

**Note on `process.env` in this package's tests:** top-of-file `process.env` assignments before imports are dead code — import hoisting parses `lib/env` first. Use `vi.hoisted` or `tests/setup.ts` with `??=`.

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects a file whose bytes do not match any allowed format", async () => {
  const res = await uploadFont({ bytes: new TextEncoder().encode("<html>"), familyName: "Brand", weight: 400, style: "normal" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe("FONT_FORMAT_UNSUPPORTED");
});

it("rejects a file over the size cap", async () => {
  const bytes = new Uint8Array(FONT_FACE_MAX_BYTES + 1);
  bytes.set([0x4f, 0x54, 0x54, 0x4f]);
  const res = await uploadFont({ bytes, familyName: "Brand", weight: 400, style: "normal" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe("FONT_FILE_TOO_LARGE");
});

it("rejects an upload past the per-project face cap", async () => {
  // seed FONT_FACES_MAX_PER_PROJECT faces first
  const res = await uploadFont({ bytes: otfBytes(), familyName: "One More", weight: 400, style: "normal" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe("FONT_QUOTA_EXCEEDED");
});

it("stores the detected format, ignoring the filename", async () => {
  const res = await uploadFont({ bytes: otfBytes(), filename: "brand.ttf", familyName: "Brand", weight: 400, style: "normal" });
  expect(res.status).toBe(200);
  expect((await res.json()).data.format).toBe("otf");
});
```

That last test is the point of the whole task: the filename says `.ttf`, the bytes say OTF, and the bytes win.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/api && npx vitest run tests/routes/dashboard/fonts.test.ts`

- [ ] **Step 3: Implement the route**

Order the checks cheapest-first — size before format before quota — so a 50 MB upload is rejected without a quota query. Write an `audit()` entry for the upload inside the same transaction as the insert.

- [ ] **Step 4: Mount it**

In `apps/api/src/routes/dashboard/index.ts`, beside the others: `.route("/fonts", fontsRoute)`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run tests/routes/dashboard/fonts.test.ts`
Expected: all PASS.

- [ ] **Step 6: Mutation-check**

Make the route trust the filename extension instead of `detectFontFormat` and confirm the "ignoring the filename" test fails. Restore. Then remove the quota check and confirm its test fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/dashboard/fonts.ts apps/api/src/routes/dashboard/index.ts apps/api/tests/routes/dashboard/fonts.test.ts
git commit -m "feat(api): upload a project font face"
```

---

### Task 4: List and delete endpoints

**Files:**
- Modify: `apps/api/src/routes/dashboard/fonts.ts`
- Test: `apps/api/tests/routes/dashboard/fonts.test.ts`

**Interfaces:**
- Produces: `GET /dashboard/projects/:projectId/fonts`, `DELETE /dashboard/projects/:projectId/fonts/:familyId`.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists families with face metadata and never the bytes", async () => {
  await uploadFont({ bytes: otfBytes(), familyName: "Brand", weight: 400, style: "normal" });
  const body = await (await listFonts()).json();
  expect(body.data[0].name).toBe("Brand");
  expect(body.data[0].faces[0]).not.toHaveProperty("bytes");
});

it("deletes a family even when a paywall references it", async () => {
  const { familyId } = await uploadFont({ bytes: otfBytes(), familyName: "Brand", weight: 400, style: "normal" });
  await createPaywallReferencing(familyId);           // spec §4.1: allowed on purpose
  expect((await deleteFamily(familyId)).status).toBe(200);
  expect((await (await listFonts()).json()).data).toHaveLength(0);
});

it("does not expose another project's fonts", async () => {
  const { familyId } = await uploadFont({ bytes: otfBytes(), familyName: "Brand", weight: 400, style: "normal" });
  expect((await deleteFamily(familyId, { asProject: otherProjectId })).status).toBe(404);
});
```

The second test encodes spec §4.1 deliberately. If a future reader adds a "cannot delete a font in use" guard, that test tells them it was a decision, not an oversight.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/api && npx vitest run tests/routes/dashboard/fonts.test.ts`

- [ ] **Step 3: Implement both routes**

Delete soft-deletes and writes an `audit()` entry. Both routes go through `assertProjectAccess`, which is what makes the third test pass.

- [ ] **Step 4: Run the tests** — expected: all PASS.

- [ ] **Step 5: Mutation-check**

Remove `assertProjectAccess` from the delete route and confirm the cross-project test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/fonts.ts apps/api/tests/routes/dashboard/fonts.test.ts
git commit -m "feat(api): list and delete project fonts"
```

---

### Task 5: The public file route

**Files:**
- Create: `apps/api/src/routes/v1/fonts.ts`
- Modify: `apps/api/src/routes/v1/index.ts`
- Test: `apps/api/tests/routes/v1/fonts.test.ts`

**Interfaces:**
- Consumes: `drizzle.fontRepo.findFaceBytes` (Task 1); `FONT_CONTENT_TYPES`, `FONT_FILE_CACHE_MAX_AGE_SECONDS` (Task 2).
- Produces: `GET /v1/fonts/:faceId/file`.

Authenticated with the project's **public API key** via the existing `apiKeyAuth` middleware in `apps/api/src/middleware/api-key-auth.ts`, like every other SDK read.

- [ ] **Step 1: Write the failing tests**

```ts
it("serves the bytes with the format's content type", async () => {
  const res = await getFaceFile(faceId);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("font/otf");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(uploadedBytes);
});

it("caches immutably, because a face's bytes never change", async () => {
  const res = await getFaceFile(faceId);
  const cc = res.headers.get("cache-control") ?? "";
  expect(cc).toContain("immutable");
  expect(cc).toContain(`max-age=${FONT_FILE_CACHE_MAX_AGE_SECONDS}`);
  expect(res.headers.get("etag")).toBeTruthy();
});

it("404s a face whose family was deleted", async () => {
  await deleteFamily(familyId);
  expect((await getFaceFile(faceId)).status).toBe(404);
});

it("refuses a key from another project", async () => {
  expect((await getFaceFile(faceId, { key: otherProjectPublicKey })).status).toBe(404);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/api && npx vitest run tests/routes/v1/fonts.test.ts`

- [ ] **Step 3: Implement**

Return `404` rather than `403` for another project's face — a binary endpoint should not confirm that an id exists to a caller who cannot have it.

- [ ] **Step 4: Run the tests** — expected: all PASS.

- [ ] **Step 5: Mutation-check**

Drop `immutable` from the cache header and confirm the caching test fails. Restore. Then make the route ignore the deleted-family filter and confirm the 404 test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/fonts.ts apps/api/src/routes/v1/index.ts apps/api/tests/routes/v1/fonts.test.ts
git commit -m "feat(api): serve a font face to devices"
```

---

### Task 6: The dashboard Fonts screen

**Files:**
- Create: `apps/dashboard/src/pages/settings/fonts.tsx`
- Create: `apps/dashboard/src/lib/hooks/useFonts.ts`
- Modify: the settings route registration and `apps/dashboard/src/i18n/locales/en.json`
- Test: `apps/dashboard/src/pages/settings/__tests__/fonts.test.tsx`

**Interfaces:**
- Consumes: the three dashboard endpoints from Tasks 3–4.

Fonts live under **project settings**, not inside the paywall builder — they are a project asset shared across paywalls, and wave E2 adds the picker that consumes them.

**`en.json` collision warning:** a parallel agent is also adding keys to this file. **Add your keys only; do not reorder, reformat or re-sort anything.**

- [ ] **Step 1: Write the failing tests**

```tsx
it("lists a family with its faces", async () => {
  renderFontsPage({ families: [{ id: "f1", name: "Brand Sans", faces: [{ id: "a", weight: 400, style: "normal", format: "otf", byteSize: 1024 }] }] });
  expect(await screen.findByText("Brand Sans")).toBeInTheDocument();
  expect(screen.getByText(/400/)).toBeInTheDocument();
});

it("shows the face count against the cap", async () => {
  renderFontsPage({ families: [] });
  expect(await screen.findByText(new RegExp(`0\\s*/\\s*${FONT_FACES_MAX_PER_PROJECT}`))).toBeInTheDocument();
});

it("warns that deleting a font in use falls back to the system font", async () => {
  renderFontsPage({ families: [{ id: "f1", name: "Brand Sans", faces: [] }] });
  await userEvent.click(await screen.findByRole("button", { name: /delete/i }));
  expect(screen.getByText(/system font/i)).toBeInTheDocument();
});
```

The third test pins spec §4.1 in the UI: the consequence is stated in the confirmation, not discovered afterwards.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/dashboard && npx vitest run src/pages/settings/__tests__/fonts.test.tsx`

- [ ] **Step 3: Implement the hook and the screen**

The cap shown comes from the imported `FONT_FACES_MAX_PER_PROJECT`, not a hard-coded number.

- [ ] **Step 4: Run the tests** — expected: all PASS. The full dashboard suite has ~10 pre-existing unrelated failures; confirm you did not add to them.

- [ ] **Step 5: Mutation-check**

Remove the system-font sentence from the delete confirmation and confirm the third test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/pages/settings apps/dashboard/src/lib/hooks/useFonts.ts apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): manage project fonts"
```

---

## Self-Review

**Spec coverage:** §2 model → Task 1. §3 upload and security posture → Tasks 2 and 3 (magic bytes pure and tested in 2, enforced in 3). §4 serving → Task 5. §4.1 deletion consequence → Task 4's second test and Task 6's third. §5 dashboard surface → Task 6. §6 constants → Task 2, imported everywhere else. §7 testing → each task's tests plus the mutation-check steps.

**Type consistency:** `FontFormat`, `detectFontFormat`, `FONT_FACE_MAX_BYTES`, `FONT_FACES_MAX_PER_PROJECT`, `FONT_FILE_CACHE_MAX_AGE_SECONDS`, `FONT_CONTENT_TYPES`, and the six repository functions — each defined once and used with the same name throughout.

**Gaps found and closed during review:** (1) Task 1 originally had no test that `listFamiliesWithFaces` avoids the blob; a shape-only assertion would have passed while the bytes were read and discarded, so the test now asserts the property's absence and the denormalised `byteSize`. (2) The migration-numbering warning was added after checking that a parallel agent had just landed `0096` — two agents generating migrations concurrently will otherwise both pick the same number. (3) Task 3's "ignoring the filename" test was added because every other upload test would pass while the route trusted the extension, which is precisely the check the security posture rests on.
