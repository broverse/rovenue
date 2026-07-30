# Asset response headers — Cloudflare Transform Rule

Adds `X-Content-Type-Options: nosniff` to every response served from the
paywall asset origin on a cloud (`HOST_MODE=cloud`) deployment, where assets
live in an R2 bucket exposed through a custom domain.

Design spec: `docs/superpowers/specs/2026-07-29-paywall-asset-cdn-design.md` §6.

## Why this is not done at upload time

`PutObject` can set `Cache-Control` and `Content-Type` — and Rovenue does set
both — but the S3 API has no field for arbitrary response headers. Writing
`nosniff` as object *metadata* would surface it as `x-amz-meta-…`, which no
browser treats as the real header. So the header has to be added by the layer
that owns the response, which on R2 means a Transform Rule on the zone.

The header matters most for Lottie, which is served as `application/json` —
the one accepted asset type a browser could be talked into sniffing as
something else. Images are `image/webp` and video is `video/mp4`, both of
which browsers already treat as inert.

## What about ETag?

Nothing to do. R2 returns a strong `ETag` on object responses the same way S3
does, so conditional requests and cache revalidation already work. An earlier
draft of the spec listed `ETag: contentHash` as an edge deliverable; that was
based on the assumption that no `ETag` was being sent at all. The store's own
`ETag` is a content hash — a different algorithm than the `contentHash` column,
but serving the identical purpose, and unlike a rewritten one it stays correct
for multipart uploads (where the value is a composite, not a plain digest).

Rewriting it would mean reading `x-amz-meta-content-hash` off the origin
response and copying it into `ETag`, which buys nothing: assets are immutable
(spec §4.1), so any correct validator is as good as any other.

The self-hosted MinIO path was checked directly and returns both a strong
`ETag` and `X-Content-Type-Options: nosniff` on object responses without any
help — see `deploy/caddy/conf.d/assets.caddy.example`, where the header is kept
anyway so the block stays correct in front of an origin that does not add it.

## Applying the rule

Zone: the one holding the asset hostname (e.g. `cdn.rovenue.app`). Replace the
hostname below with the value in `ASSET_PUBLIC_BASE_URL`.

### Dashboard

Rules → Transform Rules → **Modify Response Header** → Create rule

- **If** — Custom filter expression: `http.host eq "cdn.rovenue.app"`
- **Then** — Set static: header `X-Content-Type-Options`, value `nosniff`

### API

The response-header phase entrypoint is a single ruleset per zone, so this
`PUT` replaces whatever is already in that phase. `GET` it first and merge if
the zone has other response-header rules.

```http
PUT /client/v4/zones/{zone_id}/rulesets/phases/http_response_headers_transform/entrypoint
Authorization: Bearer {api_token}
Content-Type: application/json
```

```json
{
  "rules": [
    {
      "description": "Paywall assets: nosniff (design spec §6)",
      "expression": "(http.host eq \"cdn.rovenue.app\")",
      "action": "rewrite",
      "action_parameters": {
        "headers": {
          "X-Content-Type-Options": { "operation": "set", "value": "nosniff" }
        }
      }
    }
  ]
}
```

The API token needs the **Zone → Config → Edit** permission on that zone.

## Verifying

The header must be present on a real object response, not just on the zone
root — Transform Rules are matched per request, and a rule scoped to the wrong
hostname fails silently:

```
HEAD https://cdn.rovenue.app/<projectId>/<assetId>.json
→ x-content-type-options: nosniff
→ etag: "…"
→ cache-control: public, max-age=31536000, immutable
→ content-type: application/json
```

If `nosniff` is missing, check that the request actually went through the
proxied (orange-cloud) hostname: a `cdn` record set to DNS-only bypasses
Transform Rules entirely and serves straight from R2.

## Self-hosted

Not applicable — self-hosted installs serve from MinIO, which sets `nosniff`
itself, and `deploy/caddy/conf.d/assets.caddy.example` sets it again at the
edge for operators who front the bucket with Caddy.
