# Self-hosting B — Coolify Template & Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two one-command installs for Rovenue — a Coolify service template and a Helm chart — both consuming the published `ghcr.io/broverse/rovenue-*` images rather than building from source.

**Architecture:** The Coolify template is a self-contained compose file with no `build:` and no repo bind-mounts, using Coolify's magic env variables to generate every secret but one, and dropping the bundled Caddy because Coolify's own proxy terminates TLS. The Helm chart ships the application workloads plus an optional in-cluster data plane behind `enabled` flags, migrations as a `post-install,pre-upgrade` hook Job, and Caddy as the default edge so funnel custom domains keep working.

**Tech Stack:** Docker Compose (Coolify dialect), Helm 3 (OCI), Kubernetes, Caddy 2, GitHub Actions, kubeconform.

**Spec:** `docs/superpowers/specs/2026-09-04-self-hosting-packaging-design.md` — §4 (Coolify), §5 (Helm), §3 (chart publishing).

**Plan set:** This is plan **B** of three. **A** (publishable images) is COMPLETE — commits `5d8d78fd..3622da85`. **C** (upgrade runbook, backup/restore, asset-header verifier) is independent of this one.

## What Plan A already established — do not re-derive

| Fact | Value |
|---|---|
| Images | `ghcr.io/broverse/rovenue-api`, `-dashboard`, `-docs`, `-postgres`, tags `vX.Y.Z` / `X.Y` / `latest` (floating tags are skipped on prerelease versions) |
| One image, seven roles | `rovenue-api` runs the api, `migrate`, `dispatcher` and the four notification workers — same image, different `command` |
| Dashboard runtime config | Container env `ROVENUE_API_URL` (absolute URL, **required** on release images), `ROVENUE_DASHBOARD_HOST` (**bare hostname**, optional `:port`, a scheme is rejected at boot), `ROVENUE_HOST_MODE` (`self`\|`cloud`), `ROVENUE_ALLOW_REGISTRATION` (`true`\|`false`) |
| Release-image guard | `rovenue-dashboard` is built with `ROVENUE_REQUIRE_RUNTIME_CONFIG=1`, so it refuses to start without `ROVENUE_API_URL` |
| Apple certs | Baked into `rovenue-api` at `/etc/rovenue/apple-certs`; `APPLE_ROOT_CERTS_DIR` defaults to it. **Neither packaging path needs to supply them.** |
| Probes | `GET /health` is liveness; `GET /health/ready` checks the database. Both on the public port. |

## Global Constraints

- **Never switch or create git branches.** Work on the current branch. Do not create worktrees. The user develops on `main` in parallel — stage only the paths a task owns, explicitly. Never `git add -A`, `git add .`, `git stash`, `git checkout .`, or `git restore`.
- **Throttle test runs.** `nice -n 19 npx vitest run --maxWorkers=2`; targeted files only.
- **No magic values.** Image names, the registry host, ports, resource defaults, and the ClickHouse allow-list CIDRs are named values in `values.yaml` or compose `x-` anchors — never repeated literals across templates.
- **No self-confirming tests.** `helm template` output is validated against real Kubernetes schemas with `kubeconform`, and a rendered manifest is asserted for the properties that matter (dispatcher replicas, secret preservation, mode guards) — not for strings we just wrote.
- **Additive only.** The root `docker-compose.yml` keeps building from source and must not change. `deploy/coolify/` and `deploy/helm/` are new trees.
- **The dispatcher is single-replica by correctness**, not by tuning (`docs/architecture/outbox-dispatcher.md`). A second dispatcher re-publishes outbox rows.
- **ClickHouse's misleading error:** when the network allow-list rejects a client, ClickHouse reports it to that client as *"password is incorrect"*. Any allow-list work must name this in a comment, or the next operator debugs credentials for an hour.
- Conventional commits. Shell scripts `set -euo pipefail` and shellcheck-clean. YAML validated before commit.
- **Do not push a git tag and do not trigger any workflow.** A tag starts a real publish.

## File Structure

| File | Responsibility |
|---|---|
| `deploy/coolify/docker-compose.yml` (create) | The whole Coolify template: images, magic env, healthchecks, inline config content. No `build:`, no repo bind-mounts, no Caddy. |
| `deploy/coolify/README.md` (create) | Host sizing, the one manual secret, catalogue-submission headers, post-install checklist. |
| `deploy/helm/rovenue/Chart.yaml` (create) | Chart metadata; version tracks the app version. |
| `deploy/helm/rovenue/values.yaml` (create) | Every knob, commented for helm-docs. |
| `deploy/helm/rovenue/values.schema.json` (create) | Enforces the external-URL pairing when a data-plane component is disabled. |
| `deploy/helm/rovenue/templates/_helpers.tpl` (create) | Name/label/image helpers used by every template. |
| `deploy/helm/rovenue/templates/secret.yaml` (create) | Generated-or-existing secret, `lookup`-preserved, `resource-policy: keep`. |
| `deploy/helm/rovenue/templates/configmap.yaml` (create) | Non-secret env shared by api and workers. |
| `deploy/helm/rovenue/templates/api.yaml`, `dispatcher.yaml`, `workers.yaml`, `dashboard.yaml`, `docs.yaml` (create) | Application workloads and Services. |
| `deploy/helm/rovenue/templates/migrate-job.yaml` (create) | `post-install,pre-upgrade` hook. |
| `deploy/helm/rovenue/templates/postgres.yaml`, `clickhouse.yaml`, `redpanda.yaml`, `redis.yaml`, `minio.yaml` (create) | Optional in-cluster data plane. |
| `deploy/helm/rovenue/templates/edge-caddy.yaml`, `edge-ingress.yaml` (create) | The two `edge.mode` values. |
| `deploy/helm/rovenue/templates/pdb.yaml`, `serviceaccount.yaml`, `NOTES.txt`, `tests/helm-test.yaml` (create) | Chart hygiene. |
| `deploy/helm/rovenue/README.md` (create, helm-docs) | Generated from `values.yaml` comments. |
| `.github/workflows/ci.yml` (modify) | `helm lint` + `helm template` + `kubeconform`. |
| `.github/workflows/release-images.yml` (modify) | `helm package` + `helm push` to `oci://ghcr.io/broverse/charts`. |

---

### Task 1: Coolify service template

**Files:**
- Create: `deploy/coolify/docker-compose.yml`
- Create: `deploy/coolify/README.md`

**Interfaces:**
- Consumes: Plan A's image names and the four `ROVENUE_*` variables.
- Produces: nothing later tasks depend on. This task is independent of Tasks 2–7 and may be done in any order relative to them.

- [ ] **Step 1: Read the source of truth before writing anything**

```bash
cd /Volumes/Development/rovenue
sed -n '1,200p' docker-compose.yml
```

You are transcribing this stack into a form Coolify can run. Note as you read: which services exist, which `command` each worker uses, which env vars each needs, and every `volumes:` entry that bind-mounts a repo path — those are the ones that cannot survive into a template.

- [ ] **Step 2: Write the template**

Create `deploy/coolify/docker-compose.yml`. The header comments are what Coolify's catalogue reads, so they are content, not decoration:

```yaml
# documentation: https://docs.rovenue.app/self-hosting
# slogan: Open-source subscription, paywall and analytics infrastructure for mobile and web apps.
# tags: subscriptions,revenuecat,adapty,paywall,analytics,iap
# logo: svgs/rovenue.svg
# port: 3000
#
# =============================================================
# Rovenue — Coolify one-click template
# =============================================================
#
# MINIMUM HOST: 4 vCPU / 8 GB RAM / 40 GB disk.
# Not a disclaimer — the figures are knowable. Redpanda is pinned to
# --memory=1G, ClickHouse wants ~2 GB to be comfortable, Postgres and
# Redis ~1 GB together, and the seven Node processes ~1.5 GB. A 2 GB
# VPS gets OOM-killed mid-install, which is the single most common
# self-host failure.
#
# ONE SECRET YOU MUST SET BY HAND: ENCRYPTION_KEY.
# It is validated as 64 hex characters (^[0-9a-fA-F]{64}$) and none of
# Coolify's generators emit hex. Generate it with:
#
#     openssl rand -hex 32
#
# Losing this value makes every stored App Store / Play / Stripe
# credential permanently undecryptable. Back it up separately from the
# database — see docs/operations/backup-restore.md.
#
# WHAT THIS TEMPLATE DOES NOT DO: funnel custom domains.
# That feature is the bundled Caddy's on-demand TLS gated by the api's
# /internal/domains/check ask-endpoint. Coolify's proxy terminates TLS
# itself and has no equivalent, so Caddy is deliberately absent here.
# Operators who need custom domains use the root docker-compose.yml.
```

Then the services. Use YAML anchors so the shared api-image configuration is written once:

```yaml
x-rovenue-image: &rovenue-image ghcr.io/broverse/rovenue-api:latest

x-api-env: &api-env
  NODE_ENV: production
  DATABASE_URL: postgresql://rovenue:${SERVICE_PASSWORD_POSTGRES}@db:5432/rovenue
  REDIS_URL: redis://redis:6379
  CLICKHOUSE_URL: http://clickhouse:8123
  KAFKA_BROKERS: redpanda:9092
  ENCRYPTION_KEY: ${ENCRYPTION_KEY}
  BETTER_AUTH_SECRET: ${SERVICE_BASE64_64_BETTERAUTH}
  BETTER_AUTH_URL: ${SERVICE_FQDN_API_3000}
  DASHBOARD_URL: ${SERVICE_FQDN_DASHBOARD_80}
  HOST_MODE: self
```

Rules that shape every service block:

1. **No `build:`.** Every service uses a published image.
2. **No repo bind-mounts.** The one config file that must travel is ClickHouse's `users.d/rovenue.xml`. Supply it as inline `content:` on a bind volume — Coolify materialises those on the host:
   ```yaml
   volumes:
     - type: bind
       source: ./clickhouse-users.xml
       target: /etc/clickhouse-server/users.d/rovenue.xml
       content: |
         <?xml version="1.0"?>
         ...
   ```
   Copy the real content from `deploy/clickhouse/users.d/rovenue.xml`, keeping its comments — especially the one explaining that `readonly` must be a profile setting, not a per-user field. **If Coolify's parser turns out not to support inline `content:`, stop and report it**; the fallback (baking a `rovenue-clickhouse` image) is a scope change I need to rule on, not something to decide mid-task.
3. **ClickHouse password derivation.** The server wants `CLICKHOUSE_PASSWORD_SHA256` while clients want `CLICKHOUSE_PASSWORD`. Derive one from the other inside the service's own command so they cannot drift:
   ```yaml
   command:
     - sh
     - -c
     - >
       export CLICKHOUSE_PASSWORD_SHA256=$(printf %s "$$CLICKHOUSE_PASSWORD" | sha256sum | cut -d' ' -f1) &&
       exec /entrypoint.sh
   ```
   Note the `$$` — compose expands single `$`, and this must reach the shell intact.
4. **The migrate service uses the WRITE user.** `CLICKHOUSE_USER: rovenue`, not `rovenue_reader`. The root compose file carries a long comment about why: `rovenue_reader` runs under a `readonly=2` profile and every ClickHouse migration died with "Cannot execute query in readonly mode", leaving a migrated Postgres and an empty ClickHouse. Carry that comment across.
5. **`OUTBOX_DISPATCHER_ENABLED: "false"` on `api`**, `"true"` on `dispatcher` only.
6. **Healthchecks on every service.** Coolify decides a deployment is healthy from these; a service without one reports healthy the moment it starts, so a stack that boots and then dies looks like a successful install. Use `GET /health` for the api, the root path for `dashboard` and `docs`, and copy the existing Postgres/Redis/ClickHouse/Redpanda healthchecks from the root compose file verbatim — including the ClickHouse one's `127.0.0.1` (alpine's wget resolves `localhost` to IPv6 first and CH binds IPv4 only) and its `start_period: 60s`.
7. **The dashboard gets the runtime config**, and `ROVENUE_DASHBOARD_HOST` is a **bare hostname**:
   ```yaml
   environment:
     ROVENUE_API_URL: ${SERVICE_FQDN_API_3000}
     ROVENUE_HOST_MODE: self
   ```
   Do NOT set `ROVENUE_DASHBOARD_HOST` to an FQDN variable that renders with a scheme — the image rejects that at boot. Leave it unset unless you can render a bare host.
8. **Omit the observability profile.** Coolify has no profile concept; eight extra containers would make the template look heavier than the product.

- [ ] **Step 3: Validate the YAML and prove the anchors resolve**

```bash
cd /Volumes/Development/rovenue
npx --yes js-yaml deploy/coolify/docker-compose.yml > /dev/null && echo "yaml ok"
docker compose -f deploy/coolify/docker-compose.yml config >/dev/null 2>&1 \
  && echo "compose ok" \
  || echo "compose validation unavailable (docker down) — record this"
```

Docker Desktop may be down on this machine. If `docker compose config` cannot run, say so in your report rather than claiming validation passed; the `js-yaml` parse still proves the file is well-formed YAML and that the anchors resolve.

- [ ] **Step 4: Cross-check the service list against the root compose file**

Every service the root file runs outside the `observability` profile — except `caddy` — must appear here, and no service may appear that the root file does not have. Print both lists and compare them explicitly:

```bash
cd /Volumes/Development/rovenue
echo "--- root (non-observability) ---"
npx --yes js-yaml docker-compose.yml | npx --yes -p node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);for(const [k,v] of Object.entries(o.services))if(!(v.profiles||[]).includes("observability"))console.log(k)})'
echo "--- coolify ---"
npx --yes js-yaml deploy/coolify/docker-compose.yml | npx --yes -p node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(Object.keys(JSON.parse(s).services).join("\n"))})'
```

Expected difference: `caddy` present in the root list and absent here, `redpanda-console` absent here. Any other difference is a mistake — a missing worker means a queue nobody drains.

- [ ] **Step 5: Write the README**

Create `deploy/coolify/README.md` covering, in this order: the minimum host spec and what to disable to fit smaller; the `openssl rand -hex 32` step and why `ENCRYPTION_KEY` cannot be generated by Coolify; that funnel custom domains do not work on this path and which path does; the post-install checklist (GitHub and Google OAuth callback URLs, DNS, then the asset-header check from Plan C); and how to submit the template to Coolify's catalogue, noting that the header comments at the top of the compose file are what the catalogue reads.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/coolify/docker-compose.yml deploy/coolify/README.md
git commit -m "feat(coolify): a one-click service template

Self-contained: published images, no build:, no repo bind-mounts.
Coolify's magic variables generate every secret except ENCRYPTION_KEY,
which is validated as 64 hex characters and which none of Coolify's
generators can produce — so it is the one value an operator pastes.

Caddy is deliberately absent: Coolify's proxy terminates TLS, and two
edges would compete for the same hostnames. The cost is that funnel
custom domains do not work on this path, which the template says.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Chart scaffold, values, and secrets

**Files:**
- Create: `deploy/helm/rovenue/Chart.yaml`, `values.yaml`, `values.schema.json`, `.helmignore`
- Create: `deploy/helm/rovenue/templates/_helpers.tpl`, `secret.yaml`, `configmap.yaml`, `serviceaccount.yaml`

**Interfaces:**
- Consumes: Plan A's image names and tag scheme.
- Produces, used by every later Helm task:
  - `rovenue.fullname`, `rovenue.labels`, `rovenue.selectorLabels`, `rovenue.serviceAccountName`
  - `rovenue.image` — takes a dict `(dict "repo" "rovenue-api" "ctx" $)` and renders `<registry>/<namespace>/<repo>:<tag>`
  - `rovenue.secretName` — the generated-or-existing secret name
  - Values keys: `image.registry`, `image.namespace`, `image.tag`, `image.pullPolicy`, `existingSecret`, `postgres.enabled`, `clickhouse.enabled`, `redpanda.enabled`, `redis.enabled`, `minio.enabled`, `external.databaseUrl`, `external.clickhouseUrl`, `external.kafkaBrokers`, `external.redisUrl`, `edge.mode`, `customDomains.enabled`, `hosts.api`, `hosts.dashboard`, `hosts.docs`

- [ ] **Step 1: Scaffold and immediately delete the noise**

```bash
cd /Volumes/Development/rovenue
mkdir -p deploy/helm
helm create deploy/helm/rovenue
rm -rf deploy/helm/rovenue/templates/* deploy/helm/rovenue/charts
rm -f deploy/helm/rovenue/values.yaml
ls -la deploy/helm/rovenue
```

`helm create` gives a working skeleton, but its default templates encode a single-Deployment app and would fight this chart's shape. Keep only `Chart.yaml` and `.helmignore`; write the rest.

- [ ] **Step 2: Write `Chart.yaml`**

```yaml
apiVersion: v2
name: rovenue
description: Open-source, self-hosted subscription, paywall and analytics infrastructure.
type: application
# Chart version and app version move together. A chart that can name an
# image tag which was never built is a support ticket waiting to happen,
# so the release workflow sets both from the same git tag.
version: 0.0.0-dev
appVersion: "0.0.0-dev"
home: https://rovenue.app
sources:
  - https://github.com/broverse/rovenue
maintainers:
  - name: broverse
kubeVersion: ">=1.27.0-0"
```

- [ ] **Step 3: Write `values.yaml`**

Comment every key — `helm-docs` generates the README from these comments in Task 6, so a key with no comment becomes an undocumented knob. Structure:

```yaml
# -- Override the chart name in generated resource names.
nameOverride: ""
fullnameOverride: ""

# -- self | cloud. Mirrors the API's HOST_MODE and reaches the dashboard
# image as ROVENUE_HOST_MODE.
hostMode: self
# -- true | false. Blank leaves the dashboard's own default (open on
# cloud, closed on self-host).
allowRegistration: ""

# -- Container image coordinates. Published by
# .github/workflows/release-images.yml on a vX.Y.Z tag.
image:
  registry: ghcr.io
  namespace: broverse
  # -- Image tag. Defaults to the chart's appVersion. Pin it: `latest`
  # is for a first install, upgrades name a version.
  tag: ""
  pullPolicy: IfNotPresent

# -- Public hostnames. Required — the dashboard image refuses to start
# without an API origin, and BETTER_AUTH_URL must match the real host.
hosts:
  api: ""
  dashboard: ""
  docs: ""

# -- Supply an existing Secret instead of letting the chart generate one.
# THIS IS THE SUPPORTED PRODUCTION PATH. See the secret template's
# comment and the chart README: auto-generation relies on `lookup`, which
# returns nothing under `helm template` — the mode Argo CD and Flux use —
# so a GitOps install regenerates ENCRYPTION_KEY on every sync and makes
# every stored store credential permanently undecryptable.
existingSecret: ""

secrets:
  # -- 64 hex characters. Generated once if blank and not using
  # existingSecret. NEVER changes after first install.
  encryptionKey: ""
  betterAuthSecret: ""
  unsubSigningKey: ""
  githubClientId: ""
  githubClientSecret: ""
  googleClientId: ""
  googleClientSecret: ""

api:
  replicaCount: 2
  resources:
    requests: { cpu: 200m, memory: 512Mi }
    limits: { memory: 1Gi }

# -- The outbox -> Kafka publisher. Its replica count is NOT a value:
# delivery is at-least-once and a second dispatcher merely re-publishes.
# See docs/architecture/outbox-dispatcher.md.
dispatcher:
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 512Mi }

edge:
  # -- caddy | ingress.
  # `caddy` (default) runs Caddy as a single-replica Deployment behind a
  # LoadBalancer, preserving on-demand TLS for funnel custom domains.
  # `ingress` delegates TLS to cert-manager and DISABLES custom domains —
  # cert-manager issues from declared hosts and has no equivalent of an
  # issuance-time ask-endpoint.
  mode: caddy
  tlsEmail: ""
  ingress:
    className: ""
    annotations: {}
    tlsSecretName: ""

# -- Funnel custom domains. Requires edge.mode=caddy; the chart refuses
# to render if this is true under edge.mode=ingress rather than
# installing cleanly and leaving the feature quietly broken.
customDomains:
  enabled: true

postgres:
  enabled: true
  # -- Must be the pg_partman image; the partition-maintenance worker
  # requires that extension. A stock postgres image will not do.
  image: { repo: rovenue-postgres }
  persistence: { size: 20Gi, storageClass: "" }
  resources:
    requests: { cpu: 250m, memory: 1Gi }

clickhouse:
  enabled: true
  image: clickhouse/clickhouse-server:24.3-alpine
  # -- CIDRs allowed to authenticate. Must cover your pod CIDR.
  # WARNING: when ClickHouse rejects a client by network allow-list it
  # reports the failure to that client as "password is incorrect". If
  # credentials look wrong and are not, check this list first.
  allowedNetworks:
    - 10.0.0.0/8
    - 172.16.0.0/12
  persistence: { size: 50Gi, storageClass: "" }

redpanda:
  enabled: true
  image: redpandadata/redpanda:v24.2.13
  persistence: { size: 20Gi, storageClass: "" }

redis:
  enabled: true
  image: redis:7-alpine

minio:
  enabled: true
  image: minio/minio:RELEASE.2025-04-08T15-41-24Z
  persistence: { size: 50Gi, storageClass: "" }

# -- Connection strings for data-plane components you disabled above.
# values.schema.json enforces the pairing: disabling a component without
# supplying its URL fails at `helm install`, not as a crash-looping pod.
external:
  databaseUrl: ""
  clickhouseUrl: ""
  clickhouseUser: ""
  clickhousePassword: ""
  kafkaBrokers: ""
  redisUrl: ""

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 1000
containerSecurityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }
```

- [ ] **Step 4: Write `values.schema.json`**

Express the pairing so a typo fails at install time. One `if/then` per component:

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "hosts": {
      "type": "object",
      "required": ["api", "dashboard"],
      "properties": {
        "api": { "type": "string", "minLength": 1 },
        "dashboard": { "type": "string", "minLength": 1 },
        "docs": { "type": "string" }
      }
    },
    "edge": {
      "type": "object",
      "properties": { "mode": { "enum": ["caddy", "ingress"] } }
    }
  },
  "allOf": [
    {
      "if": { "properties": { "postgres": { "properties": { "enabled": { "const": false } } } } },
      "then": {
        "properties": {
          "external": {
            "required": ["databaseUrl"],
            "properties": { "databaseUrl": { "type": "string", "minLength": 1 } }
          }
        }
      }
    }
  ]
}
```

Repeat the `allOf` entry for `clickhouse`→`clickhouseUrl`, `redpanda`→`kafkaBrokers`, and `redis`→`redisUrl`.

- [ ] **Step 5: Write `_helpers.tpl`**

```
{{- define "rovenue.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rovenue.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "rovenue.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "rovenue.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "rovenue.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "rovenue.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rovenue.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Renders a full image reference. Usage:
     {{ include "rovenue.image" (dict "repo" "rovenue-api" "ctx" $) }} */}}
{{- define "rovenue.image" -}}
{{- $ctx := .ctx -}}
{{- $tag := default $ctx.Chart.AppVersion $ctx.Values.image.tag -}}
{{- printf "%s/%s/%s:%s" $ctx.Values.image.registry $ctx.Values.image.namespace .repo $tag -}}
{{- end -}}

{{- define "rovenue.secretName" -}}
{{- default (printf "%s-secrets" (include "rovenue.fullname" .)) .Values.existingSecret -}}
{{- end -}}

{{- define "rovenue.serviceAccountName" -}}
{{- include "rovenue.fullname" . -}}
{{- end -}}
```

- [ ] **Step 6: Write `secret.yaml` — the most consequential template in the chart**

```
{{- if not .Values.existingSecret }}
{{/*
  Secrets are generated ONCE and preserved across upgrades by reading the
  already-installed Secret back with `lookup`. Without that, randAlphaNum
  re-evaluates on every `helm upgrade` and rotates the key: for
  BETTER_AUTH_SECRET that logs every user out; for ENCRYPTION_KEY it makes
  every stored App Store / Play / Stripe credential permanently
  undecryptable, on an upgrade that reported success.

  BUT `lookup` IS NOT A GENERAL SOLUTION, and treating it as one is the
  worst thing a chart of this shape can get wrong. It returns an empty map
  whenever there is no live cluster read — `helm template`, `--dry-run`,
  and critically Argo CD and Flux, which render manifests with
  `helm template` and apply the result. Under GitOps this branch fires on
  EVERY SYNC and produces exactly the catastrophe it was added to prevent,
  on a schedule.

  So: GitOps users MUST set `existingSecret`. NOTES.txt and the chart
  README say so, and resource-policy: keep below stops an
  uninstall/reinstall cycle from deleting a secret that still guards live
  data.
*/}}
{{- $name := printf "%s-secrets" (include "rovenue.fullname" .) -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace $name) -}}
{{- $encKey := .Values.secrets.encryptionKey -}}
{{- if and (not $encKey) $existing -}}
{{- $encKey = index $existing.data "ENCRYPTION_KEY" | b64dec -}}
{{- end -}}
{{- if not $encKey -}}
{{/* 32 random bytes rendered as 64 hex characters, matching the API's
     ^[0-9a-fA-F]{64}$ validation in apps/api/src/lib/env.ts. */}}
{{- $encKey = randBytes 32 | b64dec | toString | sha256sum -}}
{{- end -}}
apiVersion: v1
kind: Secret
metadata:
  name: {{ $name }}
  labels: {{- include "rovenue.labels" . | nindent 4 }}
  annotations:
    helm.sh/resource-policy: keep
    rovenue.app/generated: {{ ternary "false" "true" (ne .Values.secrets.encryptionKey "") | quote }}
type: Opaque
stringData:
  ENCRYPTION_KEY: {{ $encKey | quote }}
  ...
{{- end }}
```

Apply the same generate-or-preserve pattern to `BETTER_AUTH_SECRET`, `UNSUB_SIGNING_KEY`, `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD` and `CLICKHOUSE_READER_PASSWORD` — every one of those, rotated on an upgrade, locks the application out of its own data plane. OAuth client ids and secrets are operator-supplied only, never generated.

Add matching keys to `values.yaml`'s `secrets:` block so an operator can supply any of them explicitly.

- [ ] **Step 7: Write `configmap.yaml` and `serviceaccount.yaml`**

The ConfigMap carries the non-secret env every api-image pod shares: `NODE_ENV`, `PORT`, `INTERNAL_PORT`, `CLICKHOUSE_URL`, `KAFKA_BROKERS`, `DATABASE_URL` (in-cluster or `external.databaseUrl`), `REDIS_URL`, `DASHBOARD_URL`, `BETTER_AUTH_URL`, `CANONICAL_HOSTS`, `HOST_MODE`. `APPLE_ROOT_CERTS_DIR` is deliberately absent — Plan A baked the certs in and defaulted the variable, so setting it here would only create a way to get it wrong.

The ServiceAccount has no RoleBinding and disables token automounting, with a comment saying so explicitly: nothing in Rovenue talks to the Kubernetes API, and a reviewer should not have to infer that from absence.

- [ ] **Step 8: Verify it renders and validates**

```bash
cd /Volumes/Development/rovenue
helm lint deploy/helm/rovenue --set hosts.api=api.example.com --set hosts.dashboard=app.example.com
helm template t deploy/helm/rovenue --set hosts.api=api.example.com --set hosts.dashboard=app.example.com | head -60
```

Expected: lint passes; the Secret and ConfigMap render.

- [ ] **Step 9: Prove the schema actually rejects a bad combination**

```bash
cd /Volumes/Development/rovenue
helm template t deploy/helm/rovenue \
  --set hosts.api=api.example.com --set hosts.dashboard=app.example.com \
  --set postgres.enabled=false
```

Expected: FAILS, naming `external.databaseUrl`. Then confirm it passes when the URL is supplied:

```bash
helm template t deploy/helm/rovenue \
  --set hosts.api=api.example.com --set hosts.dashboard=app.example.com \
  --set postgres.enabled=false \
  --set external.databaseUrl=postgresql://u:p@db.example.com:5432/rovenue >/dev/null && echo "pairing enforced"
```

- [ ] **Step 10: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/helm/rovenue
git commit -m "feat(helm): chart scaffold, values, and generate-or-preserve secrets

ENCRYPTION_KEY and BETTER_AUTH_SECRET are generated once and preserved
across upgrades via lookup. lookup returns nothing under helm template —
which is how Argo CD and Flux render — so existingSecret is documented as
the production path and the generated Secret carries resource-policy:
keep.

values.schema.json enforces that disabling a data-plane component
supplies its external URL, so a typo fails at install rather than as a
crash-looping pod.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Application workloads and the migration hook

**Files:**
- Create: `deploy/helm/rovenue/templates/api.yaml`, `dispatcher.yaml`, `workers.yaml`, `dashboard.yaml`, `docs.yaml`, `migrate-job.yaml`

**Interfaces:**
- Consumes: Task 2's helpers, `rovenue.secretName`, and the ConfigMap name `<fullname>-config`.
- Produces: Services named `<fullname>-api` (ports 3000 public, 3001 internal), `<fullname>-dashboard` (80), `<fullname>-docs` (80) — Task 5's edge templates route to these names.

- [ ] **Step 1: Write `api.yaml`**

Write this in full — it is the shape every other workload in Tasks 3 and 4 copies, so getting it exact here is what keeps the rest short:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "rovenue.fullname" . }}-api
  labels: {{- include "rovenue.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.api.replicaCount }}
  selector:
    matchLabels:
      {{- include "rovenue.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: api
  template:
    metadata:
      labels:
        {{- include "rovenue.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: api
    spec:
      serviceAccountName: {{ include "rovenue.serviceAccountName" . }}
      securityContext: {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        - name: api
          image: {{ include "rovenue.image" (dict "repo" "rovenue-api" "ctx" $) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          securityContext: {{- toYaml .Values.containerSecurityContext | nindent 12 }}
          ports:
            - name: http
              containerPort: 3000
            # The Caddy on-demand-TLS ask endpoint. Reachable only inside
            # the namespace — the edge Service never routes to it.
            - name: internal
              containerPort: 3001
          envFrom:
            - configMapRef:
                name: {{ include "rovenue.fullname" . }}-config
            - secretRef:
                name: {{ include "rovenue.secretName" . }}
          env:
            # Set inline, not in the ConfigMap, so it sits next to this
            # comment: the API must NEVER dispatch. The dedicated
            # dispatcher Deployment is the only outbox publisher, which is
            # what lets this Deployment scale to N replicas without
            # double-publishing. See docs/architecture/outbox-dispatcher.md.
            - name: OUTBOX_DISPATCHER_ENABLED
              value: "false"
          livenessProbe:
            httpGet: { path: /health, port: http }
            initialDelaySeconds: 10
            periodSeconds: 10
          # /health/ready checks the database, so a pod whose DB is
          # unreachable stops taking traffic instead of serving errors.
          readinessProbe:
            httpGet: { path: /health/ready, port: http }
            initialDelaySeconds: 5
            periodSeconds: 5
          resources: {{- toYaml .Values.api.resources | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "rovenue.fullname" . }}-api
  labels: {{- include "rovenue.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "rovenue.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: api
  ports:
    - name: http
      port: 3000
      targetPort: http
    - name: internal
      port: 3001
      targetPort: internal
```

Add `rovenue.serviceAccountName` to `_helpers.tpl` if Task 2 did not already define it.

- [ ] **Step 2: Write `dispatcher.yaml`**

Identical image, `command: ["node_modules/.bin/tsx", "src/workers/outbox-dispatcher-process.ts"]`, `OUTBOX_DISPATCHER_ENABLED: "true"`, no Service, no ports.

```yaml
  # NOT .Values.dispatcher.replicaCount, and deliberately so. Outbox
  # delivery is at-least-once; a second dispatcher re-publishes every row
  # it wins the race for. The duplicates are collapsed downstream by the
  # query-time idempotent ClickHouse views from migration 0012, so the
  # symptom is wasted load rather than wrong numbers — but exposing this
  # as a value invites an operator to "scale it for availability".
  # See docs/architecture/outbox-dispatcher.md.
  replicas: 1
```

- [ ] **Step 3: Write `workers.yaml`**

Four Deployments from one `range` over a list defined at the top of the template, so the shared pod spec is written once:

```
{{- $workers := list
  (dict "name" "notifier"        "script" "src/workers/notifier-process.ts")
  (dict "name" "digest-scheduler" "script" "src/workers/digest-scheduler-process.ts")
  (dict "name" "send-email"      "script" "src/workers/send-email-process.ts")
  (dict "name" "send-push"       "script" "src/workers/send-push-process.ts")
-}}
{{- range $w := $workers }}
---
...
{{- end }}
```

The table is data, not magic values. Verify each script path against the root `docker-compose.yml`'s worker services before writing them.

- [ ] **Step 4: Write `dashboard.yaml` and `docs.yaml`**

`docs` is a plain static server. `dashboard` needs the four runtime variables, and two of them have shapes that will bite:

```yaml
        env:
          # Absolute URL. The release image was built with
          # ROVENUE_REQUIRE_RUNTIME_CONFIG=1 and refuses to start without
          # this, rather than silently booting pointed at localhost.
          - name: ROVENUE_API_URL
            value: {{ printf "https://%s" .Values.hosts.api | quote }}
          # BARE HOSTNAME, optionally with :port — NOT a URL. The
          # entrypoint rejects a scheme at container start, because the
          # consumer (lib/custom-host.ts) strips a trailing :port but not
          # a scheme, so "https://app.example.com" would normalise to the
          # string "https" and never match.
          - name: ROVENUE_DASHBOARD_HOST
            value: {{ .Values.hosts.dashboard | quote }}
          - name: ROVENUE_HOST_MODE
            value: {{ .Values.hostMode | default "self" | quote }}
```

Note `readOnlyRootFilesystem: true` is safe for this pod — Plan A made Caddy serve `/config.js` from environment placeholders rather than writing a file.

- [ ] **Step 5: Write `migrate-job.yaml`**

```yaml
  annotations:
    # post-install, NOT pre-install. Helm runs pre-install hooks before any
    # non-hook resource, so with the chart's own Postgres StatefulSet
    # enabled a pre-install migrate Job would wait for a database Helm has
    # not created yet, and the first install would deadlock.
    #
    # post-install lets the data plane come up with the chart; api pods
    # crash-loop for the seconds the migration takes and recover on their
    # own. On upgrade the ordering matters in the other direction, so
    # pre-upgrade runs migrations before the new api pods roll out and no
    # pod ever serves an un-migrated schema.
    "helm.sh/hook": post-install,pre-upgrade
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": before-hook-creation
```

The container runs the same two commands as the compose `migrate` service:

```yaml
          command:
            - sh
            - -c
            - >
              node_modules/.bin/tsx node_modules/@rovenue/db/src/migrate.ts &&
              node_modules/.bin/tsx node_modules/@rovenue/db/src/clickhouse-migrate.ts
          env:
            # The SCHEMA OWNER, not the reader. rovenue_reader runs under a
            # readonly=2 profile and every ClickHouse migration dies with
            # "Cannot execute query in readonly mode" — leaving a migrated
            # Postgres and an empty ClickHouse.
            - name: CLICKHOUSE_USER
              value: rovenue
```

`backoffLimit: 3`, `restartPolicy: Never`.

- [ ] **Step 6: Render and check the properties that matter**

Not "does it contain the string I wrote" — check the invariants:

```bash
cd /Volumes/Development/rovenue
BASE="helm template t deploy/helm/rovenue --set hosts.api=api.example.com --set hosts.dashboard=app.example.com"
$BASE > /tmp/rendered.yaml
echo "--- dispatcher replicas (must be 1, and must not follow --set) ---"
grep -A3 "name: t-rovenue-dispatcher" /tmp/rendered.yaml | grep -m1 replicas
helm template t deploy/helm/rovenue --set hosts.api=a.example.com --set hosts.dashboard=b.example.com \
  --set dispatcher.replicaCount=5 | grep -A3 "name: t-rovenue-dispatcher" | grep -m1 replicas
echo "--- migrate hook annotations ---"
grep -A4 '"helm.sh/hook"' /tmp/rendered.yaml | head -8
echo "--- dashboard host must have NO scheme ---"
grep -A1 "ROVENUE_DASHBOARD_HOST" /tmp/rendered.yaml
```

Expected: dispatcher `replicas: 1` in BOTH renders (the `--set` must have no effect); the hook is `post-install,pre-upgrade`; `ROVENUE_DASHBOARD_HOST` renders as `app.example.com` with no `https://`.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/helm/rovenue/templates
git commit -m "feat(helm): application workloads and the migration hook

The migrate Job is post-install,pre-upgrade rather than pre-install:
Helm runs pre-install hooks before any non-hook resource, so with the
chart's own Postgres enabled a pre-install Job would wait for a database
Helm has not created yet and the first install would deadlock.

The dispatcher's replica count is a literal 1 with a comment, not a
value — outbox delivery is at-least-once and a second dispatcher
re-publishes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: In-cluster data plane

**Files:**
- Create: `deploy/helm/rovenue/templates/postgres.yaml`, `clickhouse.yaml`, `redpanda.yaml`, `redis.yaml`, `minio.yaml`

**Interfaces:**
- Consumes: Task 2's helpers and values.
- Produces: in-cluster Service names `<fullname>-postgres:5432`, `-clickhouse:8123`, `-redpanda:9092`, `-redis:6379`, `-minio:9000`, which Task 2's ConfigMap already references when the corresponding `enabled` is true.

- [ ] **Step 1: Write `postgres.yaml`**

Write this one in full — it is the StatefulSet shape ClickHouse, Redpanda and MinIO all copy, differing only in image, ports, volume path and probe:

```yaml
{{- if .Values.postgres.enabled }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "rovenue.fullname" . }}-postgres
  labels: {{- include "rovenue.labels" . | nindent 4 }}
spec:
  serviceName: {{ include "rovenue.fullname" . }}-postgres
  replicas: 1
  selector:
    matchLabels:
      {{- include "rovenue.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: postgres
  template:
    metadata:
      labels:
        {{- include "rovenue.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: postgres
    spec:
      containers:
        - name: postgres
          # ghcr.io/broverse/rovenue-postgres — NOT a stock postgres image
          # and NOT a community subchart. pg_partman is required by the
          # partition-maintenance worker
          # (apps/api/src/workers/partition-maintenance.ts); without it the
          # partitioned tables silently stop being maintained.
          image: {{ include "rovenue.image" (dict "repo" .Values.postgres.image.repo "ctx" $) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: postgres
              containerPort: 5432
          env:
            - name: POSTGRES_USER
              value: rovenue
            - name: POSTGRES_DB
              value: rovenue
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "rovenue.secretName" . }}
                  key: POSTGRES_PASSWORD
            # The official image refuses to initialise into a non-empty
            # directory, and a PVC arrives with lost+found on many storage
            # classes. Putting the cluster in a subdirectory avoids it.
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "rovenue"]
            initialDelaySeconds: 5
            periodSeconds: 5
          resources: {{- toYaml .Values.postgres.resources | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        {{- with .Values.postgres.persistence.storageClass }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ .Values.postgres.persistence.size }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "rovenue.fullname" . }}-postgres
  labels: {{- include "rovenue.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "rovenue.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: postgres
  ports:
    - name: postgres
      port: 5432
      targetPort: postgres
{{- end }}
```

Add `POSTGRES_PASSWORD` to Task 2's Secret template if it is not already there — generate it the same generate-or-preserve way, since rotating it on upgrade would lock the app out of its own database.

- [ ] **Step 2: Write `clickhouse.yaml`, templating the users file**

The `users.d/rovenue.xml` content becomes a ConfigMap rendered from `.Values.clickhouse.allowedNetworks`, mounted read-only. Copy the real file's structure and comments from `deploy/clickhouse/users.d/rovenue.xml`, replacing the hardcoded `<networks>` entries with a `range`. Keep the two comments that carry hard-won knowledge: that `readonly` must be a profile setting because the per-user `<readonly>` tag is silently ignored, and the defence-in-depth note about table functions reading outside the `rovenue` database.

Add the operator-facing warning at the top of the generated file and in the values comment:

```
<!-- If a client reports "password is incorrect" and you are certain the
     credentials are right, check this list first: ClickHouse reports an
     allow-list rejection to the client as an authentication failure. -->
```

Copy the healthcheck rationale too — `127.0.0.1`, not `localhost`, and a 60s start period, for the reasons the root compose file documents.

- [ ] **Step 3: Write `redpanda.yaml`, `redis.yaml`, `minio.yaml`**

Redpanda keeps the flags the root compose file uses — `--smp=1 --memory=1G --reserve-memory=0M --overprovisioned --node-id=0 --check=false` — with `--advertise-kafka-addr` pointing at the in-cluster Service DNS name rather than `redpanda:9092`. Redis is a Deployment (no persistence needed; the chart says why). MinIO is a StatefulSet whose root credentials double as the S3 client credentials the API uses, exactly as compose does — one pair of values, not two that can drift.

- [ ] **Step 4: Render every combination and validate against real schemas**

```bash
cd /Volumes/Development/rovenue
H="hosts.api=api.example.com,hosts.dashboard=app.example.com"
echo "--- all enabled ---"
helm template t deploy/helm/rovenue --set "$H" | npx --yes kubeconform-cli -strict -summary -
echo "--- all external ---"
helm template t deploy/helm/rovenue --set "$H" \
  --set postgres.enabled=false --set clickhouse.enabled=false \
  --set redpanda.enabled=false --set redis.enabled=false --set minio.enabled=false \
  --set external.databaseUrl=postgresql://u:p@h:5432/r \
  --set external.clickhouseUrl=http://h:8123 \
  --set external.kafkaBrokers=h:9092 \
  --set external.redisUrl=redis://h:6379 | npx --yes kubeconform-cli -strict -summary -
```

If `kubeconform-cli` is not available on npm under that name, install the binary (`brew install kubeconform`) and pipe to `kubeconform -strict -summary -`. Expected: 0 invalid resources in both renders, and the second render contains no StatefulSets.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/helm/rovenue/templates
git commit -m "feat(helm): optional in-cluster data plane

Postgres, ClickHouse, Redpanda, Redis and MinIO as StatefulSets behind
enabled flags, each replaceable by an external URL that
values.schema.json then requires.

The ClickHouse users file is templated from clickhouse.allowedNetworks
because most pod CIDRs fall inside 10/8 but not all clusters do — and an
allow-list rejection is reported to the client as 'password is
incorrect', which costs an operator an hour on credentials that were
never wrong.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Edge — Caddy and Ingress modes

**Files:**
- Create: `deploy/helm/rovenue/templates/edge-caddy.yaml`, `edge-ingress.yaml`

**Interfaces:**
- Consumes: Task 3's Service names.
- Produces: the `edge.mode` contract and the `customDomains.enabled` guard that Task 6's `NOTES.txt` reports on.

- [ ] **Step 1: Write `edge-caddy.yaml`**

Guarded by `{{- if eq .Values.edge.mode "caddy" }}`. A ConfigMap holding a Caddyfile derived from `deploy/caddy/Caddyfile` — read that file first; it carries the reasoning for every block. Adapt: upstreams become in-cluster Service names, and the ask-endpoint becomes `http://<fullname>-api:3001/internal/domains/check`.

Then a Deployment with:

```yaml
  # ONE replica, structurally. Caddy's ACME state lives in /data on a
  # PVC and is not shareable across replicas: two Caddies would each
  # solicit certificates for the same hostnames and race, which is also
  # the fastest way to hit Let's Encrypt's rate limits.
  replicas: 1
  strategy:
    # RWO PVC — a rolling update would deadlock waiting to attach the
    # volume to a second pod that cannot have it.
    type: Recreate
```

and a `Service` of type `LoadBalancer` exposing 80 and 443. The PVC comment must say what the root compose file says: losing this volume re-issues every certificate.

- [ ] **Step 2: Write `edge-ingress.yaml` with the guard**

```
{{- if eq .Values.edge.mode "ingress" }}
{{- if .Values.customDomains.enabled }}
{{- fail "customDomains.enabled=true requires edge.mode=caddy. Funnel custom domains are Caddy's on-demand TLS gated by the api's /internal/domains/check ask-endpoint; cert-manager issues only from hosts declared up front and has no equivalent. Set customDomains.enabled=false to install without the feature, or edge.mode=caddy to keep it." }}
{{- end }}
```

Then one Ingress covering `hosts.api`, `hosts.dashboard` and `hosts.docs`, routing to the Services from Task 3, with `className`, `annotations` and `tlsSecretName` from values.

- [ ] **Step 3: Prove both modes render and that the guard fires**

```bash
cd /Volumes/Development/rovenue
H="hosts.api=api.example.com,hosts.dashboard=app.example.com"
echo "--- caddy mode (default) ---"
helm template t deploy/helm/rovenue --set "$H" | grep -c "kind: Ingress" ; echo "(expect 0)"
helm template t deploy/helm/rovenue --set "$H" | grep -c "LoadBalancer" ; echo "(expect >=1)"
echo "--- ingress mode with custom domains OFF ---"
helm template t deploy/helm/rovenue --set "$H" \
  --set edge.mode=ingress --set customDomains.enabled=false | grep -c "kind: Ingress" ; echo "(expect >=1)"
echo "--- ingress mode with custom domains ON must FAIL ---"
helm template t deploy/helm/rovenue --set "$H" --set edge.mode=ingress 2>&1 | tail -3
```

Expected: the last command FAILS with the message naming both settings. A clean install here would be the bad outcome — a product feature quietly not working.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/helm/rovenue/templates
git commit -m "feat(helm): caddy and ingress edge modes

edge.mode=caddy is the default and preserves funnel custom domains via
on-demand TLS gated by the api's ask-endpoint. edge.mode=ingress
delegates TLS to cert-manager and cannot support that feature, so
combining it with customDomains.enabled fails template rendering with a
message naming both settings rather than installing cleanly and leaving
the feature quietly broken.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Chart hygiene and CI validation

**Files:**
- Create: `deploy/helm/rovenue/templates/pdb.yaml`, `NOTES.txt`, `templates/tests/helm-test.yaml`
- Create: `deploy/helm/rovenue/README.md` (helm-docs generated)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: a CI gate later changes must keep green.

- [ ] **Step 1: Write `pdb.yaml`**

```
{{- if gt (int .Values.api.replicaCount) 1 }}
```

A PodDisruptionBudget for the **api only**.

```yaml
# No PDB for the dispatcher, and that is deliberate: it is pinned to one
# replica by correctness, so any PDB with minAvailable >= 1 would block
# node drains forever.
```

- [ ] **Step 2: Write `NOTES.txt`**

It must print the resolved URLs, the next steps (OAuth callback URLs, DNS, the asset-header check), and — prominently, not as a footnote — the GitOps warning:

```
{{- if not .Values.existingSecret }}

  ####################################################################
  #  This release GENERATED its secrets.
  #
  #  If you manage this release with Argo CD, Flux, or anything else
  #  that renders with `helm template`, SET existingSecret NOW.
  #  `lookup` returns nothing in that mode, so the generation branch
  #  fires on every sync and rotates ENCRYPTION_KEY — which makes every
  #  stored App Store / Play / Stripe credential permanently
  #  undecryptable, on a sync that reports success.
  #
  #  Export the generated values first:
  #    kubectl -n {{ .Release.Namespace }} get secret {{ include "rovenue.secretName" . }} -o yaml
  ####################################################################
{{- end }}
```

- [ ] **Step 3: Write the `helm test` hook**

A Pod annotated `"helm.sh/hook": test` that `wget`s the api Service's `/health/ready` and the dashboard Service's `/`, so `helm test` is real post-install verification rather than a no-op.

- [ ] **Step 4: Generate the README**

```bash
cd /Volumes/Development/rovenue
npx --yes helm-docs --chart-search-root deploy/helm --output-file README.md
head -40 deploy/helm/rovenue/README.md
```

If `helm-docs` is unavailable via npx, install it (`brew install norwoodj/tap/helm-docs`) or write the README by hand — but say which you did, because a hand-written values table drifts and a generated one cannot.

- [ ] **Step 5: Add the CI gate**

In `.github/workflows/ci.yml`, add a job (or steps in the existing one) that installs Helm and kubeconform and runs, at minimum: `helm lint`; `helm template` in the default configuration piped to `kubeconform -strict`; `helm template` with the all-external configuration piped to the same; and a negative assertion that `edge.mode=ingress` with `customDomains.enabled=true` exits non-zero.

That last one matters most: it is the only check that the guard still guards. Write it so a passing render fails the job:

```yaml
      - name: Custom domains must be refused under edge.mode=ingress
        run: |
          if helm template t deploy/helm/rovenue \
              --set hosts.api=a.example.com --set hosts.dashboard=b.example.com \
              --set edge.mode=ingress >/dev/null 2>&1; then
            echo "::error::edge.mode=ingress rendered with customDomains.enabled=true; the guard is gone"
            exit 1
          fi
```

- [ ] **Step 6: Prove the CI gate catches a real regression**

Temporarily delete the `fail` line from `edge-ingress.yaml`, run the negative check from Step 5 locally, and confirm it now exits 1 with the error message. Restore the line and confirm the check passes. Paste both outputs. **Do not commit the deletion.**

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/helm/rovenue .github/workflows/ci.yml
git commit -m "feat(helm): chart hygiene and CI validation

PDB for the api only — the dispatcher is pinned to one replica, so any
PDB there would block node drains forever. NOTES.txt leads with the
GitOps secret warning rather than burying it. helm test actually probes
/health/ready.

CI runs helm lint, kubeconform against real Kubernetes schemas in two
configurations, and a negative check that edge.mode=ingress still
refuses customDomains.enabled — the only thing that proves the guard
still guards.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Publish the chart with the images

**Files:**
- Modify: `.github/workflows/release-images.yml`

**Interfaces:**
- Consumes: Task 2's `Chart.yaml` and the version resolution already in the `manifest` job.
- Produces: `oci://ghcr.io/broverse/charts/rovenue`, versioned identically to the images.

- [ ] **Step 1: Add a chart job**

Add a `chart` job that `needs: manifest`, so the chart is only published once every image it can reference actually exists. Reuse the same version resolution the manifest job uses, and set both `version` and `appVersion` from it:

```yaml
      - name: Package and push the chart
        run: |
          helm package deploy/helm/rovenue \
            --version "${VERSION#v}" --app-version "${VERSION#v}" -d /tmp/chart
          helm push "/tmp/chart/rovenue-${VERSION#v}.tgz" oci://${{ env.REGISTRY }}/${{ env.IMAGE_NAMESPACE }}/charts
```

Pin `azure/setup-helm` by commit SHA like every other action in the file, keeping the `# vN` trailing comment convention. Sign the pushed chart with cosign the same way the images are signed — the chart is a supply-chain artifact too.

- [ ] **Step 2: Match the prerelease rule**

Plan A made `latest` and `X.Y` skip prerelease versions. A chart has no `latest`, but the same reasoning applies to whether a prerelease chart should be pushed at all. Push it (a prerelease chart is explicitly opt-in by version), and add a comment saying that is the deliberate difference from the image tags.

- [ ] **Step 3: Validate**

```bash
cd /Volumes/Development/rovenue
npx --yes js-yaml .github/workflows/release-images.yml > /dev/null && echo "yaml ok"
grep -c "uses:.*@[0-9a-f]\{40\}" .github/workflows/release-images.yml
grep -c "uses:" .github/workflows/release-images.yml
helm package deploy/helm/rovenue --version 0.0.1 --app-version 0.0.1 -d /tmp/chart-test && ls /tmp/chart-test
rm -rf /tmp/chart-test
```

Expected: `yaml ok`; the two `uses:` counts are equal (every action still SHA-pinned); the chart packages cleanly.

**Do NOT push a tag and do NOT trigger the workflow.**

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add .github/workflows/release-images.yml
git commit -m "feat(ci): publish and sign the Helm chart alongside the images

The chart job needs: manifest, so a chart is only published once every
image tag it can reference exists — a chart naming an image that was
never built is a support ticket waiting to happen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `helm lint` passes and `helm template | kubeconform -strict` reports 0 invalid resources in both the all-in-cluster and all-external configurations.
- `helm template --set dispatcher.replicaCount=5` still renders `replicas: 1` for the dispatcher.
- `edge.mode=ingress` with `customDomains.enabled=true` fails rendering, and CI fails if that guard is removed.
- `postgres.enabled=false` without `external.databaseUrl` fails at `helm install` time.
- `ROVENUE_DASHBOARD_HOST` renders as a bare hostname with no scheme.
- `deploy/coolify/docker-compose.yml` parses, contains no `build:` and no repo bind-mount, and its service list differs from the root compose file's non-observability services by exactly `caddy` and `redpanda-console`.
- The release workflow packages and pushes the chart, every action still SHA-pinned.

**Not verifiable from here:** no Kubernetes cluster and no Coolify instance is available in this environment, and Docker Desktop was down for part of Plan A. `helm template` + `kubeconform` prove the manifests are valid and internally consistent; they do not prove the workloads run. A first real install is the remaining test, and it should be done against a throwaway namespace before this is recommended to anyone.
