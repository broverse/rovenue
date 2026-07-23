# SP3 — Custom-domain funnel serving

Date: 2026-07-23
Status: approved (design)
Surfaces: `deploy/caddy`, `apps/api`, `apps/dashboard`

## Context

The follow-up ledger recorded custom-domain funnel serving as "out of scope from
the start — Caddy proxies custom hosts to the API, which serves no HTML".

That is accurate, and the remaining gap is narrower than it sounds. Everything
except HTML delivery is already built:

| Piece | State |
|---|---|
| `resolveHost` — hostname → funnel, Redis hot path + Postgres fallback, negative cache | shipped (`apps/api/src/services/custom-domains/host-resolver.ts`) |
| `GET /host/lookup` | shipped |
| `GET /funnels/:slug` published runtime bundle | shipped |
| DNS verification worker + cert poller | shipped |
| Caddy on-demand TLS gated by an ask-endpoint | shipped (`deploy/caddy/Caddyfile:30-36`) |
| **HTML delivery to a custom host** | missing |

`deploy/caddy/Caddyfile:78-88` proxies the on-demand `:443` block to `api:3000`,
and the API serves JSON. A visitor to a verified custom domain gets no page.

Two things found while investigating that the ledger did not record:

**`GET /host/lookup` has zero callers, and cannot work as written.** Its comment
says it "lets the SDK discover its funnel slug when it's loaded from a custom
domain", but it resolves from the `Host` header. The dashboard calls the API at
an absolute `VITE_API_URL` (`apps/dashboard/src/lib/api.ts:5`), so on any
cross-origin call the `Host` header is the API's own hostname, never the custom
domain. The endpoint was built for a caller that never arrived, in a shape that
caller could not have used.

**The SPA root route bounces funnel visitors to `/login`.**
`apps/dashboard/src/routes/index.tsx` redirects to `/login` when there is no
session, so even once a custom host is served the page, a visitor lands on a
Rovenue login screen.

## Item 1 — edge routing

`deploy/caddy/Caddyfile`'s on-demand `:443` block proxies to the dashboard origin
instead of `api:3000`.

No path split is required. The dashboard SPA calls the API through an absolute
`VITE_API_URL` baked at build time, so its API traffic goes straight to the API
regardless of which host served the document. The block only needs to serve
static files.

`on_demand_tls`'s `ask` endpoint (`http://api:3001/internal/domains/check`) is
unchanged and still points at the API. It remains the gate that stops Caddy
issuing a certificate for a hostname that is not a verified `custom_domains` row.

Serving the dashboard origin also satisfies a requirement that would otherwise
need its own work: Stripe's Apple Pay domain-association file ships in the
dashboard's Vite `public/` directory and is served with the `Content-Type`
`Caddyfile.dashboard:22` sets. A custom host proxied there serves it
automatically.

### Rejected alternatives

- *API renders an HTML shell.* Vite fingerprints asset filenames, so the API
  would have to read the dashboard's build manifest or the dashboard would have
  to emit a stable-named entry. Extra coupling and a new failure mode, for no
  gain over serving the origin that already has the assets.
- *A dedicated funnel origin (new Vite entry, image and compose service).*
  Architecturally the cleanest and it would cut the 782 KB shared entry bundle
  for **all** funnel traffic — but that is a bundle-diet win for `/f/<slug>` too,
  not something custom domains specifically need. It belongs in its own
  sub-project, not smuggled into this one.

## Item 2 — host resolution

`GET /host/lookup` accepts an optional `?host=` query parameter and falls back to
the `Host` header when it is absent. The dashboard passes
`window.location.hostname`.

The client naming its own host is not a privilege escalation. The response is
`{ funnelId, slug }`, and that mapping is already public: the funnel is reachable
to anyone at `/f/<slug>`. `resolveHost` continues to resolve only rows that are
both `verifiedAt` and `certStatus === "issued"`, so an unverified or
half-configured domain still returns 404 and its negative result is still cached.

## Item 3 — the SPA root route

`apps/dashboard/src/routes/index.tsx` currently redirects to `/login` without a
session. It gains a funnel branch that runs **before** the session check:

1. If `VITE_DASHBOARD_HOST` is set and equals `window.location.hostname`, this is
   the canonical dashboard — skip the lookup and keep today's behaviour exactly.
2. Otherwise call `GET /host/lookup?host=<hostname>`. On a hit, render
   `<FunnelRunner slug={slug} />`. On a 404, fall through to today's behaviour.

The env var is an optimisation, not a switch. When it is unset the lookup runs
and the outcome is identical — one extra request on the canonical host's landing,
against a 60-second negative cache. That ordering is deliberate: a self-hoster who
never sets the variable still gets working custom domains, rather than a silent
failure that only shows up in production.

`VITE_DASHBOARD_HOST` is named by the operator rather than derived from
`DASHBOARD_URL`, following the precedent `registerApplePayDomain` sets
(`apps/api/src/services/stripe/apple-pay-domain.ts:92-101`): a host that is
guessed wrong fails silently and late.

## Item 4 — Apple Pay on custom domains

Stripe will not show an Apple Pay button on a host that is not registered as a
payment-method domain. `registerApplePayDomain(projectId)` today reads
`env.FUNNEL_PAYMENT_DOMAIN` and registers that single host, so a customer who
binds their own domain would watch Apple Pay — working on the canonical host —
silently vanish on theirs.

The function takes the domain as a second parameter, defaulting to
`env.FUNNEL_PAYMENT_DOMAIN` so every existing caller is unchanged. Its own doc
comment already explains why the host must be named rather than inferred; that
reasoning is preserved and now applies to both callers.

The new call site is `apps/api/src/workers/custom-domain-cert-poller.ts:76-85`,
where the row transitions to `certStatus: "issued"` — the exact moment the domain
becomes servable. Registration is idempotent (it lists before adding) and
**best-effort**: a failure is logged and does not roll back the cert transition. A
domain that serves its funnel but lacks an Apple Pay registration is a degraded
state; a domain stuck at `issuing` because a Stripe call failed is a broken one.

No registration happens on the `failed` transition.

**Found while planning — the connection-status write must not follow.**
`registerApplePayDomain` ends by calling
`stripeConnectionRepo.updateApplePayDomainStatus(db, connection.id, status)`
(`apple-pay-domain.ts:136-141`). That column lives on the **connection** row, one
per project, while a project can now have many registered domains. Left as-is, a
custom domain's verdict would overwrite the canonical domain's, so the dashboard
would report Apple Pay as broken on the canonical host because some customer's
domain had not finished Apple's checks.

The column keeps its existing meaning — the status of the canonical
`FUNNEL_PAYMENT_DOMAIN` — and the write is guarded on
`domainName === env.FUNNEL_PAYMENT_DOMAIN` rather than gated by a new parameter,
so the rule is visible at the only place that could break it.

A custom domain's own Apple Pay status is therefore not persisted; it is logged
at the same level the canonical path already logs. Surfacing it per-domain in the
dashboard needs a column on `custom_domains` and is deliberately left out of this
sub-project.

## Item 5 — non-funnel routes on a custom host

SPA fallback means `https://customer-domain.com/login` returns `index.html` and
the router renders the dashboard login. That is not an auth hole — sessions are
bound to the canonical origin — but showing Rovenue's admin UI on a customer's
domain is wrong.

On a host that resolves to a funnel, the root route renders the runner and any
other path renders the same runner rather than a dashboard screen. A host that
resolves to nothing keeps today's behaviour, so the canonical dashboard is
untouched.

## Testing

Every behaviour below must be mutation-checked: after the test passes, revert the
production change, confirm the test goes red, restore.

**Host resolution** — unit tests on the route: `?host=` resolves; the `Host`
header still resolves when the parameter is absent; an unverified or
cert-pending row returns 404 through both paths. The existing `resolveHost` tests
already cover the repository behaviour and are not duplicated.

**Apple Pay registration** — a case in the cert-poller's integration test that
registration is called with the row's hostname on the `issued` transition, and a
case that it is **not** called on `failed`. A third that a throwing registration
leaves `certStatus` at `issued` — the best-effort contract, which is the part a
future refactor is most likely to break.

**SPA root route** — a custom host resolving to a funnel renders the runner and
does not redirect to `/login`; the canonical host keeps today's redirect
behaviour; an unresolvable host also keeps it.

**The Caddyfile change cannot be unit-tested.** No automated test in this repo
exercises the edge configuration. The plan therefore carries an explicit manual
verification step — bring the compose stack up, point a host at the on-demand
block, and confirm an HTML document is returned rather than JSON. Stating this is
the point: an untested config change reported as verified would be the same class
of quiet failure this sub-project removes.

## Out of scope

- A dedicated funnel origin / bundle diet for `/f/<slug>` — its own sub-project.
- Registering custom domains with Stripe for **existing** verified rows. The new
  call site covers domains verified from here on; a backfill mirrors
  `apps/api/src/scripts/backfill-apple-pay-domains.ts` and is a follow-up.
- Per-funnel branding on custom domains (favicon, title, meta tags).
- SP4 (Phase 2 runner input capture).
