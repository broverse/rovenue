# Paywall asset CDN: uploading and serving images, video and Lottie

**Date:** 2026-07-29
**Status:** Approved, ready for planning
**Parent:** paywall builder gap analysis (`2026-07-23-paywall-builder-gap-analysis.md`)
**Sibling precedent:** paywall fonts wave E1 (`2026-07-28-paywall-fonts-wave-e1-design.md`) — shipped

---

## 1. What this is

`image`, `video` and `lottie` nodes already exist in the paywall schema, and all three already render
on all three platforms (wave D1/D2 — `packages/paywall-renderer/src/nodes.tsx`,
`RovenuePaywallMediaSource.swift`, `RovenuePaywallLottie.swift`, including the visibility detector and
the fallback rules for media that fails to load). What they take today is an **external URL**: the
customer has to host the asset themselves.

This wave closes that. A project uploads its assets to us; we normalise, store and serve them.

**It changes no paywall schema, no validator rule, no renderer, and no entry in
`render-fixtures.json`.** That is a deliberate design goal, not a happy accident — see §2.3.

### 1.1 What this wave is not

- Not a replacement for external URLs. A node may still point at any URL the author wants; uploading
  is an option, not a requirement.
- Not video transcoding. See §5.6.
- Not poster-frame generation. See §5.7.

---

## 2. The decisions, and what each one removed

Six decisions were taken during design. Each is recorded with what it *removed*, because the removals
are what keep this wave small.

### 2.1 Scope: images + Lottie + video

Video's 2–50 MB profile puts this beyond what Postgres `bytea` serves comfortably, so unlike fonts
wave E1 this wave **does** introduce object storage. That was E1's one open question ("this repo has
no asset-storage machinery at all"), and this wave answers it.

The cost is lower than it first appears: because all three node types already render, the wave adds
storage and serving only. No renderer work, no new node type, no three-platform implementation.

### 2.2 Bytes go up through the API, and down from the bucket

Upload is `dashboard → API → bucket`. Serving is `device → bucket/CDN`, with the API not in the path
at all.

**Why not serve through the API** (the fonts E1 shape, `GET /v1/fonts/:faceId/:hash/file`): a 50 MB
video would cross the Node process for every device that renders the paywall, and the deployment
scales the API with `API_REPLICAS`, so that bandwidth cost multiplies. Range requests — a user
scrubbing a video — are native to a bucket and awkward to reimplement.

**Why not presigned direct-to-bucket upload**, which is the more common industry shape for large
files: it moves validation *after* the bytes land. Keeping upload on the API path is what lets
magic-byte checking, normalisation, quota and audit stay synchronous and in one place. At a 50 MB
cap that trade is worth it. This is a considered deviation from the common pattern, recorded in §13.

### 2.3 The tree holds a plain URL, plus a derived usage index

An uploaded asset produces an ordinary URL string, and `image.url.light` holds it exactly as it would
hold any external URL.

The alternative — nodes holding an `assetId` resolved server-side — was rejected for two reasons. The
smaller one is blast radius: schema → validator → builder → three decoders → `render-fixtures.json`.
The decisive one is `GET /dashboard/projects/:projectId/paywalls/fallback-export`
(`apps/api/src/routes/dashboard/paywalls.ts:462`), which serialises the resolved tree into a JSON file
bundled **on-device**. There is no server present when that file is read, so an `assetId` in it could
never be resolved. The URL has to already be in the file.

The one thing the reference approach would have bought — "warn before deleting an asset something
still uses" — is recovered by a derived index instead (§7).

### 2.4 Uploaded images are normalised server-side

An author uploading a 4 MB PNG should not ship 4 MB to every device. Images are converted to a
single canonical WebP (§5.5).

Multiple widths / `srcset` are **not** possible under §2.3 — a single plain URL string cannot carry a
set of candidates — so this is one derivative, not a responsive set.

### 2.5 Originals are discarded

Only the served derivative is stored. This is a deviation from common asset-pipeline practice
(Cloudinary, imgix and similar keep originals); it is recorded as such in §13.

Its cost is that the normalisation policy becomes **permanent per asset** — there is nothing to
re-derive from if the policy changes. The mitigation is metadata: every asset records
`sourceFormat`, `sourceWidth`, `sourceHeight` and `policyVersion`. That cannot bring the bytes back,
but it makes "which assets were captured under the old policy, and whose authors should we ask to
re-upload" an answerable question rather than an unanswerable one.

### 2.6 Per-file caps are flat; total storage is plan-tiered

Per-file caps are a technical safety bound and must be flat, because Hono's `bodyLimit` fixes
`maxSize` at route-registration time and cannot vary it per request (§5.1). Total storage per project
is the real cost axis and reads from the existing plan tier (`packages/shared/src/billing.ts`,
`apps/api/src/middleware/usage-lock.ts`), unlimited under `HOST_MODE=self`.

### 2.7 One `AssetStore` interface, one S3 implementation

MinIO (self-host), R2 and S3 (cloud) all speak the S3 protocol, so a driver registry would be a
registry with one real driver in it — the other plausible drivers are already disqualified
(`postgres` cannot hold video; a mounted filesystem breaks under `API_REPLICAS`, which is exactly why
fonts E1 rejected it).

`publicUrl` lives **inside** that interface, next to its inverse `parseAssetUrl`. This is the lesson
from `buildFontFaceFileUrl` (`apps/api/src/routes/v1/fonts.ts:36`): exactly one place knows the URL
shape, and a producer and parser that live apart drift apart silently.

---

## 3. Architecture

| Component | Location | Responsibility |
|---|---|---|
| `AssetStore` | `apps/api/src/lib/asset-store.ts` | `put` / `delete` / `publicUrl` / `parseAssetUrl`. The only place that knows S3 or the URL shape. |
| `normalizeImage` | `apps/api/src/services/assets/normalize.ts` | `sharp` wrapper. Pure: touches neither the database nor storage. |
| `detectAssetKind` | `packages/shared/src/assets/detect.ts` | Magic-byte shape check, mirroring `detectFontFormat`. |
| `assetRepo` | `packages/db/src/drizzle/repositories/assets.ts` | Asset rows, usage index, atomic quota accounting. |
| Dashboard routes | `apps/api/src/routes/dashboard/assets.ts` | Upload / list / delete. Never sees S3. |
| Orphan sweeper | `apps/api/src/workers/asset-orphan-sweeper.ts` | Reclaims bucket objects with no live row (§5.8). |

There is **no `/v1` byte-serving route**. Unlike `v1/fonts.ts`, the API does not stand in the serving
path.

### 3.1 Upload transport: raw body, not multipart

Fonts E1 used multipart because it carried four metadata fields. Repeating that here would be
expensive: `parseBody()` **fully buffers** the request body, so at a 50 MB video cap five concurrent
uploads is 250 MB resident — in a process that `API_REPLICAS` multiplies.

Instead the bytes are the raw request body, with the two metadata fields in the query string:

```
POST /dashboard/projects/:projectId/assets/video?name=intro.mp4
Content-Type: application/octet-stream
<raw bytes>
```

`parseBody()` is never called. Video streams from `c.req.raw.body` through `@aws-sdk/lib-storage`'s
multipart `Upload` and is never fully resident. Images are still buffered, but `sharp` needs the whole
buffer anyway and their cap is 10 MB.

### 3.2 `bodyLimit` is bound three times

`maxSize` is fixed at route definition. Binding one route would force the loosest cap (50 MB), letting
an image upload accept a 50 MB body. So the **kind is a path segment** and three route registrations
share one handler factory, each with its own limit:

| Route | `bodyLimit` |
|---|---|
| `POST …/assets/image` | `ASSET_IMAGE_MAX_BYTES` (10 MB) |
| `POST …/assets/lottie` | `ASSET_LOTTIE_MAX_BYTES` (2 MB) |
| `POST …/assets/video` | `ASSET_VIDEO_MAX_BYTES` (50 MB) |

Fonts' two-gate structure is preserved — the outer gate rejects while the body is still streaming, the
inner gate returns the typed error — but each gate now sits at its own kind's real cap.

---

## 4. Data model

Migration `0099_paywall_assets.sql`.

```
paywall_assets
  id             text pk (cuid2)
  projectId      text not null → projects.id  on delete cascade
  kind           text not null        -- "image" | "video" | "lottie"
  name           text not null        -- author-facing; validated per §5.4
  storageKey     text not null        -- "{projectId}/{assetId}.{ext}"
  contentHash    text not null        -- sha256 of SERVED bytes, lowercase hex
  contentType    text not null        -- "image/webp" | "video/mp4" | "application/json"
  byteSize       integer not null     -- served bytes; what quota counts
  width          integer              -- images only
  height         integer              -- images only
  sourceFormat   text                 -- images only: "png"|"jpeg"|"webp"|"gif"
  sourceWidth    integer              -- §2.5 mitigation
  sourceHeight   integer
  policyVersion  integer not null     -- normalisation policy applied
  createdAt / updatedAt / deletedAt

  unique index paywall_assets_project_hash_key
    on (projectId, contentHash) where deletedAt is null
```

### 4.1 Assets are immutable

An asset is created and deleted. It is never overwritten. This deliberately rejects fonts'
`upsertFace` shape.

The reason follows directly from §2.3: the URL is embedded in the tree as a plain string and frozen
into the fallback-export file. Changing the bytes under a URL that a bundled file already promises
would make that file lie. An author changing a picture uploads a new asset and repoints the node.

**This is also why `storageKey` needs no content hash.** Fonts put the hash in the URL precisely
*because* faces are replaced in place; here immutability comes from the row, so `{projectId}/{assetId}.{ext}`
already guarantees a key never serves two different byte sequences. The hash is still stored — it
drives dedup and the ETag — but it is not part of the path.

### 4.2 Upload is idempotent

The partial unique index on `(projectId, contentHash)` makes a repeat upload of identical bytes return
the existing row rather than creating a second one, so quota is not charged twice.

Because the hash is only known once the bytes have been read, the sequence is: stream up under the new
`assetId`'s key while hashing inline, then in the transaction, if a live row already holds that hash,
delete the object just written and return the existing row. Wasteful in the duplicate case, correct in
every case, and identical across all three kinds.

**Documented consequence:** a second upload supplying a different `name` gets the first row's name back.

---

## 5. Upload pipeline and security posture

### 5.1 Gate order

1. `bodyLimit` — per-kind, rejects while the body is still streaming
2. `rateLimit` — §5.9
3. `requireDashboardAuth` + `assertProjectAccess` + `assets:write`
4. **Quota pre-check** — is the project already at its cap?
5. **Magic-byte kind validation** — §5.3
6. Images only: `normalizeImage` — §5.5
7. **Quota reservation** — atomic, against the true served size (§8.2)
8. `AssetStore.put`, then the row + `audit()` — in that order, not one transaction (§5.8)

Cheapest-first, as fonts established, with one change: the quota pre-check precedes magic-byte
validation, because step 6 runs `sharp` and spending CPU on a project that cannot store the result is
pointless. Quota is checked twice on purpose — normalisation *shrinks* the input, so a pre-check alone
would reject uploads that would in fact have fit. The binding decision is made on served bytes.

### 5.2 `assets:write`

New capability in `apps/api/src/lib/capabilities.ts`, with the same roles as `fonts:write`
(`OWNER`, `ADMIN`, `DEVELOPER`) — a project asset like products or webhooks, not marketing tooling.

### 5.3 The kind comes from the path and the bytes must agree

The filename is **never** consulted — fonts' rule. `kind` arrives as a path segment, and the magic
bytes must agree with it; `…/assets/image` carrying MP4 bytes is a typed rejection.

| Kind | Accepted | Check |
|---|---|---|
| image | PNG, JPEG, WebP, GIF | magic bytes |
| video | MP4 | `ftyp` box at offset 4 |
| lottie | Lottie JSON | parses as JSON, carries `v` and `layers` |

**SVG is not accepted.** See §5.4.

Per OWASP, signature validation is a supporting check and not a standalone defence; here it is backed
by the loader allowlist (§5.4) and by the fact that images are re-encoded rather than stored as
received, which discards any non-pixel payload the original carried.

### 5.4 Hardening `sharp`

This is the sharpest edge in the wave, and the first design pass got it wrong. An earlier draft
proposed accepting SVG and rejecting dangerous ones with a text prescan for `<!DOCTYPE`, `<!ENTITY`
and external `href`. That is not the right control: libvips ships a purpose-built mechanism, and its
own guidance is to use it.

**Loader allowlist.** libvips 8.13+ can block operations by class. Only the four loaders this wave
needs stay enabled — JPEG, PNG, WebP, GIF — and everything else (SVG, TIFF, PDF, the `vips` loader)
is blocked at init. `VIPS_BLOCK_UNTRUSTED` is set as a belt-and-braces default; the explicit allowlist
is the primary control because it is narrower than "untrusted" and does not drift as upstream
re-tags loaders. The exact `sharp.block(...)` invocation is for the implementation plan to pin
against the installed version.

Dropping SVG loses something real — rasterising SVG would have covered a genuine gap, since neither
SwiftUI nor Android Views render SVG natively. That is a fair price. Authors flatten to PNG first.

**Version floor: `sharp >= 0.35.3`** (libvips 8.18.3). CVE-2026-33327, CVE-2026-33328, CVE-2026-35590
and CVE-2026-35591 — two rated High under CVSSv4 — affect anyone processing untrusted input on
sharp < 0.35.0, and land in the **GIF, TIFF and VIPS loaders**. GIF is on our accept list. This is a
standing obligation, not a one-time install step; the plan adds it to the dependency-update watch.

**`limitInputPixels` and `failOn` are both set explicitly.** The defaults (268402689 and `'warning'`)
are already the values we want — sharp's own documentation says to use `failOn: 'warning'` with
untrusted input — but writing them down is what stops a future upstream default change from silently
removing the decompression-bomb bound. `limitInputChannels` keeps its default of 5.

**Name validation.** The storage key is application-generated, so the object name is safe by
construction. But `name` is author-supplied, persisted, and rendered in the dashboard — a stored-XSS
sink. Per OWASP: a maximum length, plus a character allowlist (alphanumeric, hyphen, space, period),
with leading periods and sequential periods rejected.

### 5.5 Normalisation policy v1

`policyVersion = 1`:

- output WebP
- longest edge fitted to `ASSET_IMAGE_MAX_EDGE_PX` (2048); never upscaled
- all metadata stripped — which also strips EXIF GPS, so a photo taken on the author's phone does not
  ship its location alongside the paywall
- animated GIF/APNG preserved as animated WebP

WebP is decodable across our targets — iOS 14+ (the SDK's floor is iOS 15), Android 4.4+ for the
alpha and animated cases this policy can emit, and every current browser — so the single format costs
nothing in reach.

### 5.6 Video is stored verbatim

No `ffmpeg` in this image. The `ftyp` brand is validated and the bytes are stored as received. A codec
iOS cannot play is the author's problem — and D2's "video that fails to load" fallback rules already
cover how that renders.

### 5.7 Poster frames are an explicit non-goal

`posterUrl` exists on the video node as an overridable prop, but extracting a first frame means
`ffmpeg`. Authors upload a poster as a separate image asset; the builder says so in help text.

### 5.8 Storage writes are never inside a database transaction

An S3 `put` cannot be rolled back. Putting it inside the row's transaction means a transaction that
fails afterwards leaves an orphaned object — occupying storage that quota, which counts rows, cannot
see.

This is the same principle the codebase already enforces for Kafka ("never write a domain table and
Kafka in the same code path"). So:

- **Create:** put the object first — idempotent, since the key is `{projectId}/{assetId}` and the id is
  freshly minted — then commit the row.
- **Delete:** soft-delete the row first, then delete the object.

The ordering is chosen so the recoverable failure is the one that happens. A failed object-delete
leaves an orphan the sweeper reclaims; the reverse order would leave a live row pointing at nothing,
which is a 404 for every published paywall using it.

`asset-orphan-sweeper` reclaims objects older than `ASSET_ORPHAN_GRACE_HOURS` with no live row. The
grace window matters: without it the sweeper races in-flight uploads whose row has not committed yet.

### 5.9 Rate limiting

`apps/api/src/middleware/rate-limit.ts` exists but is **not currently bound to dashboard routes**.
Upload is the most expensive request in the product — `sharp` CPU, ingress bandwidth, durable storage
— so these routes bind it. Scoped per project.

---

## 6. Serving

Devices fetch from the bucket/CDN directly. The API is not involved.

- **Object ACL: public read. Bucket listing: disabled.** The security of an unguessable key evaporates
  if an attacker can enumerate instead of guess.
- **No signed or expiring URLs.** A URL frozen into a bundled fallback-export file has to still resolve
  months later; an expiry would break it silently. Security rests on the unguessable cuid2 in the key.
- **`Cache-Control: public, max-age=31536000, immutable`**, which is honest here because §4.1 makes a
  key's bytes permanent. This one *is* settable on `PutObject`.
- **Explicit `Content-Type` on every object.** Also settable on `PutObject`.
- **`X-Content-Type-Options: nosniff` and an `ETag` carrying `contentHash` are edge-layer concerns,
  not storage-layer ones.** An earlier draft of this section listed them here as if `PutObject`
  could set them. It cannot: the S3 API has no field for arbitrary response headers, and `ETag` is
  computed by the store itself (a content MD5, or a composite for multipart uploads) and is not
  caller-settable. Writing them as object *metadata* surfaces them as `x-amz-meta-*`, which no
  browser treats as the real header — so doing that and calling it done would be worse than not
  doing it.

  They are still required; they just belong one layer out, where response headers are actually
  ours to set: a Cloudflare Transform Rule on the custom domain in cloud, and a header directive
  in the Caddy config for self-hosted. **Both now exist** —
  `deploy/cloudflare/asset-headers/README.md` and `deploy/caddy/conf.d/assets.caddy.example`.

  Two corrections to what this section assumed, both established by measuring a running MinIO
  rather than reasoning about the S3 API:

  - **MinIO already sets `X-Content-Type-Options: nosniff` itself** on object responses. So on a
    stock self-hosted install `nosniff` was in force the whole time, contrary to the claim above.
    The Caddy block sets it anyway: it stops being redundant the moment the origin is anything
    else (R2, plain S3, a cache in between), and an edge that only works against one origin is
    not much of a control.
  - **`ETag` was never missing.** MinIO returns a strong `ETag`, and a conditional request against
    it answers `304`. R2 and S3 behave the same way. The store's `ETag` *is* a content hash — a
    different algorithm than the `contentHash` column, serving the identical purpose, and unlike a
    rewritten one it stays correct for multipart uploads, where the value is a composite rather
    than a plain digest. Since §4.1 makes a key's bytes permanent, any correct validator is as
    good as any other, so `ETag: contentHash` specifically buys nothing and is dropped as a
    requirement.

  What the edge layer genuinely adds for self-hosted, beyond re-asserting `nosniff`: it refuses
  every non-`GET`/`HEAD`/`OPTIONS` method at the door, so a future mistake in the bucket policy is
  not immediately reachable from the internet.
- **The asset domain must sit outside the session cookie's scope.** OWASP's highest-priority storage
  rule is "different host", which serving from the CDN satisfies — but a Better Auth cookie written to
  `.rovenue.app` would also be sent to `cdn.rovenue.app`. Deployment must keep the cookie domain
  narrower, and the plan verifies this rather than assuming it.

Self-hosted installs without a CDN serve straight from MinIO. Everything above still holds; only edge
caching is absent.

---

## 7. The usage index

```
paywall_asset_usages
  assetId     text not null → paywall_assets.id     on delete cascade
  paywallId   text not null → paywalls.id           on delete cascade
  versionId   text not null → paywall_versions.id   on delete cascade
  primary key (assetId, versionId)
```

Written inside `setPublishedVersion` (`packages/db/src/drizzle/repositories/paywalls.ts:166`), in the
same transaction: the published version's tree is walked, asset URLs are resolved back to ids via
`AssetStore.parseAssetUrl`, and that `versionId`'s rows are replaced.

**Its honest boundary: published versions only.** An asset referenced solely by a draft does not
appear, and the delete warning will not count it. That is the correct scope — breaking a draft is
recoverable, breaking a live paywall is not — but the warning copy must say **"3 published paywalls"**
rather than "3 paywalls", or an author will read a zero as covering drafts too.

### 7.1 Deletion

Deletion frees bytes; that is what makes quota mean anything. The dashboard warns with the usage
count, and on confirmation the object is permanently deleted and the row is tombstoned (`deletedAt`),
keeping the audit trail and the usage rows for forensics. A published paywall still referencing it
gets a 404, and D1's fallback rules for media that fails to load take over.

---

## 8. Quota

### 8.1 Limits

Flat per-file caps (§3.2). Total storage per project comes from the plan tier and is unlimited under
`HOST_MODE=self`.

The limit lives in the existing `billing_tier_limits` table as a new nullable
`asset_storage_bytes_limit` column, following that table's established convention where `NULL` means
unlimited (as `events_limit` and `sql_limit` already do). It is **`bigint`, not `integer`** — 50 GB is
53,687,091,200, well past `integer`'s ceiling. Proposed ladder:

| Tier | Total asset storage |
|---|---|
| free | 250 MB |
| indie | 5 GB |
| studio | 50 GB |
| enterprise | unlimited |
| `HOST_MODE=self` | unlimited |

These are starting figures, sized so a single paywall's worth of assets (a handful of images and one
video, well under 100 MB) fits comfortably in the free tier while a project cannot host a video
library on it. They are cheap to revise later — the cap is read at request time, so changing a row
changes behaviour with no backfill.

### 8.2 Accounting is atomic

A naive read-then-write quota check is a TOCTOU race: two concurrent uploads both read a figure under
the cap and both proceed. Reservation is therefore a **conditional `UPDATE`** against a per-project
usage counter — check and reserve in one statement — and the upload proceeds only if it applied. The
counter is decremented on delete.

This is a deliberate departure from the read-then-write TOCTOU that fonts E1 documented and accepted
for family lookup. There the loser was one bad row; here it is unbounded overshoot of a paid limit.

---

## 9. Dashboard

**Asset library**, a project-scoped page: grid of assets with kind, dimensions, size and created date;
upload; delete with the §7 usage warning.

**Picker in the paywall builder inspector**, opened from the `url` field of an `image`, `video` or
`lottie` node. Selecting an asset writes its URL into the field as a plain string — the field keeps
accepting a hand-typed external URL, because §2.3 makes the two indistinguishable to everything
downstream. Light/dark variants are two independent picks, matching the existing `{light, dark}` shape.

Upload needs real progress reporting: a 50 MB video on a slow uplink is a minutes-long operation, and
a spinner with no progress reads as a hang.

> **Working-tree collision warning.** At the time of writing, another session has uncommitted changes
> across `apps/dashboard/src/components/paywall-builder/inspector/` (`fields.tsx`, `primitives.tsx`,
> `content-tab.tsx`, `style-tab.tsx` and their tests). The picker lands in exactly that directory. The
> implementation plan must re-check `git status` before starting and sequence around it.

---

## 10. Configuration

| Variable | Purpose |
|---|---|
| `ASSET_STORAGE_ENDPOINT` | S3 endpoint (MinIO / R2 / S3) |
| `ASSET_STORAGE_REGION` | |
| `ASSET_STORAGE_BUCKET` | |
| `ASSET_STORAGE_ACCESS_KEY_ID` | |
| `ASSET_STORAGE_SECRET_ACCESS_KEY` | |
| `ASSET_PUBLIC_BASE_URL` | Public origin the bucket is served from; the base for `publicUrl` |
| `VIPS_BLOCK_UNTRUSTED` | Set in the API image (§5.4) |

Added to `.env.example`; MinIO added to `docker-compose.yml` for self-hosted installs.

Uploads are disabled with a typed error when storage is unconfigured, so a local dev environment
without MinIO degrades the way a blank ClickHouse already does rather than erroring obscurely.

**Build risk to verify, not assume:** the API image is `node:22-alpine` (musl). sharp 0.33+ ships
prebuilt musl binaries and the `deps` stage installs inside the same image, so the usual
cross-platform `node_modules` hazard does not apply — but the plan must confirm the optional platform
binary is actually present in the built production image rather than trusting that reasoning.

---

## 11. Error codes

Added to `ERROR_CODE` in `packages/shared/src/index.ts`, following the fonts E1 block:

| Code | Meaning |
|---|---|
| `ASSET_FORMAT_UNSUPPORTED` | Magic bytes unrecognised, or disagreeing with the path's kind |
| `ASSET_FILE_TOO_LARGE` | Per-kind cap; also returned by `bodyLimit`'s `onError`, so a caller sees one code either way |
| `ASSET_QUOTA_EXCEEDED` | Project storage cap |
| `ASSET_STORAGE_UNAVAILABLE` | Storage unconfigured or unreachable |
| `ASSET_INVALID_NAME` | §5.4 name validation |
| `ASSET_PROCESSING_FAILED` | `sharp` rejected the input (bomb, corrupt, blocked loader) |

---

## 12. Testing

**Unit**

- `normalizeImage`: PNG→WebP; oversized capped to the long edge; no upscaling; animated GIF→animated
  WebP; EXIF (including GPS) stripped; decompression bomb rejected; a blocked loader (SVG, TIFF)
  rejected.
- `detectAssetKind`: each accepted signature; kind/bytes disagreement; truncated headers.
- `AssetStore`: `publicUrl` → `parseAssetUrl` round-trip. Given the `buildFontFaceFileUrl` experience,
  this gets a **mutation check** — substituting a constant id must turn the round-trip tests red.
- Name validation: length, charset, leading and sequential periods.

**Integration** (testcontainers: real Postgres + real MinIO)

- Upload → object present, row present, `publicUrl` fetches the bytes back.
- Duplicate upload → one row, one object, quota charged once.
- Concurrent uploads against a near-full quota → the cap is not exceeded. This must run against real
  Postgres with real concurrency; a mocked transaction cannot substantiate an atomicity claim.
- Delete → object gone, row tombstoned, counter decremented.
- Orphan sweeper → an object with no row, older than the grace window, is reclaimed; one inside the
  window is left alone.
- Publish → usage index rows written; republish with an asset removed → stale rows cleared.

**Explicitly not accepted as evidence:** a failure path tested by hand-constructing the error it is
supposed to catch, or a rollback/atomicity claim demonstrated over a mocked transaction.

---

## 13. Deliberate deviations from best practice

Recorded so they read as decisions rather than oversights.

| Deviation | Common practice | Why, and what bounds it |
|---|---|---|
| Upload streams through the API | Presigned direct-to-bucket | Keeps validation, normalisation, quota and audit synchronous and in one place. Bounded by the 50 MB cap and by streaming rather than buffering (§3.1). |
| Originals discarded | Keep originals | §2.5. Mitigated by source metadata + `policyVersion`. |
| Single WebP, no content negotiation | `Accept`-negotiated AVIF/WebP/JPEG | Forced by the plain-URL decision (§2.3). WebP's reach makes the practical cost near zero. |
| No antivirus / CDR scanning | OWASP recommends both | Three accepted types, none executed server-side, all re-encoded or structurally validated; ClamAV would add a service to every self-hosted install. Revisit if the accepted set widens. |

---

## 14. Follow-ups, explicitly out of scope

- ~~**`X-Content-Type-Options: nosniff` and `ETag: contentHash` at the edge** (§6)~~ — **done.**
  Cloudflare Transform Rule in `deploy/cloudflare/asset-headers/README.md`; Caddy drop-in in
  `deploy/caddy/conf.d/assets.caddy.example`. The `ETag: contentHash` half was withdrawn rather
  than built: the store already returns a strong `ETag` that revalidates correctly (§6).
- Responsive variants — needs the tree to carry a candidate set, i.e. a schema change and a
  three-platform decoder change.
- Video transcoding and poster-frame extraction — needs `ffmpeg`.
- A CDN purge hook — unnecessary while §4.1 holds, since no URL's bytes ever change.
- Usage-index coverage for drafts (§7).

---

## 15. Global constraints for implementation

- **No magic values.** Every size cap, dimension ceiling, grace window, rate-limit figure and policy
  version is a named constant in `packages/shared/src/assets/`. This applies to each subagent brief,
  not just the plan.
- TypeScript strict; Zod for input; `{ data }` / `{ error: { code, message } }` envelopes.
- Postgres via Drizzle repositories only. In `sql` templates, qualify columns.
- Conventional commits. Stay on the current branch — do not create branches or worktrees.
- `audit()` runs inside the caller's transaction.
