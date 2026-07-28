# Paywall fonts, wave E1: the font asset pipeline

**Date:** 2026-07-28
**Status:** Approved, ready for planning
**Parent:** P10 in `2026-07-23-paywall-builder-gap-analysis.md` (§6.20)
**Depends on:** P5 (inspector tabs + visibility) — shipped
**Sibling:** wave E2 (applying fonts: schema, validator, builder picker, three renderers) — planned separately

---

## 1. What this is, and what the design decisions removed

P10 as written in the gap analysis is: upload font files, tag them with per-platform coverage, warn
when a platform is not covered (`FONT_NOT_EMBEDDED_FOR_PLATFORM`), and register them natively.

Two decisions taken during design removed most of that complexity:

**Fonts are downloaded and registered at runtime**, not bundled into the customer's app binary. All
three platforms support this — `FontFace` on web, `CTFontManagerRegisterFontsForURL` on iOS,
`Typeface.createFromFile` on Android. An uploaded font therefore works **everywhere**, which deletes
the `embedded` coverage flag, the per-platform file split, and `FONT_NOT_EMBEDDED_FOR_PLATFORM`
entirely. The cost is a flash of system font before the file arrives, and no custom font on a
first-ever offline launch — both acceptable, and both strictly better than a paywall that renders
the wrong typeface with no warning.

**Files live in Postgres**, as `bytea`. This repo has **no asset-storage machinery at all** — no S3,
no MinIO, no presigned URLs, no `multipart` handling anywhere in the API. Adding object storage
would mean a new service, new credentials, a lifecycle policy, and one more component for
self-hosted installs. Fonts are small (~100–400 KB) and few (a handful per project), which is well
inside what Postgres serves comfortably. A mounted volume was rejected outright: the deployment
scales the API with `API_REPLICAS`, so a font uploaded to one replica would be invisible to the
others.

E1 is **getting fonts into the system**. E2 is **using them**. This wave changes no paywall schema
and touches no renderer.

---

## 2. The data model

A **family** is what an author picks ("Brand Sans"). A **face** is one file: one weight, one style.

```
font_families
  id           text pk (cuid2)
  projectId    text not null → projects.id  on delete cascade
  name         text not null              -- "Brand Sans", author-facing
  createdAt / updatedAt / deletedAt

font_faces
  id           text pk (cuid2)
  familyId     text not null → font_families.id  on delete cascade
  weight       integer not null           -- 100..900, CSS numeric scale
  style        text not null              -- "normal" | "italic"
  format       text not null              -- "otf" | "ttf" | "woff2"
  bytes        bytea  not null
  byteSize     integer not null           -- denormalised, so listing never reads the blob
  createdAt
```

**A family carries several faces on purpose.** `TextNode` has no weight of its own — it has
`role: "title" | "subtitle" | "body" | "caption"`, and each renderer derives a weight from the role.
A family with only one uploaded face would leave titles synthetically emboldened, which is exactly
the look a brand font is bought to avoid. E2 resolves a missing weight to the **nearest available
face**, never to faux bold.

`byteSize` is stored separately so the list endpoint never has to read a `bytea` column — the common
query stays cheap regardless of how many fonts a project has.

Uniqueness: one face per `(familyId, weight, style)`. Re-uploading that combination replaces it.

---

## 3. Upload, and the security posture

`POST /dashboard/projects/:projectId/fonts` is the **first file upload in this product**, so the
posture is stated rather than assumed.

- **Multipart** via Hono's request body parsing. No new dependency.
- **A hard size cap**, `FONT_FACE_MAX_BYTES`, rejected with a typed error rather than a truncated row.
- **A per-project face-count cap**, `FONT_FACES_MAX_PER_PROJECT`, so an upload endpoint cannot become
  unbounded storage.
- **Format validated by magic bytes**, not by the filename. `.otf` files begin `OTTO`, `.ttf` begins
  `\x00\x01\x00\x00` or `true`, `.woff2` begins `wOF2`. A file whose bytes do not match its claimed
  format is rejected.

**The server never parses the font.** Family name, weight and style are **declared by the uploader**,
not extracted from the file. Font parsers — FreeType, CoreText, and their equivalents — have a long
history of memory-safety vulnerabilities, and running one over an attacker-supplied file on our own
servers to save the customer typing a name is a bad trade. Magic bytes are a shape check, not a
parse.

The bytes are still served to devices, where a platform font engine does parse them. That risk is
the customer's own file on the customer's own users' devices, and it is the same risk any app takes
bundling a font — but it is a reason to keep the upload authenticated and project-scoped rather than
open.

---

## 4. Serving

`GET /v1/fonts/:faceId/file` — the route SDKs and the web renderer fetch.

- **Authenticated with the project's public API key**, like every other SDK read. Fonts are not
  secret, but an unauthenticated binary endpoint is a bandwidth liability.
- **Immutable caching.** A face's bytes never change — re-uploading a weight creates a new row with a
  new id — so the response carries a long `Cache-Control: public, max-age=…, immutable` and a strong
  `ETag`. A device downloads a given face at most once.
- **The correct content type per format**, so platform loaders do not have to sniff.

`GET /dashboard/projects/:projectId/fonts` lists families with their faces — **metadata only, never
bytes**.

`DELETE /dashboard/projects/:projectId/fonts/:familyId` soft-deletes a family.

### 4.1 What deleting a font does to a live paywall

Deletion is **allowed even when a paywall references the family**, and the consequences are defined
rather than prevented:

- a **published** paywall referencing it keeps rendering — the renderers fail open to the system
  font, exactly as they do when a download fails (E2's rule);
- the builder surfaces it at authoring time through E2's `FONT_FAMILY_NOT_FOUND`, at `publish` tier.

Blocking deletion until every reference is cleared was considered and rejected: it makes tidying up
an unused font a scavenger hunt across paywall versions, and the failure it prevents is one the
renderers already handle gracefully.

---

## 5. The dashboard surface

A **Fonts** section under project settings, not inside the paywall builder — fonts are a project
asset shared across paywalls, and E2 adds the picker that consumes them.

- List families with their faces (weight, style, size).
- Upload: pick a file, name the family (or add to an existing one), declare weight and style.
- Delete a family, with the §4.1 consequence stated in the confirmation rather than discovered later.
- Show the project's face count against `FONT_FACES_MAX_PER_PROJECT`.

---

## 6. Constants, declared once

| Constant | Value | Applies to |
|---|---|---|
| `FONT_FACE_MAX_BYTES` | `2 * 1024 * 1024` | one uploaded face |
| `FONT_FACES_MAX_PER_PROJECT` | `24` | the per-project cap |
| `FONT_FILE_CACHE_MAX_AGE_SECONDS` | `31536000` | the served file's `max-age` (one year, immutable) |
| `FONT_ALLOWED_FORMATS` | `["otf", "ttf", "woff2"]` | accepted uploads |

2 MB comfortably holds a full-featured OTF; 24 faces is four families at six weights, well past what
a paywall needs, and it exists to bound storage rather than to ration.

---

## 7. Testing

- **Repository / integration:** these are real Postgres tests (`*.integration.test.ts`, testcontainers)
  because `bytea` round-tripping, the `(familyId, weight, style)` uniqueness, and cascade deletes are
  exactly the things a mocked DB would lie about.
- **Upload validation:** each rejection path gets a test — over the size cap, over the face cap, a
  `.ttf` extension carrying `OTTO` bytes, a format outside the allow-list. **Magic-byte tests use real
  byte prefixes**, not a stubbed helper that returns what the test wants.
- **Serving:** the correct content type per format, the `ETag`, and that the list endpoint's query
  does not read `bytes` — the last one asserted against the actual SQL, since a test that merely
  checks the response shape would pass while the blob was being read and discarded.
- **Authorisation:** a project's fonts are not reachable with another project's key. This is
  table-stakes for a binary endpoint and it gets an explicit test rather than an assumption.

---

## 8. Binding rules carried forward

From waves A–D2, each paid for once:

1. **No magic values.** Every literal is a named constant.
2. **A test that passes with the feature broken is worse than no test.** Mutation-check every claim;
   where no test can catch a defect, say so plainly rather than implying coverage.
3. **Never describe a test you did not write.**
4. **Verify the outcome the user sees, not the layer you changed.** A repository test proving a row
   was written does not prove the upload endpoint accepted the file.
5. **A rule we define is stable; a rule a third-party parser happens to enforce is not.** This wave's
   application: format is decided by our own magic-byte table, not by a library's opinion.
6. **A behaviour not written in the spec gets invented three times** — hence §4.1 being explicit
   about deletion rather than left to whoever implements the button.

---

## 9. Out of scope — all of it wave E2

- `fontFamilyId` on `BuilderConfig` and `TextNode`, and the node → config → system resolution order.
- `FONT_FAMILY_NOT_FOUND` and `FONT_FAMILY_MISSING_WEIGHT`.
- The Style-tab font picker.
- Downloading, registering, caching and applying fonts in the three renderers, and the nearest-weight
  fallback.

Also out of scope entirely: deriving a `woff2` from an uploaded `otf` (a conversion dependency for a
size win we do not need — the served file is cached immutably after one download), font subsetting,
and variable-font axis exposure.
