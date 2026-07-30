# MinIO — self-hosted paywall asset storage

Self-hosted (`HOST_MODE=self`) object storage for the paywall asset CDN
(images, Lottie, video — design spec §6). `docker-compose.yml` starts two
services for this:

- **`minio`** — the S3-compatible object store itself, with a persistent
  volume (`rovenue-minio-data`).
- **`minio-init`** — a one-shot container (`minio/mc`) that creates the
  bucket, grants **anonymous read on objects**, and leaves **bucket
  listing disabled**, then exits 0.

Neither `api` nor `dispatcher` depend on these services starting
successfully. Asset uploads degrade to a typed `ASSET_STORAGE_UNAVAILABLE`
error when storage is unconfigured or unreachable — same contract as a
blank `CLICKHOUSE_URL` — so a stack that never boots MinIO still serves
everything else.

## Why "anonymous read, listing disabled" and not signed URLs

An asset's security rests entirely on the unguessable cuid2 in its key
(`{projectId}/{assetId}.{ext}`), not on the URL being secret or expiring —
the URL is frozen into the bundled fallback-export file devices cache
offline, and a signed URL would break the moment it expired. That security
model only holds if the bucket cannot be enumerated.

**`minio-init` does NOT use `mc anonymous set download`.** That was the
first thing tried, and it's wrong: `mc anonymous get-json` on a bucket set
that way shows the canned `download` policy grants `s3:GetBucketLocation`
and **`s3:ListBucket`** publicly, in addition to `s3:GetObject` — verified
against a live container (`docker compose up minio minio-init` then
`curl http://localhost:9002/rovenue-assets?list-type=2` anonymously
returned `200` with the object's key in the body, not the `403` the design
requires). `mc anonymous set public` is worse, not better, for the same
reason.

Instead `minio-init` writes a **hand-authored bucket policy** via `mc
anonymous set-json`, granting only `s3:GetObject` on
`arn:aws:s3:::<bucket>/*` — no `s3:ListBucket` on the bucket ARN at all.
Re-running the same anonymous list request against that policy returns
`403 AccessDenied`, while `GET` on a known key still returns `200`; both
checked against a live container, not assumed. If you ever touch
`minio-init`'s policy JSON in `docker-compose.yml`, re-run that check —
it is the only thing standing between an unguessable key and an
enumerable bucket.

## Cloud deployments do NOT use this

`HOST_MODE=cloud` deployments use Cloudflare R2 instead, and the two are
configured differently even though `apps/api/src/lib/asset-store.ts` runs
identical code against both (they're both S3-compatible over the AWS SDK).
**R2 does not implement S3 object ACLs at all** — a `putObject` carrying an
ACL is silently ignored, and there is no per-object public flag to set.
Public read on R2 comes from the *bucket*, via a custom domain bound in
the Cloudflare dashboard (R2 -> bucket -> Settings -> Public Access ->
Connect Domain), not from anything `mc anonymous set` has an R2 equivalent
of. Do not use the `r2.dev` development subdomain in production — it's
rate-limited and Cloudflare documents it as non-production traffic.

Use the custom domain for two reasons beyond avoiding the rate limit:

1. It's the only way to put the asset origin **outside the Better Auth
   session cookie's scope** (design spec §6) — see "Cookie scope" below.
2. It's what puts Cloudflare's own cache in front of the assets, for free.

### The two env vars are different R2 hosts — do not conflate them

```
ASSET_STORAGE_ENDPOINT   = https://<accountid>.r2.cloudflarestorage.com   (S3 write API)
ASSET_PUBLIC_BASE_URL    = https://cdn.<domain>                          (public read origin)
```

On MinIO these happen to share a host (`http://minio:9000` inside the
docker network, or `http://localhost:9002` from the host — port 9002 is
this repo's remapped host port, see "Local dev" below), which is
precisely why the MinIO integration tests cannot catch a build that
conflates the two — they pass either way. Verify this by hand on R2 after
setup: an uploaded object must be publicly readable at
`ASSET_PUBLIC_BASE_URL`, the bucket must **not** be listable
(`GET https://cdn.<domain>/` should not return an XML object listing),
and `Cache-Control: public, max-age=31536000, immutable` must survive to
the client (R2's default cache behavior can strip or downgrade
`Cache-Control` on some plans/rules — check the actual response header,
don't assume it's forwarded verbatim).

## Cookie scope

Better Auth writes the session cookie host-only unless
`advanced.crossSubDomainCookies` is configured. `apps/api/src/lib/auth.ts`
does not set it, so as shipped the cookie's `Domain` attribute is unset
(host-only) — it is never sent to a different host, including a
`cdn.*` subdomain, regardless of what that subdomain is. If a future
change turns on cross-subdomain cookies (e.g. `Domain=.rovenue.app` to
share a session across `app.` and something else), the asset CDN host
must stay outside whatever domain is configured there — narrow the
cookie's scope, don't try to move the asset host around it.

## Local dev / first boot

MinIO's default ports (9000 S3 API, 9090 console) are remapped to
9002/9091 on the host — same reasoning as `db`'s 5433 and `redis`'s 6380
in `docker-compose.yml`, to avoid colliding with another local S3-ish
service already on 9000. The container-internal ports (and the
in-network `minio:9000` hostname `api`/`dispatcher` use) are unaffected.

```bash
docker compose up -d minio minio-init
docker compose logs minio-init   # "bucket rovenue-assets ready — anonymous GetObject only, ListBucket denied"
curl -I http://localhost:9002/rovenue-assets/some/key.webp   # 404 for a key that doesn't exist yet, not 403 — bucket is reachable
curl -I "http://localhost:9002/rovenue-assets?list-type=2"   # 403 AccessDenied — listing must stay denied
```

Console (dev convenience only — put it behind auth or off a public
interface before exposing this host): <http://localhost:9091>, credentials
`ASSET_STORAGE_ACCESS_KEY_ID` / `ASSET_STORAGE_SECRET_ACCESS_KEY` from
`.env` (these double as the MinIO root credentials — one pair of env vars,
not two that can drift out of sync).

## Going to production self-host

`http://localhost:9002` only resolves on the docker host itself. A real
self-hosted deployment needs a hostname that resolves for SDK clients
(mobile apps, browsers) and, per the cookie-scope note above, ideally a
hostname that never carries the dashboard's session cookie regardless of
future cookie config — put MinIO's S3 API behind a dedicated subdomain
(e.g. `assets.<your-domain>`, proxied by the edge Caddy or your own
reverse proxy) and set:

```
ASSET_PUBLIC_BASE_URL=https://assets.<your-domain>/rovenue-assets
```

`ASSET_STORAGE_ENDPOINT` can stay `http://minio:9000` (docker-network
internal) — only `api` and `dispatcher` ever call the write API, and both
already run inside the same compose network.
