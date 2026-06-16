# Rovenue edge-cache Worker

A thin Cloudflare Worker that sits in front of the origin API and caches the
SDK's hot, project-wide read endpoints at Cloudflare's 300+ PoPs. This is how
Rovenue serves a **globally distributed** SDK from a **single-region,
self-hosted origin** without standing up multi-region infrastructure:

- The catalog read path (`/v1/offerings`, `/v1/config`) is served from the
  nearest edge in <50ms worldwide.
- Everything else — purchases, webhooks, per-subscriber reads — falls through
  to the single origin unchanged.

The Worker is a transparent reverse proxy: non-cacheable requests are proxied
verbatim, so it is safe to put in front of the whole SDK hostname.

## How caching works

| Concern | Behavior |
|---------|----------|
| **What's cached** | `GET /v1/offerings*` only. `/v1/config` is **not** cached — it is per-subscriber and upserts the subscriber on GET |
| **Per-project isolation** | Cache key includes `SHA-256(public Bearer key)` |
| **Query dimension** | Only `accessId` is part of the key; other params are dropped |
| **Bypass: per-subscriber** | `x-rovenue-user-id` header or `?subscriberId=` → never cached (experiment engine personalizes the response) |
| **Bypass: experiment** | Origin response with `X-Rovenue-Experiment` → not stored |
| **TTL** | `s-maxage=60`, `stale-while-revalidate=300` |
| **Invalidation** | Per-project version in Workers KV; a catalog mutation bumps it → instant global purge, any CF plan |
| **Debug** | Every response carries `X-Rovenue-Edge: HIT \| MISS \| BYPASS*` |

> The origin and the Worker must answer on **different hostnames** (e.g. origin
> `origin.rovenue.io`, edge `edge.rovenue.io`) or the Worker proxies to itself.
> Point the SDK at the edge hostname.

## Setup

```bash
cd deploy/cloudflare/edge-cache
pnpm install

# 1. Create the KV namespace and paste the id into wrangler.jsonc
wrangler kv namespace create CACHE_VERSIONS
wrangler kv namespace create CACHE_VERSIONS --env production

# 2. Set the shared purge secret (the API uses the same value)
wrangler secret put PURGE_SECRET --env production

# 3. Generate Env types, typecheck, deploy
wrangler types
pnpm typecheck
pnpm deploy
```

Set `ORIGIN_URL` (in `wrangler.jsonc`) to the public origin hostname and the
`routes` pattern to the SDK-facing hostname.

## Purge wiring (implemented)

Catalog changes (offering / product create-update-delete) do **not** flow
through the outbox, so the purge is triggered from the dashboard mutation
handlers. This is already wired:

- **Helper:** `apps/api/src/lib/edge-cache.ts` →
  `purgeProjectCatalogCache(projectId)`. It looks up the project's active
  public API keys (`listActiveApiKeys`) and POSTs `{ key }` to the Worker for
  each (a project may have several public keys via rotation; the cache is
  isolated per key). Fire-and-forget, best-effort, never throws, and a no-op
  when `EDGE_CACHE_PURGE_URL` / `EDGE_CACHE_PURGE_SECRET` are unset.
- **Call sites:** `dashboard/offerings.ts` (create / update / delete) and
  `dashboard/products.ts` (create / import-with-creates / update / delete).
- **Not wired: feature flags.** Flags are only served via `/v1/config`, which
  is not cached, so flag changes need no purge.

Env vars (already in `.env.example` and `apps/api/src/lib/env.ts`):

```
EDGE_CACHE_PURGE_URL=https://edge.rovenue.io/__edge/purge
EDGE_CACHE_PURGE_SECRET=<same value as the Worker's PURGE_SECRET>
```

### Invariants to keep in sync

The Worker only caches correctly while these hold for `/v1/offerings`:

- The response varies **only** by project + `accessId` (the cache-key
  dimensions). If a new response-varying input is added (locale, app version,
  geo, …) without a subscriber id, add it to the cache key or the Worker will
  serve cross-segment responses.
- A request that should run the experiment engine **always** carries a
  subscriber id (`x-rovenue-user-id` / `?subscriberId=`) — that is what the
  bypass relies on. Keep experiment evaluation gated on subscriber identity.

## Local dev

```bash
wrangler dev          # proxies to ORIGIN_URL, caching active
curl -H "Authorization: Bearer <public-key>" http://localhost:8787/v1/offerings -i
# → first call: X-Rovenue-Edge: MISS, second: HIT
```
