# Custom Domains for Funnels — Backend Design

**Date:** 2026-05-28
**Author:** vfurkanguner
**Status:** Draft

## Goal

Let a project owner attach an arbitrary hostname (e.g. `quiz.acme.com`) to a published funnel so that visitors hitting `https://quiz.acme.com/` see exactly what they would see at `https://{slug}.rovenue.app/` — same published config, same session machinery, same magic-link / universal-link flows. The dashboard already saves a `customDomain` string; this spec adds the storage model, verification flow, TLS provisioning, and edge resolver that make the string actually load-bearing.

## Non-Goals

- **Multi-domain per funnel.** One funnel ↔ at most one custom hostname. Aliases (e.g. `acme.com` + `www.acme.com`) handled by the operator at DNS (CNAME flatten) — not in the data model.
- **Wildcard / subdomain wildcards.** `*.acme.com` is out of scope; one exact hostname per row.
- **Apex (root) domains via A records.** Apex requires a static IP and breaks if we ever move the edge — block in the verifier and tell the operator to use a subdomain.
- **Self-service certificate uploads.** TLS is provisioned automatically; we don't accept BYO certs in v1.
- **Multi-project ownership transfer.** Once a hostname is verified for project A, it's locked to project A until deleted.
- **Reverse routing** (the dashboard / API on custom domains). Custom domains serve only published funnels; admin paths stay on the canonical host.

## Decisions

| Concern | Choice | Reason |
|---|---|---|
| Edge TLS | **Caddy with on-demand TLS** in front of the API, gated by a `/internal/domains/check` ask-endpoint | Zero ops for cert lifecycle; we don't need to manage ACME ourselves; ask-endpoint prevents cert flooding from unverified hostnames |
| DNS verification | **CNAME-only** to `edge.rovenue.app` + a TXT challenge at `_rovenue.{hostname}` containing a per-row token | CNAME confirms control of the record; TXT confirms control of the zone (defends against CNAME-hijack of a stale dangling subdomain) |
| Verification trigger | Manual "Verify" button + a background retry job (bullmq) that re-checks unverified rows every 30 min for 7 days, then marks `verification_failed` | Owner usually fixes DNS within minutes; backstop the long tail without infinite retries |
| Hostname → funnel lookup | **Redis cache** (`domain:{hostname}` → `{funnelId, projectId}`) populated by the public route, invalidated on row mutation; Postgres fallback | Hot path; matches the existing `readPublishedConfig` pattern |
| Hostname uniqueness | Postgres unique index on `LOWER(hostname)`; conflict surfaces as `409 hostname_taken` | Hostnames are global, not project-scoped — DNS doesn't care about our project boundaries |
| Reserved hostnames | Static blocklist enforced at create-time: `rovenue.app`, `*.rovenue.app`, `localhost`, `*.local`, anything matching the canonical edge | Stops an attacker from claiming a subdomain that overlaps the public surface |
| Edge resolver scope | Reads `Host` header in `routes/public/funnels.ts` before falling back to `:slug` path param | Custom-domain visitors hit `/` directly — no slug in the URL, only in the lookup result |
| Audit | Every create / verify / delete writes an `audit_logs` entry via the existing `audit()` helper | Same hash-chain contract as the rest of the project |
| TLS readiness | A row is "serving" only when `verified_at IS NOT NULL AND cert_status = 'issued'`; the ask-endpoint short-circuits anything else | One source of truth for whether the edge will serve a hostname |

## Architecture

### Data model — new `custom_domains` table

```ts
// packages/db/src/drizzle/schema.ts (new section)

export const customDomainCertStatus = pgEnum("custom_domain_cert_status", [
  "pending",       // row created, no cert yet
  "issuing",       // Caddy is mid-ACME (transient)
  "issued",        // cert live, edge will serve
  "failed",        // ACME failed (rate-limit, CAA, etc.) — surfaced to dashboard
]);

export const customDomains = pgTable(
  "custom_domains",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    funnelId: text("funnel_id")
      .notNull()
      .references(() => funnels.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),                       // lowercased, no scheme, no trailing slash
    verificationToken: text("verification_token").notNull(),    // 32-byte hex, surfaced as TXT value
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    verificationFailureReason: text("verification_failure_reason"),
    certStatus: customDomainCertStatus("cert_status").notNull().default("pending"),
    certIssuedAt: timestamp("cert_issued_at", { withTimezone: true }),
    certFailureReason: text("cert_failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    hostnameUnique: uniqueIndex("custom_domains_hostname_unique").on(t.hostname),
    funnelUnique: uniqueIndex("custom_domains_funnel_unique").on(t.funnelId), // one custom domain per funnel
    projectIdx: index("custom_domains_project_idx").on(t.projectId),
    pendingIdx: index("custom_domains_pending_idx").on(t.verifiedAt).where(sql`verified_at IS NULL`),
  }),
);
```

Notes:
- `funnelUnique` enforces the one-funnel-one-hostname rule at the DB layer.
- `pendingIdx` is partial — keeps the index tiny since verified rows dominate.
- Hostname stored as the canonical lowercased form; input must normalize before hitting the repo.

### Repository — `packages/db/src/drizzle/repositories/custom-domains.ts`

```ts
export const customDomainRepo = {
  create(tx, input: NewCustomDomain): Promise<CustomDomain>,
  findById(tx, id: string): Promise<CustomDomain | null>,
  findByHostname(tx, hostname: string): Promise<CustomDomain | null>,
  findByFunnel(tx, funnelId: string): Promise<CustomDomain | null>,
  listByProject(tx, projectId: string): Promise<CustomDomain[]>,
  listPending(tx, olderThan: Date): Promise<CustomDomain[]>,  // for the retry job
  updateById(tx, id: string, patch: Partial<CustomDomain>): Promise<CustomDomain | null>,
  deleteById(tx, id: string): Promise<boolean>,
};
```

Mirrors the existing `funnelRepo` shape. Lowercases hostname in `create` / `findByHostname` as a defense-in-depth.

### Dashboard API — `apps/api/src/routes/dashboard/custom-domains.ts`

| Method + path | Purpose |
|---|---|
| `GET    /v1/dashboard/projects/:projectId/custom-domains` | List for a project (admin UI; also used by the funnel-detail page) |
| `POST   /v1/dashboard/funnels/:funnelId/custom-domain` | Attach a hostname to a funnel — generates token, validates blocklist, 409 on collision |
| `POST   /v1/dashboard/custom-domains/:id/verify` | Synchronous DNS check (CNAME + TXT). On success flips `verified_at`, enqueues cert-issuance check |
| `DELETE /v1/dashboard/custom-domains/:id` | Revoke. Edge cache invalidation in the same tx-commit hook |

All routes:
- Run through the existing dashboard auth middleware (Better Auth session + project-membership check).
- Validate hostname shape with Zod: `hostname-rfc1123` regex, length ≤ 253, no scheme, no path, no port, lowercased.
- Reject reserved hostnames (`rovenue.app` and `*.rovenue.app`, `localhost`, anything matching `^(www\.)?rovenue\.(app|com|dev)$`).
- Wrap mutations in a `drizzle.db.transaction` and emit an `audit()` row in the same tx (matches the `funnels.ts` pattern at `apps/api/src/routes/dashboard/funnels.ts:218`).

Response shape uses the project's `{ data, error }` envelope, e.g.:

```json
{
  "data": {
    "id": "cdm_…",
    "hostname": "quiz.acme.com",
    "status": "pending",
    "verification": {
      "cname": { "name": "quiz.acme.com", "value": "edge.rovenue.app" },
      "txt":   { "name": "_rovenue.quiz.acme.com", "value": "rv-verify=…" }
    },
    "certStatus": "pending",
    "createdAt": "2026-05-28T…"
  }
}
```

### DNS verification

```ts
// packages/shared/src/dns/verify.ts (new)

async function verifyCustomDomain(row: CustomDomain): Promise<VerifyResult> {
  // 1. CNAME check — uses node's dns/promises.resolveCname against 1.1.1.1 + 8.8.8.8
  //    in parallel; both must agree (defeats DNS-poisoning surprises).
  const cnames = await Promise.all([resolveCnameVia("1.1.1.1", row.hostname), resolveCnameVia("8.8.8.8", row.hostname)]);
  if (!cnames.every((c) => c.includes("edge.rovenue.app"))) {
    return { ok: false, reason: "cname_missing" };
  }

  // 2. TXT challenge at _rovenue.{hostname}
  const txt = await Promise.all([resolveTxtVia("1.1.1.1", `_rovenue.${row.hostname}`), resolveTxtVia("8.8.8.8", `_rovenue.${row.hostname}`)]);
  if (!txt.every((t) => t.flat().includes(`rv-verify=${row.verificationToken}`))) {
    return { ok: false, reason: "txt_missing" };
  }

  return { ok: true };
}
```

The verify endpoint is synchronous (typical CNAME check resolves in <500 ms once propagated). The background retry job calls the same function — failures bump `lastCheckedAt` and `verificationFailureReason` so the dashboard can show an actionable error.

### TLS provisioning — Caddy on-demand TLS

`deploy/docker-compose.yml` gains a Caddy service in front of the API:

```Caddyfile
{
    on_demand_tls {
        ask http://api:3000/internal/domains/check
        interval 2m
        burst 5
    }
}

# Canonical surface — explicit cert via DNS-01 or HTTP-01, no on-demand
*.rovenue.app, rovenue.app, edge.rovenue.app {
    reverse_proxy api:3000
}

# Custom domains — opt in to on-demand TLS
:443 {
    tls {
        on_demand
    }
    reverse_proxy api:3000
}
```

The ask-endpoint at `GET /internal/domains/check?domain={hostname}` returns `200` only when:

```sql
SELECT 1
  FROM custom_domains
 WHERE LOWER(hostname) = LOWER($1)
   AND verified_at IS NOT NULL
```

Anything else returns `404` — Caddy refuses to even start an ACME challenge, which keeps Let's Encrypt rate-limits unreachable by attackers spraying random hostnames.

Cert lifecycle in our DB:
- Row written with `cert_status = 'pending'`.
- A background poller (`apps/api/src/jobs/cert-status.ts`) hits Caddy's admin API every minute for the first 10 minutes after `verified_at` is set, flipping `cert_status` to `issued` / `failed`.
- The edge resolver only serves a row when `cert_status = 'issued'` (otherwise the request to Caddy would have failed anyway — this just stops us caching a misleading row).

The ask-endpoint is the **only** route mounted on the internal port; never exposed externally. We bind it to a separate Hono sub-app on `:3001` listening on the docker network only.

### Edge resolver — modify `apps/api/src/routes/public/funnels.ts`

Add a "host pre-flight" before the existing slug routes:

```ts
public.get("/funnels", async (c, next) => {
  // No slug in path → must be host-based
  const host = c.req.header("host")?.split(":")[0]?.toLowerCase();
  if (!host || host === CANONICAL_HOST || host.endsWith(`.${CANONICAL_HOST}`)) {
    return c.notFound();
  }
  const resolved = await resolveCustomDomain(host);  // redis → pg
  if (!resolved) return c.notFound();
  // Hand off to the existing :slug pipeline
  return loadPublishedFunnel(c, resolved.slug);
});
```

`resolveCustomDomain`:
1. Read `domain:{host}` from Redis.
2. On miss, query `customDomainRepo.findByHostname` joined with `funnels.slug`.
3. Only return verified rows (`verified_at IS NOT NULL AND cert_status = 'issued'`).
4. Cache the result with a 5-minute TTL; invalidate on every dashboard mutation via a `DEL domain:{host}` in the post-commit hook.

`POST /public/funnels/:slug/sessions` doesn't need changes — once the host pre-flight loads the funnel, downstream session creation uses the resolved slug just like today.

### Background workers

- **`custom-domain-verify` (bullmq, every 5 min)** — `customDomainRepo.listPending(olderThan: now - 30 min)`, call `verifyCustomDomain`, persist the result. Stops re-checking after the row is `7 days old` (marks as `verification_failed`; owner has to delete + recreate to retry).
- **`custom-domain-cert-status` (bullmq, every 1 min for the first 10 min after verify)** — polls Caddy admin API; updates `cert_status` + cache.

Both queues live alongside the existing webhook / partition workers in `apps/api/src/jobs/`.

### Conflict guards & security

- **Hostname uniqueness** — DB-level unique index; create route catches the `pg_unique_violation` and returns `409 { error: { code: "hostname_taken" } }`.
- **Reserved hostnames** — central allowlist matcher; rejected with `400 { error: { code: "hostname_reserved" } }`.
- **Project-scope on mutations** — `:id`-style routes verify `customDomain.projectId === membership.projectId` before touching anything; deletes outside scope return `404` (not `403`, to avoid leaking existence).
- **Verification token entropy** — 32-byte cryptographic random via `crypto.randomBytes(32).toString("hex")`. Rotated when a row's verification fails and the owner re-issues.
- **CAA records** — documented but not enforced. We rely on Caddy / Let's Encrypt's own CAA check; if the owner's CAA blocks Let's Encrypt, ACME fails and we mark `cert_status = 'failed'` with a helpful message.
- **CNAME-flattening** (Cloudflare, Vercel, etc.) — handled by the dual-resolver approach above; both 1.1.1.1 and 8.8.8.8 see the flattened target, and `edge.rovenue.app` matches in both.

### Dashboard wiring — minimal frontend changes

The settings-tab field already exists. Replace the "save string" model with three states keyed off the `custom_domains` row:

1. **No row** — input + "Add domain" button.
2. **Pending verification** — show the CNAME + TXT records, "Verify" button, "Remove" button.
3. **Verified** — show "Serving at https://{hostname}" + "Remove" button.

Wire to:
- `GET /v1/dashboard/funnels/:funnelId` already returns the funnel; extend its response to include the attached `customDomain` row (or null) so the SettingsTab doesn't need a second fetch.
- New mutation methods on `FunnelDraftViewModel`: `attachCustomDomain(hostname)`, `verifyCustomDomain()`, `removeCustomDomain()`.

The existing `customDomain: string` in the draft `Settings` blob becomes display-only / removed once this lands — the row is the source of truth.

## Migration sequence

1. Schema migration: new enum + table + indexes. Empty rows on deploy — zero data backfill.
2. Repo + dashboard routes ship behind an existing membership check; no public surface yet.
3. Caddy compose changes deploy together with the ask-endpoint. Until rows exist, ask-endpoint always returns 404 — Caddy never issues a cert.
4. Edge resolver lands last. Until it's deployed, a verified row exists but `quiz.acme.com` returns 404; the canonical host keeps working. This means we can verify the verification flow end-to-end before flipping serving on.

## Test strategy

- **Unit** — verifier (mocked DNS resolution), hostname-shape Zod schema, reserved-list matcher, repo CRUD.
- **Integration** (`*.integration.test.ts` w/ testcontainers Postgres + Redis) — create → verify (with a stubbed DNS resolver) → resolve → delete → confirm cache invalidation.
- **Manual** — one real domain (CNAME flattening from Cloudflare, vanilla CNAME from Route 53) end-to-end before flipping the edge route on.

## Open questions

1. **Apex domains** — block in v1 as decided, but should we offer an `ALIAS` / `ANAME` workaround doc? Cloudflare and Route 53 both support it; smaller registrars don't.
2. **Custom-domain analytics** — events emitted from a custom-domain session should still attribute to the correct project. The session row already carries `funnel_id`, so this works for free — flag for verification in the integration test.
3. **Redirect from canonical** — once a custom domain verifies, should `https://{slug}.rovenue.app/` 301 to it? Defaults to "yes" for SEO, but some operators want both URLs live (campaign URLs that pre-dated the domain). Suggest a per-row `redirect_canonical: boolean` (default true). Out of scope for v1; tracking as Q for v2.
4. **Domain ownership transfer** — locked to original project today. If a project shuts down and the operator wants to move the domain, today's answer is "delete + recreate on the new funnel after DNS still resolves." Acceptable.
5. **Caddy state durability** — Caddy stores ACME state on a volume. Document the volume in `deploy/coolify/` so a redeploy doesn't lose certs.

## Implementation plan (rough order)

1. Schema + repo + migration.
2. Dashboard CRUD routes + integration tests.
3. DNS verifier module + retry job.
4. Caddy compose + ask-endpoint on internal port.
5. Edge resolver + redis cache + invalidation hook.
6. Cert-status poller.
7. Dashboard UI swap (input → row-driven state).
8. End-to-end manual test with a real hostname.
9. Flip the edge route on in production after a soak.
