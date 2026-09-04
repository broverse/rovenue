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

In a container, `config.js` is **served, not written**.
`deploy/caddy/Caddyfile.dashboard` gains a handler that responds from Caddy's
own environment placeholders:

```
handle /config.js {
    header Content-Type "application/javascript"
    header Cache-Control "no-cache"
    respond `window.__ROVENUE_CONFIG__={"apiUrl":"{$ROVENUE_API_URL:}", ...};`
}
```

Nothing touches the filesystem, so the pod can run with
`readOnlyRootFilesystem: true`, and the runtime image stays a stock
`caddy:2-alpine` with no added packages.

The static build's own `config.js` is still in `/srv`, so the Caddyfile is
restructured to route every path through explicit `handle` blocks with the
`/config.js` block first — leaving `file_server` reachable for that path would
make which copy wins depend on Caddy's directive ordering, and the wrong answer
is a container serving the dev placeholder with every value empty.

The cost is that Caddy's `{$VAR}` substitution is textual — it does no JSON
escaping, so a value containing a quote would emit a broken bundle-config and
the dashboard would fail to boot with a syntax error and no explanation. That
is paid for by `deploy/dashboard/entrypoint.sh` (new), which runs **before**
`exec caddy run` and validates each value against a strict pattern — absolute
`http(s)` URL for `apiUrl` and `dashboardHost`, a closed enum for `hostMode`,
`true|false` for `allowRegistration` — refusing to start and naming the
offending variable on any violation. A bad value must fail at container start,
loudly, rather than at first paint, silently.

Unset variables use Caddy's `{$VAR:}` empty default and are normalised to
`undefined` by `runtime-config.ts` — `host-mode.ts` distinguishes unset from
empty, so the module treats `""` as absent rather than the caller having to.

`Cache-Control: no-cache` on `/config.js` is not optional: a cached copy
survives a redeploy that changed the API origin, and the failure is a dashboard
silently talking to the wrong host.

`VITE_*` build args stay in `apps/dashboard/Dockerfile` and in the root compose
file so the build-from-source path is unchanged and existing deployments keep
working. They become the fallback, not the mechanism.

### 2.3 Apple root certificates

`deploy/apple-certs/` contains only `.gitkeep`. In production
`APPLE_ROOT_CERTS_DIR` is required and the App Store JWS verifier fails closed
without it, so every packaging path would otherwise need an operator to fetch
two files by hand before the stack works — a guaranteed support burden on a
one-command install.

Apple's root CAs are public, freely redistributable trust anchors — roughly
1 KB each, and already present in every operating system's trust store. They
are **committed to `deploy/apple-certs/`** (`AppleRootCA-G3.cer`,
`AppleIncRootCertificate.cer`) and `COPY`d into the `rovenue-api` image at
`/etc/rovenue/apple-certs`.

Committed, not fetched during the build. Downloading a trust anchor at build
time — even with a pinned SHA-256, which does protect integrity — makes every
release depend on `apple.com` being reachable and on that URL never moving,
rules out offline and air-gapped builds, and hides the actual bytes from code
review. In git the certificates are auditable, diffable, and a rotation is a
reviewed commit rather than a checksum bump nobody can verify. A test asserts
each file parses as a certificate and is not expired, so a bad vendored file
fails CI rather than production JWS verification.

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

### 3.1 Supply chain

Operators pull these images and run them against their production databases.
That makes the release pipeline a security boundary, not a convenience.

- **Signing.** Every image and the chart are signed with `cosign` using keyless
  GitHub OIDC. The verification command (`cosign verify --certificate-identity
  … --certificate-oidc-issuer …`) goes in the deployment runbook, so an
  operator can check that what they pulled came from this workflow.
- **Provenance and SBOM.** `docker/build-push-action` with
  `provenance: mode=max` and `sbom: true`, so each image carries a SLSA
  provenance attestation and an SPDX SBOM. An operator hit by a future
  transitive CVE can answer "am I affected" from the image itself.
- **Vulnerability gate.** A `trivy image --severity HIGH,CRITICAL --exit-code
  1` step runs before the manifest is published. This is the mechanism that
  turns the standing `sharp >= 0.35.3` floor (CVE-2026-33327/33328/35590/35591,
  GIF/TIFF/VIPS loaders) from a remembered obligation into an enforced one —
  the reason it is a gate and not a report.
- **Pinned actions.** Every third-party GitHub Action is pinned by commit SHA,
  not by tag. A moving tag on an action that has registry push credentials is
  the shape of a real, repeated supply-chain compromise.
- **Tag generation** uses `docker/metadata-action` rather than hand-rolled
  shell, so the tag set is declarative and cannot drift between images.

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

**Healthchecks are mandatory in this file.** Coolify gates a deployment as
healthy on container healthchecks; a service without one is reported healthy
the moment it starts, so a stack that boots and then dies looks like a
successful install. Postgres, ClickHouse, Redpanda and Redis carry the
healthchecks the root compose file already defines; `api` gets one on
`/health`, and the static `dashboard`/`docs` servers get a root-path probe.

**Minimum host sizing is stated at the top of the template and the README.**
A one-click install that gets OOM-killed on a 2 GB VPS is the single most
common self-host failure, and the numbers here are knowable rather than
guessed: Redpanda is already pinned to `--smp=1 --memory=1G`, ClickHouse wants
~2 GB to be comfortable, Postgres and Redis ~1 GB together, and the seven Node
processes (api, dispatcher, four notification workers, migrate) ~1.5 GB.
The template documents **4 vCPU / 8 GB RAM / 40 GB disk** as the supported
minimum and names what to disable to fit smaller — which is a real answer, not
a disclaimer.

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

**`existingSecret` is the supported production path.** Auto-generation exists,
but only as a convenience for `helm install` from a laptop, and the chart says
so in `NOTES.txt` and the README.

The reason that ordering is not arbitrary:

`ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`, when not supplied, are generated
once and preserved across upgrades by reading back the already-installed
Secret:

```
{{- $existing := (lookup "v1" "Secret" .Release.Namespace $name) }}
```

Without the `lookup`, `randAlphaNum` re-evaluates on every `helm upgrade` and
rotates the key. For `BETTER_AUTH_SECRET` that logs every user out; for
`ENCRYPTION_KEY` it makes every stored store-credential permanently
undecryptable, on an upgrade that reported success.

**But `lookup` is not a general solution, and presenting it as one would be the
worst error in this chart.** `lookup` returns an empty map whenever there is no
live cluster read — `helm template`, `helm install --dry-run`, and critically
**Argo CD and Flux**, which render manifests with `helm template` and apply the
result. Under GitOps the auto-generation branch therefore fires on *every
sync*, producing exactly the catastrophe the `lookup` was added to prevent, on
a schedule.

So the chart takes both sides:

- `NOTES.txt` and the README state plainly that **GitOps users must set
  `existingSecret`**, with the failure spelled out rather than implied.
- When `existingSecret` is unset, the rendered Secret carries
  `helm.sh/resource-policy: keep` and an annotation recording that it was
  auto-generated, so a Secret that already exists is never deleted by an
  uninstall/reinstall cycle.
- The api's own startup check already rejects a malformed `ENCRYPTION_KEY`; a
  *rotated* one is indistinguishable from a correct one at boot, which is why
  the §7 backup manifest fingerprint is the backstop that actually catches it.

`ENCRYPTION_KEY` is generated as 64 hex characters to satisfy the API's
`^[0-9a-fA-F]{64}$` validation.

### 5.6 Chart hygiene

Table stakes for a chart other people install, listed because a chart that
omits them reads as unfinished regardless of how correct the rest is:

- **`resources`** requests and limits on every workload, with defaults derived
  from the sizing figures in §4 and each one overridable.
- **`securityContext`**: `runAsNonRoot: true`, dropped capabilities, and
  `readOnlyRootFilesystem: true`. This is free — `apps/api/Dockerfile:116`
  already ends in `USER rovenue`, and §2.2's Caddy-served `config.js` removed
  the last reason the dashboard needed a writable filesystem.
- **`PodDisruptionBudget`** for the api Deployment only. Not for the
  dispatcher: it is pinned to one replica by design, and a PDB there would
  block node drains forever.
- **No ServiceAccount permissions.** Nothing in Rovenue talks to the Kubernetes
  API, so the chart creates a ServiceAccount with no RoleBinding and disables
  token automounting. Stated explicitly so a reviewer does not have to infer it
  from absence.
- **`NOTES.txt`** printing the resolved URLs, the `existingSecret` warning
  above, and the next steps (OAuth callbacks, asset-header check).
- **`helm test` hook** hitting `/health` and the dashboard root, so
  `helm test` is a real post-install verification rather than a no-op.
- **README generated by `helm-docs`** from `values.yaml` comments, so the
  documented values cannot drift from the actual ones.

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

### 6.1 Expand/contract: the migration policy the ordering implies

Running migrations before the new pods roll out is necessary but not
sufficient, and the gap is easy to miss because it looks like the ordering
already solved it. During a rolling update **the old image is still serving,
against the already-migrated schema.** A release that drops or renames a column
breaks every old pod for the length of the rollout — on the Helm path, and on
compose with `API_REPLICAS > 1`.

The fix is a policy on the migrations, not a step in the runbook. Schema
changes are **expand/contract**, in three releases:

1. **Expand.** Add the new column/table, nullable or defaulted. Deploy. Old and
   new code both work.
2. **Migrate + dual-write.** New code writes both shapes and backfills. Deploy.
3. **Contract.** Only once no running version reads the old shape: drop it.

So `DROP COLUMN`, `NOT NULL` on an existing column, renames, and narrowing type
changes may never appear in the same release that introduces their replacement.
This lives in `docs/operations/upgrade.md` for operators and, more importantly,
in `CONTRIBUTING.md` and the migration-authoring notes for contributors —
the operator cannot fix a destructive migration, only the author can avoid
writing one.

The escape hatch is named too, because pretending it never happens is worse
than documenting it: a release that genuinely cannot be expand/contract is
marked **downtime-required** in its notes, and the runbook's procedure for
those is scale-to-zero, migrate, scale-up.
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

### 7.3 Backups are encrypted at rest

A Rovenue Postgres dump contains subscriber records, device identifiers, email
addresses and purchase history. This is a product with GDPR/KVKK export and
anonymise tooling built in; producing an unencrypted copy of the entire
subject database and dropping it on a disk would undo that at the first step.

`backup.sh` encrypts each artifact with `age` (recipient from
`BACKUP_AGE_RECIPIENT`), and refuses to run unencrypted unless
`--allow-plaintext` is passed explicitly — available, because a local dump
piped straight into a restore is a legitimate thing to do, but never the
default. `restore.sh` decrypts with the corresponding identity.

The age recipient is a *separate* key from `ENCRYPTION_KEY` and the document
says so: reusing the application's data key as the backup key means one
compromise loses both.

### 7.4 ClickHouse restore must not resume consuming

`BACKUP DATABASE rovenue` captures the Kafka Engine tables and their
materialised views along with the data tables. On restore those tables start
consuming from the Redpanda topic immediately, at whatever offset the consumer
group happens to be at — re-ingesting events that the restored data tables
already contain.

`restore.sh` therefore restores with the Kafka-facing objects **detached**,
lets the data land, and only then re-attaches them. This also interacts with
the known hazard that recreating a Kafka-fed materialised view loses in-flight
events: the script stops the `dispatcher` service for the duration, so the
outbox holds rather than the topic dropping.

### 7.5 Restore order

Postgres → MinIO → ClickHouse. Postgres first because it is the only store the
others are consistent *against*; ClickHouse last because the api may re-drive
outbox rows on start. `restore.sh` stops the api and worker services first and
refuses to run against a database with existing Rovenue tables unless
`--force` is given.

Verification is part of restore, not a separate step: row counts on the tables
named in the script, `db:verify:clickhouse`, and the asset-header check.

### 7.6 A backup nobody has restored is not a backup

The document prescribes a **quarterly test restore into a throwaway
environment**, and gives the procedure: restore, run `db:verify:clickhouse`,
compare the row counts the script prints against the source, and check the
audit chain verifies. This is a calendar obligation stated as one, not an
aspiration — the failure mode being avoided is discovering a broken backup
pipeline on the day it is needed.

### 7.7 Scheduling

The scripts carry no policy — they take paths and an optional `mc` remote alias,
print what they did, and enforce only the correctness guards named above: the
key fingerprint (§7.2), the encryption default (§7.3), the detach/attach
ordering (§7.4), and whole-database-only restore (§7.2). Scheduling belongs to
the operator; the document gives a cron example and a compose `backup` profile,
and states a retention recommendation without implementing rotation.

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

**§6.1 is the exception to that ordering** and should land first, before any of
it. The expand/contract policy constrains what contributors may write in a
migration, so every week it is unwritten is another migration authored without
it. It is a `CONTRIBUTING.md` change and does not depend on anything else here.

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
  just wrote. The backup scripts are exercised by an actual backup-then-restore
  against testcontainers Postgres and ClickHouse, comparing row counts; a
  mocked `pg_dump` would prove only that the script calls it.
- Every guarantee this spec claims has a mechanism, not a sentence. The
  `sharp` floor is a CI gate (§3.1), not a note; the key-rotation hazard is a
  fingerprint check (§7.2), not a warning; the build-time-config regression is
  an ESLint rule (§2.1), not a convention. Where a claim has only a document
  behind it, the document says so.
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
