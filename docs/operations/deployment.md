# Rovenue Deployment Runbook

Production deploy via Docker Compose (Coolify-ready). All commands run
from the repo root on the host.

## 0. Prerequisites
- Docker + Compose v2.
- DNS A records for `rovenue.io`, `edge.rovenue.io`, `app.rovenue.io`,
  `docs.rovenue.io` pointing at the host. CNAMEs for any custom domains
  pointing the same.
- Apple Root CA `.cer` files placed in `./deploy/apple-certs/`
  (Apple Root CA G3 + Apple Inc Root).

## 1. Secrets
Copy `.env.example` to `.env` and fill, at minimum, the prod-required keys
(enforced by `apps/api/src/lib/env.ts`):
`DATABASE_URL`, `ENCRYPTION_KEY` (32-byte hex), `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`, `DASHBOARD_URL=https://app.rovenue.io`,
`VITE_API_URL=https://rovenue.io`, `GITHUB_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`, `CLICKHOUSE_*`, `KAFKA_BROKERS`,
`TLS_EMAIL`, `CANONICAL_HOSTS=rovenue.io,edge.rovenue.io,app.rovenue.io`,
`OUTBOX_DISPATCHER_ENABLED=true`.

## 2. Build
    docker compose build
Builds `api`, `dashboard`, and `docs` images.

## 3. Data plane + migrations
The `migrate` service runs automatically before `api`/workers, but you can
run it explicitly the first time:
    docker compose up -d db redis clickhouse redpanda
    docker compose run --rm migrate

## 4. Start everything
    docker compose up -d
`api` and the four workers wait for `migrate` to exit 0.

## 5. (Optional) Seed dev data
    docker compose run --rm migrate pnpm --filter @rovenue/db seed

## 6. Smoke test
    curl -fsS https://rovenue.io/health
    curl -fsS -o /dev/null -w '%{http_code}\n' https://app.rovenue.io/
    curl -I https://docs.rovenue.io
Expected: health 200, dashboard 200, docs 200.

## 7. Apple Pay on funnel paywalls

Funnel paywalls are served from one Rovenue-controlled host and charge
through each customer's own connected Stripe account. Stripe offers Apple
Pay in that payment sheet only when **the host serving the page** is a
registered payment method domain **on the connected account**. Two things
have to be true.

**a. Name the host.** Set `FUNNEL_PAYMENT_DOMAIN` to the host the paywall
is actually served from — today the dashboard origin, which serves
`/f/<slug>`:

    FUNNEL_PAYMENT_DOMAIN=app.rovenue.io

Bare hostname, no scheme/port/path. There is no default and it is *not*
derived from `DASHBOARD_URL`: registering a host the page is not served
from succeeds at the API level and then Apple Pay silently never appears.
Unset ⇒ no registration is attempted at all (the API logs
`FUNNEL_PAYMENT_DOMAIN is unset; skipping Apple Pay domain registration`).

Registration then runs automatically at the end of the Stripe Connect
OAuth callback, once per connected account
(`apps/api/src/services/stripe/apple-pay-domain.ts`). It never blocks or
fails a connect.

**b. Serve Stripe's domain association file.** Stripe marks Apple Pay
`inactive` on a domain that does not serve it. The file ships in the
dashboard image (`apps/dashboard/public/.well-known/`), so on the default
topology this needs no action — verify it after deploy:

    curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
      https://app.rovenue.io/.well-known/apple-developer-merchantid-domain-association

Expected: `200` and a non-zero size. A `200` returning the SPA's
`index.html` means the file is missing and the SPA fallback answered — the
size and `Content-Type: application/octet-stream` are what distinguish
them.

The file is Stripe's, platform-wide (not per-merchant), published at
<https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association>.
One copy on the host verifies that host for every connected account. If
Stripe ever rotates it, re-download it to that path and rebuild the
dashboard image. If `FUNNEL_PAYMENT_DOMAIN` is set to a host **not** served
by the dashboard image, that host must serve this file itself.

**Checking the result.** The per-account outcome is on
`project_stripe_connections.apple_pay_domain_status` — it stores Stripe's
verdict, not "we called the API":

    select apple_pay_domain_status, count(*)
      from project_stripe_connections
     where disconnected_at is null
     group by 1;

`active` = Apple Pay will appear. `inactive` = the domain is registered but
Apple Pay will **not** appear (almost always item **b** above). `failed` =
the Stripe call errored. `unregistered` = never attempted. Anything other
than `active` fails quietly — the card form still works — so it has to be
checked, not assumed.

## Invariants
- **Single dispatcher:** only `api` has `OUTBOX_DISPATCHER_ENABLED=true`
  and stays `replicas: 1`. Workers force it `false`. Two dispatchers
  double-count ClickHouse revenue aggregates.
  See `docs/architecture/outbox-dispatcher.md`.
- **Persist `caddy-data`:** losing it re-issues every TLS cert and risks
  Let's Encrypt rate limits.
- **`VITE_API_URL` is build-time:** changing the api origin requires
  rebuilding the `dashboard` image (`docker compose build dashboard`).

## Rollback
    docker compose down       # keeps named volumes (data safe)
    git checkout <prev-tag> && docker compose up -d --build
Migrations are forward-only; roll back code, not schema.
