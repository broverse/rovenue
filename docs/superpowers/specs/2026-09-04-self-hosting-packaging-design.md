# Self-hosting packaging: one-command install, upgrade, backup, asset headers

Closes ROADMAP §8 in full:

- One-command install: Coolify template + Helm chart
- Version upgrade runbook
- Backup / restore documentation
- Close the nosniff/ETag edge-layer gap (asset CDN)

## 1. Why this is one spec and not four

The three install/operate items share a single unmet precondition: **Rovenue
publishes no container images.** `api`, `dashboard`, `docs`, `migrate` and `db`
are all `build:` stanzas in the root compose file, and the only release workflow
in `.github/workflows` publishes SDK packages. A Helm chart cannot build an
image, and a Coolify one-click template that builds from source is not a
one-command install. So image publishing is section 3 and everything else
depends on it.

That precondition has a precondition of its own, which is the single most
load-bearing finding in this design:

> **A prebuilt dashboard image cannot exist today.** `VITE_API_URL`,
> `VITE_HOST_MODE`, `VITE_ALLOW_REGISTRATION` and `VITE_DASHBOARD_HOST` are
> inlined by Vite **at build time** (`apps/dashboard/Dockerfile:14-30`), read
> from thirteen call sites in `apps/dashboard/src`. A published
> `ghcr.io/broverse/rovenue-dashboard:v1.2.0` would have `http://localhost:3000`
> baked into it and would be useless to every operator.

The fourth item (asset headers) is independent and small, and rides along
because it belongs in the same runbooks.

## 2. Runtime configuration for the dashboard

**The only section that touches application code.** Everything else is new
files under `deploy/`, `docs/`, `scripts/` and `.github/`.

### 2.1 Contract

A single module, `apps/dashboard/src/lib/runtime-config.ts`, resolves each
value in a fixed precedence:

```
window.__ROVENUE_CONFIG__[key]   →   import.meta.env[VITE_<key>]   →   default
```

Runtime wins over build time, because in a published image the build-time value
is only ever the development default. `import.meta.env` survives as the
`pnpm dev` path, where no `/config.js` is served by Vite's dev server.

The module exports named accessors, not a bag of strings, so the four keys stay
a closed set:

| Accessor | Runtime key | Build fallback | Default |
|---|---|---|---|
| `apiBaseUrl()` | `apiUrl` | `VITE_API_URL` | `http://localhost:3000` |
| `hostMode()` | `hostMode` | `VITE_HOST_MODE` | `self` |
| `allowRegistration()` | `allowRegistration` | `VITE_ALLOW_REGISTRATION` | unset |
| `dashboardHost()` | `dashboardHost` | `VITE_DASHBOARD_HOST` | unset |

`apps/dashboard/src/lib/host-mode.ts` and `custom-host.ts` already read through
a small named env object (three of the thirteen lines), so they change in one
place each. The other ten sites are direct
`import.meta.env.VITE_API_URL ?? "http://localhost:3000"` reads and become
`apiBaseUrl()`. The literal `"http://localhost:3000"` — currently repeated at
those ten call sites — collapses into one named constant inside the module.

An ESLint `no-restricted-syntax` rule forbids `import.meta.env.VITE_` outside
`runtime-config.ts`. Without it the next feature adds an eleventh direct read
and silently reintroduces the build-time coupling this section exists to
remove; nothing else would catch it, because the bug only appears in a
published image.

### 2.2 Delivery

`apps/dashboard/index.html` gains one line before the module script:

```html
<script src="/config.js"></script>
```

`apps/dashboard/public/config.js` ships an empty assignment
(`window.__ROVENUE_CONFIG__ = {};`) so the dev server and any operator who
never sets an env var both get a 200 rather than a console error.

`deploy/dashboard/entrypoint.sh` (new) overwrites `/srv/config.js` at container
start from the process environment, then `exec caddy run`. Values are emitted
with `jq` (added to the runtime image via `apk add --no-cache jq`) — a value
containing a quote or a newline must not be able to produce a syntactically
broken `config.js`, and `printf` with manual escaping is exactly the kind of
thing that works until someone sets a password-shaped value. Keys whose env var
is unset are **omitted**, not emitted as `""`, because `host-mode.ts`
distinguishes unset from empty.

`deploy/caddy/Caddyfile.dashboard` gains `header /config.js Cache-Control
"no-cache"` alongside the existing `index.html` rule. A cached `config.js`
survives a redeploy that changed the API origin — the failure is a dashboard
talking to the wrong host, with no error anywhere.

The dashboard container therefore needs a writable `/srv`. The Helm chart must
not set `readOnlyRootFilesystem: true` on that pod; this is noted in the chart's
values comments.

`VITE_*` build args stay in `apps/dashboard/Dockerfile` and in the root compose
file so the build-from-source path is unchanged and existing deployments keep
working. They become the fallback, not the mechanism.

### 2.3 Apple root certificates

`deploy/apple-certs/` contains only `.gitkeep`. In production
`APPLE_ROOT_CERTS_DIR` is required and the App Store JWS verifier fails closed
without it, so every packaging path would otherwise need an operator to fetch
two files by hand before the stack works — a guaranteed support burden on a
one-command install.

Apple's root CAs are public, freely redistributable trust anchors. They are
**baked into the `rovenue-api` image** at build time: `apps/api/Dockerfile`
fetches `AppleRootCA-G3.cer` and `AppleIncRootCertificate.cer`, verifies each
against a pinned SHA-256 recorded in the Dockerfile, and copies them to
`/etc/rovenue/apple-certs`. A checksum mismatch fails the build — a trust root
that silently changed is not a thing to ship past.

`APPLE_ROOT_CERTS_DIR` defaults to that directory. The existing volume mount in
the root compose file stays and still wins, so an operator with their own copy
is unaffected.

## 3. Image publishing

`.github/workflows/release-images.yml` (new).

**Trigger:** `push` on tags matching `v*.*.*`, plus `workflow_dispatch` with a
tag input. Not on every `main` push — these are multi-arch builds and the
upgrade runbook pins versions, not commits.

**Images**, all under `ghcr.io/broverse/`:

| Image | Dockerfile | Notes |
|---|---|---|
| `rovenue-api` | `apps/api/Dockerfile` | Also runs `migrate`, `dispatcher`, and all four notification workers — same image, different `command` |
| `rovenue-dashboard` | `apps/dashboard/Dockerfile` | Requires §2 |
| `rovenue-docs` | `apps/docs/Dockerfile` | Fully static, no build-time config |
| `rovenue-postgres` | `deploy/postgres/Dockerfile` | Postgres 16 + pg_partman |

**Tags:** `vX.Y.Z`, `X.Y`, and `latest`. `latest` is what the Coolify template
would resolve to for an operator who never pins; the upgrade runbook tells them
to pin.

**Platforms:** `linux/amd64` and `linux/arm64`. Built on native runners
(`ubuntu-24.04` and `ubuntu-24.04-arm`) with `docker/build-push-action`
producing per-arch digests, joined by a `docker buildx imagetools create`
manifest step. QEMU emulation is explicitly rejected: `pnpm install` plus
`vite build` under emulated arm64 runs into tens of minutes and turns a release
into an afternoon.

**Chart:** the same workflow runs `helm package deploy/helm/rovenue` and
`helm push` to `oci://ghcr.io/broverse/charts`, using the same version as the
tag. Chart version and app version move together; a chart that can reference an
image tag that was never built is a support ticket waiting to happen.

## 4. Coolify template

`deploy/coolify/docker-compose.yml` (new), self-contained.

**Constraints that shape it.** A Coolify service template is parsed by Coolify,
not run from a repo checkout, so it cannot `build:` and cannot bind-mount repo
paths (`./deploy/caddy/Caddyfile`, `./deploy/clickhouse/users.d`, …). Config
files are supplied as inline `content:` on bind volumes, which Coolify
materialises on the host. If that mechanism turns out not to cover a given file
during implementation, the fallback is baking that config into a dedicated
image — decided per file, not up front.

**Caddy is dropped from this template.** Coolify's own proxy terminates TLS and
routes by domain; a second edge would mean two ACME clients competing for the
same hostnames. The cost is real and is stated in the template header and in the
docs: **funnel custom domains do not work on the Coolify path**, because that
feature is Caddy's on-demand TLS gated by the api's
`/internal/domains/check` ask-endpoint, which Coolify's proxy has no equivalent
for. Operators who need custom domains use the plain compose path.

**Generated secrets.** Coolify magic variables remove nearly all manual entry:

- `SERVICE_FQDN_API_3000`, `SERVICE_FQDN_DASHBOARD_80`, `SERVICE_FQDN_DOCS_80`
  — domains, which also feed `BETTER_AUTH_URL`, `DASHBOARD_URL` and the
  dashboard's runtime `apiUrl`.
- `SERVICE_PASSWORD_POSTGRES`, `SERVICE_PASSWORD_CLICKHOUSE`,
  `SERVICE_PASSWORD_MINIO`, `SERVICE_BASE64_64_BETTERAUTH`.

**One value is not generatable and the operator must paste it:**
`ENCRYPTION_KEY` is validated as `^[0-9a-fA-F]{64}$`
(`apps/api/src/lib/env.ts:102`) and none of Coolify's generators emit hex.
Deriving it from a Coolify-generated secret is rejected — a silent key
derivation is the kind of crypto convenience that is discovered years later.
The template header carries the command (`openssl rand -hex 32`) and the
warning that losing this value makes every stored store-credential
unrecoverable. This is the honest limit of "one command" here, and it is
documented as such rather than papered over.

**ClickHouse password coupling.** `CLICKHOUSE_PASSWORD_SHA256` on the server
must match `CLICKHOUSE_PASSWORD` on the clients, and the migrate service must
use the write user `rovenue` while the api uses `rovenue_reader` — the exact
trap already documented in the root compose file, which produced a migrated
Postgres and an empty ClickHouse. The template derives the hash inside the
clickhouse service's own command — `CLICKHOUSE_PASSWORD_SHA256=$(printf %s
"$CLICKHOUSE_PASSWORD" | sha256sum | cut -d' ' -f1)` before `exec`ing the stock
entrypoint — so the server hash and the client password cannot drift, because
there is only one value.

**Observability services are omitted.** They are a compose profile today;
Coolify has no profile concept and shipping eight extra containers by default
would make the template look heavier than the product is.

`deploy/coolify/README.md` covers submission to Coolify's service catalogue
(the `# documentation:` / `# slogan:` / `# tags:` / `# logo:` header comments)
and the post-install checklist: OAuth callback URLs, DNS, and the asset-header
verification from §8.

## 5. Helm chart

`deploy/helm/rovenue/` (new).

### 5.1 Workloads

| Template | Kind | Notes |
|---|---|---|
| `api` | Deployment | `replicaCount` configurable; HPA optional |
| `dispatcher` | Deployment | **`replicas: 1` written as a literal**, not read from values |
| `notifier-worker`, `digest-scheduler`, `send-email-worker`, `send-push-worker` | Deployment | One each, same image, distinct `command` |
| `dashboard`, `docs` | Deployment | Static servers |
| `migrate` | Job | Helm hook, see §5.2 |
| `caddy` | Deployment + Service | `edge.mode=caddy`, see §5.3 |

The dispatcher's single replica is a correctness constraint
(`docs/architecture/outbox-dispatcher.md`), not a tuning default. Exposing it in
`values.yaml` invites an operator to scale it "for availability" and get
duplicate publishes. It is a literal with a comment saying why.

### 5.2 Migrations

The migrate Job is annotated `helm.sh/hook: post-install,pre-upgrade` with
`hook-delete-policy: before-hook-creation`.

**Not `pre-install`.** Helm runs `pre-install` hooks before any non-hook
resource, so with the chart's own Postgres StatefulSet enabled a `pre-install`
migrate Job would wait for a database that Helm has not created yet and the
install would deadlock on first run. `post-install` lets the data plane come up
with the chart; api pods crash-loop for the seconds the migration takes and
recover on their own. On upgrade the ordering matters in the other direction —
`pre-upgrade` runs migrations before the new api pods roll out, so no pod ever
serves an un-migrated schema.

The Job runs the same two commands as the compose `migrate` service, with
`CLICKHOUSE_USER` overridden to the schema owner.

### 5.3 Edge and TLS

`edge.mode` has two values.

- **`caddy` (default).** Caddy as a Deployment behind a `LoadBalancer` Service,
  with `/data` on a PVC and `replicas: 1` (ACME state is not shareable across
  replicas). Preserves on-demand TLS for funnel custom domains, matching the
  compose deployment exactly. The ask-endpoint reaches the api's internal port
  through a ClusterIP Service that is not exposed outside the namespace.
- **`ingress`.** No Caddy. A standard `Ingress` per public host, TLS delegated
  to cert-manager or the operator's controller. **Funnel custom domains are
  unavailable in this mode** — cert-manager issues from declared hosts and has
  no equivalent of an issuance-time ask-endpoint. `customDomains.enabled=true`
  together with `edge.mode=ingress` fails `helm template` with a message naming
  both settings, rather than installing cleanly and leaving a product feature
  quietly broken.

### 5.4 Data plane

`postgres`, `clickhouse`, `redpanda`, `redis` and `minio` each get an
`enabled` flag, defaulting to `true`, backed by StatefulSets with PVCs. When one
is disabled the corresponding external connection string becomes required;
`values.schema.json` enforces that pairing so a typo surfaces at
`helm install` time rather than as a crash-looping pod.

Two details carry over from hard-won compose experience:

- **ClickHouse network allow-list.** `deploy/clickhouse/users.d/rovenue.xml`
  permits loopback, `172.16/12` and `10/8`. Most pod CIDRs fall inside `10/8`,
  but not all clusters do, and the failure mode is ClickHouse reporting
  `IP_ADDRESS_NOT_ALLOWED` to clients as *"password is incorrect"* — an
  operator will spend an hour on credentials that were never wrong. The chart
  templates this file from `clickhouse.allowedNetworks` and the values comment
  names the misleading error.
- **Postgres** uses `ghcr.io/broverse/rovenue-postgres`, not a stock image or a
  community subchart: pg_partman is required by the partition-maintenance
  worker.

### 5.5 Secrets

Secrets are rendered from values, with `existingSecret` supported for
external-secrets users.

`ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` are generated on first install when
not supplied, guarded by `lookup` against the already-installed Secret:

```
{{- $existing := (lookup "v1" "Secret" .Release.Namespace $name) }}
```

Without the `lookup`, `randAlphaNum`/`genPrivateKey` re-evaluate on every
`helm upgrade` and rotate the key. For `BETTER_AUTH_SECRET` that logs every
user out; for `ENCRYPTION_KEY` it makes every stored store-credential
permanently undecryptable, on an upgrade that reported success. This is the
single most damaging thing a Helm chart of this shape can get wrong, and it is
called out in the chart README as well as in the template.

`ENCRYPTION_KEY` is generated as hex to satisfy the API's validation.

## 6. Upgrade runbook

`docs/operations/upgrade.md` (new). `docs/operations/deployment.md` gains a
pointer to it.

Content:

- **Pin the version.** `latest` is for a first install; upgrades name a tag.
- **Read the release notes for breaking changes** before anything else.
- **Back up first**, per §7 — this is the rollback plan, see below.
- **Order of operations**, per install path: compose (`docker compose pull`,
  `docker compose run --rm migrate`, then `up -d`), Coolify (redeploy with the
  new tag), Helm (`helm upgrade` — the `pre-upgrade` Job handles ordering).
- **Migration routing.** `db:migrate` self-routes: a database with no migration
  history gets the fresh-install runner, anything with history goes to
  drizzle's migrator. **Never point `db:migrate:fresh` at a database that has
  been upgraded** — it dedupes by content hash while drizzle uses a `created_at`
  watermark, and four migration files were edited after they were applied.
- **ClickHouse migrations run from inside the compose network**, never from the
  host. Host traffic on Docker Desktop arrives from `192.168.65.1`, which the
  allow-list rejects and which surfaces to clients as *"password is
  incorrect"*. The socat bridge recipe is included for one-offs.
- **Recreating a Kafka-fed materialised view loses in-flight events.** Pause
  the corresponding `*_queue` consumer first, or backfill from Postgres
  afterwards. Any release whose notes mention a ClickHouse MV change requires
  this step.
- **`caddy-data` must persist.** Losing it re-issues every certificate and can
  hit Let's Encrypt rate limits. Named for compose volumes, Coolify persistent
  storage, and the chart's PVC.
- **Rollback.** Stated plainly: Postgres migrations are forward-only and there
  are no down-migrations. Rolling back the application image is safe only when
  the release notes say the schema is unchanged; otherwise rollback means
  restoring the backup taken at step 3. Pretending otherwise would be the most
  expensive sentence in this document.
- **Post-upgrade verification checklist**, ending in the asset-header check
  from §8.

## 7. Backup and restore

`docs/operations/backup-restore.md` plus `deploy/backup/backup.sh` and
`deploy/backup/restore.sh`.

### 7.1 What is backed up, and what is deliberately not

| Store | Backed up | Why |
|---|---|---|
| Postgres | Yes — `pg_dump -Fc` | Source of truth |
| ClickHouse | **Yes** — native `BACKUP DATABASE` | See below |
| MinIO / S3 | Yes — `mc mirror` | Paywall assets; not reconstructible |
| Redis | No | BullMQ state; regenerates |
| Redpanda | No | In-flight only |

**ClickHouse is not derived data.** It is tempting to treat it as a projection
that can be rebuilt from Postgres, and that is wrong: outbox rows are deleted
after dispatch, so the event history that produced the analytics tables no
longer exists in Postgres. A lost ClickHouse means permanently lost analytics
history. The script configures a `backups` disk via
`deploy/clickhouse/config.d/backup.xml` (new) so native `BACKUP`/`RESTORE` is
available rather than a per-table export that drifts from the schema.

**Redis is skipped on purpose, with a caveat that must be written down:**
BullMQ repeatable jobs re-arm themselves, but *delayed* jobs that were pending
at backup time are lost. Named, not glossed.

### 7.2 The two things that are easy to get wrong

- **`ENCRYPTION_KEY` is not in any of these backups.** It lives in the
  environment. A perfect Postgres restore with a *lost* key yields a database
  full of undecryptable store credentials — App Store, Play, and Stripe
  integrations all dead, unrecoverably; a restore with the *wrong* key is worse,
  because it succeeds and the damage only surfaces the next time a receipt is
  verified.

  A warning cannot fix this, because the person restoring at 3am is the person
  who skims warnings. So `backup.sh` writes the key's **SHA-256 fingerprint**
  (never the key) into the backup manifest, and `restore.sh` compares it against
  the fingerprint of the `ENCRYPTION_KEY` in the environment it is restoring
  into. A mismatch aborts, naming both fingerprints; a missing key aborts. The
  document still opens with the warning, but the guard is what actually holds.
- **`audit_logs` is a per-project SHA-256 hash chain.** Restoring some tables
  from one snapshot and others from another breaks it and there is no repair.
  Restore is whole-database only; the script does not offer a table selector.

### 7.3 Restore order

Postgres → MinIO → ClickHouse. Postgres first because it is the only store the
others are consistent *against*; ClickHouse last because the api may re-drive
outbox rows on start. `restore.sh` stops the api and worker services first and
refuses to run against a database with existing Rovenue tables unless
`--force` is given.

Verification is part of restore, not a separate step: row counts on the tables
named in the script, `db:verify:clickhouse`, and the asset-header check.

### 7.4 Scheduling

The scripts carry no policy — they take paths and an optional `mc` remote alias,
print what they did, and enforce only the two correctness guards in §7.2/§7.3
(key fingerprint, whole-database restore). Scheduling belongs to the operator; the
document gives a cron example and a compose `backup` profile, and states a
retention recommendation without implementing rotation.

## 8. Asset response-header verification

`scripts/verify-asset-headers.ts` (new), run via `tsx`.

The gap here is not documentation — `deploy/cloudflare/asset-headers/README.md`
and `deploy/caddy/conf.d/assets.caddy.example` already cover both hosts, and the
ETag question is already settled there (the store's own strong ETag is a
content hash and stays correct for multipart uploads, which a rewritten one
would not). The gap is that both are **applied by hand and verified by hand**,
and both fail silently: a Cloudflare Transform Rule scoped to the wrong
hostname matches nothing, and `assets.caddy.example` does nothing at all until
an operator copies it to `assets.caddy`.

The script takes an object path (argument or `ASSET_VERIFY_KEY`), issues a
`HEAD` against `ASSET_PUBLIC_BASE_URL`, and checks:

- `x-content-type-options: nosniff`
- `etag` present and **strong** (a `W/` prefix means conditional requests
  degrade)
- `cache-control` containing `immutable`
- `content-type` matching the object's extension
- a `PUT` to the same URL is refused — the read-only guarantee the Caddy block
  and the MinIO bucket policy both claim

Each failure is reported by name and the process exits 1. It is wired into the
deployment runbook, the upgrade runbook's post-upgrade checklist, and
`restore.sh`'s verification step.

`deploy/caddy/conf.d/assets.caddy.example` stops being an undiscoverable file:
`docs/operations/deployment.md` gains the copy-and-edit step in the self-host
path.

## 9. Sequencing

```
§2 dashboard runtime config
   └── §3 image publishing
          ├── §4 Coolify template
          ├── §5 Helm chart
          └── §6 upgrade runbook
§7 backup/restore   (independent)
§8 asset headers    (independent; §6 and §7 reference it)
```

§2 and §3 are strictly first. §4, §5, §7 and §8 are independent of each other.
§6 is written last because it must name the real commands for all three install
paths.

## 10. Global constraints

- No magic values. Image names, registry, default ports, tag patterns, retry
  counts, header names and expected values are named constants in one place per
  artifact — the shell scripts included. Structured data tables (the image
  matrix, the backup store list) are data, not magic values.
- No self-confirming tests. A test that asserts a hand-built response object
  carries `nosniff` proves nothing about the deployment; §8's verifier is
  exercised against a real MinIO container serving a real object. The Helm
  chart is validated with `helm template` plus `kubeconform` against real
  Kubernetes schemas, and a `helm lint` run — not by asserting the strings we
  just wrote.
- Existing deployments must keep working. Every change is additive: `VITE_*`
  build args stay, the compose bind mounts stay, `APPLE_ROOT_CERTS_DIR` keeps
  its override, and the root `docker-compose.yml` continues to build from
  source.
- Conventional commits; TypeScript strict; shell scripts run under `set -euo
  pipefail` and are `shellcheck`-clean.

## 11. Out of scope

- Publishing the Coolify template to Coolify's upstream catalogue (a PR to
  their repo, after this ships and is verified).
- A Kubernetes Operator, multi-region, or HA Postgres.
- Backup rotation/retention implementation.
- Live verification against Cloudflare R2 — no account is available, unchanged
  from the asset CDN spec.
