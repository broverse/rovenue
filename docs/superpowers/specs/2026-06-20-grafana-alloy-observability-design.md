# Grafana Alloy Observability — Design Spec

**Date:** 2026-06-20
**Status:** Approved (design) — pending implementation plan
**Scope:** Add a self-hosted LGTM-style observability stack to the Rovenue Docker Compose
deployment, with **Grafana Alloy** as the single telemetry collector. Phase 1 covers
**metrics** and **logs**; distributed tracing is an explicit follow-up.

---

## 1. Problem

The platform ships structured logs and health probes but has **no observability backend**.
Concretely, in the current tree:

- Logging is Pino JSON to stdout (`apps/api/src/lib/logger.ts`) with request-id correlation
  (`apps/api/src/middleware/request-id.ts`), but logs are only visible via `docker logs` —
  not centralised, searchable, or correlated across `api`/`dispatcher` replicas.
- `apps/api/src/lib/metrics-notifications.ts` and `apps/api/src/lib/sentry-notifications.ts`
  are **stubs** — `prom-client` and `@sentry/node` are not installed. There is no `/metrics`
  endpoint.
- Infra components already expose Prometheus-format metrics that nobody scrapes: Redpanda
  (`:9644/metrics`) natively, ClickHouse via an opt-in `<prometheus>` block. Postgres and
  Redis expose nothing without an exporter.
- Health is point-in-time only (`GET /health`, `GET /health/ready` in
  `apps/api/src/routes/health.ts`); there is no time-series of dependency latency, queue
  depth, request rate/error rate, or resource use.

For an AGPL self-host product, the operator must be able to run the whole observability
stack themselves with no external SaaS dependency. This spec defines that stack.

## 2. Goals / Non-goals

**Goals**
- Add Alloy + Prometheus + Loki + Grafana to the Compose deployment, all self-hosted, data
  stays on the operator's host.
- **Metrics:** scrape infra (Postgres, Redis, ClickHouse, Redpanda) and the Rovenue API
  (RED metrics + Node defaults), store in Prometheus.
- **Logs:** collect every container's stdout (Pino JSON) into Loki, parsed and labelled.
- One small code change: wire the existing `metrics-notifications` stub to a real
  `prom-client` registry and expose `/metrics` on the **internal** (non-public) listener.
- Grafana auto-provisioned with datasources + a starter set of dashboards (no manual
  click-ops on first boot).
- Everything is **off by default for local dev** and gated behind a Compose profile, so
  `docker compose up` stays lean unless the operator opts in.

**Non-goals (explicit follow-ups)**
- **Distributed tracing** (Tempo + OTLP instrumentation of Hono). Designed for but not built
  in Phase 1 (see §9).
- Alerting / Alertmanager rules and notification routing.
- Long-term metric storage / downsampling (Mimir, Thanos). Single-node Prometheus with a
  finite retention window is sufficient for v1.
- Replacing the Sentry stub — error tracking stays a separate effort.
- Dashboard-app integration (surfacing metrics inside the Rovenue dashboard SPA). Grafana is
  the operator UI.

## 3. What gets collected

| Source | Signal | Mechanism | Code change |
|---|---|---|---|
| `api` replicas | metrics | `/metrics` on internal `:3001`, scraped via Docker SD | **yes** (prom-client) |
| Postgres (`db`) | metrics | `postgres-exporter` sidecar (`:9187`) | none |
| Redis | metrics | `redis-exporter` sidecar (`:9121`) | none |
| ClickHouse | metrics | native `<prometheus>` endpoint (`:9363/metrics`) | config only |
| Redpanda | metrics | native admin endpoint (`:9644/metrics`, `/public_metrics`) | none |
| all containers | logs | Alloy `loki.source.docker` over the Docker socket | none |

## 4. Architecture

Single collector (Alloy) → Prometheus (metrics) + Loki (logs) → Grafana (UI). No agent per
service; Alloy uses the Docker socket for both log tailing and target discovery.

```
                ┌───────── Docker socket (ro) ─────────┐
                │                                       │
   containers ──┤ logs                          targets │
   (stdout)     ▼                                       ▼
              ┌─────────────────── alloy ───────────────────┐
              │  loki.source.docker     prometheus.scrape    │
              └───────┬───────────────────────┬──────────────┘
                  push │                       │ remote_write
                       ▼                       ▼
                  ┌─ loki ─┐             ┌─ prometheus ─┐
                  └────┬───┘             └──────┬───────┘
                       └────────► grafana ◄─────┘   (host :3300)
```

### 4.1 New Compose services

All added to the existing root `docker-compose.yml` (note: the live compose file is at the
repo root, not `deploy/docker-compose.yml`), behind a new `observability` profile so they
only start with `docker compose --profile observability up` (or when `COMPOSE_PROFILES`
includes it in production).

| Service | Image | Host port | Notes |
|---|---|---|---|
| `alloy` | `grafana/alloy:latest` (pin a tag) | none | mounts `deploy/alloy/config.alloy` + `/var/run/docker.sock:ro` |
| `prometheus` | `prom/prometheus:v2.x` (pin) | none | run with `--web.enable-remote-write-receiver`; named volume for TSDB; `--storage.tsdb.retention.time=15d` |
| `loki` | `grafana/loki:3.x` (pin) | none | single-binary mode; `deploy/loki/config.yaml`; named volume |
| `grafana` | `grafana/grafana:11.x` (pin) | **3300:3000** | provisioning mounts (see §4.5); named volume; admin creds from env |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter` (pin) | none | `DATA_SOURCE_NAME` from PG env |
| `redis-exporter` | `oliver006/redis_exporter` (pin) | none | `REDIS_ADDR=redis://redis:6379` |

All join the existing app network so Alloy/Prometheus can resolve `api`, `db`, `redis`,
`clickhouse`, `redpanda` by service name.

**Port choice:** Grafana's UI defaults to container port 3000; published to host **3300**.
Host 3000 is taken by the API; the API's internal `:3001` is container-network only (never
host-published), so 3300 avoids all ambiguity.

**New named volumes:** `rovenue-prometheus-data`, `rovenue-loki-data`,
`rovenue-grafana-data`.

### 4.2 API `/metrics` endpoint (the one code change)

Replace the `metrics-notifications.ts` stub's body with a real `prom-client` registry; keep
the call sites untouched (same swap pattern the file already documents for Sentry).

- Add `prom-client` to `apps/api` deps. Create a singleton `Registry`, call
  `collectDefaultMetrics({ register })` (Node/process/event-loop/GC gauges).
- Define RED metrics:
  - `http_requests_total` — Counter, labels `method`, `route`, `status`.
  - `http_request_duration_seconds` — Histogram, labels `method`, `route`, `status`,
    sensible buckets.
  - (Optional, cheap) BullMQ queue-depth gauge sampled on scrape.
- Add a Hono middleware that records the two HTTP metrics per request. Use the **matched
  route pattern** (e.g. `/v1/subscribers/:id`), not the raw path, to avoid label cardinality
  blow-up. Skip `/metrics` and `/health*` from the histogram.
- Expose `GET /metrics` on the **internal** app (`apps/api/src/internal-app.ts`, listener on
  `:3001`) — same place as the Caddy ask-endpoint — so metrics are never on the public
  surface. Alloy reaches it over the Docker network.
- Content type: `register.contentType`; body: `await register.metrics()`.

**Why internal-app:** keeps `/metrics` off the public `:3000` tree (no auth needed, no
accidental exposure through Caddy), and `internal-app` already exists for exactly this kind
of cluster-internal endpoint.

### 4.3 Alloy configuration (`deploy/alloy/config.alloy`)

Two pipelines — logs and metrics.

```hcl
// ---------- LOGS: every container's stdout -> Loki ----------
discovery.docker "containers" {
  host = "unix:///var/run/docker.sock"
}

discovery.relabel "containers" {
  targets = discovery.docker.containers.targets
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(.*)"
    target_label  = "container"
  }
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    target_label  = "service"
  }
}

loki.source.docker "default" {
  host          = "unix:///var/run/docker.sock"
  targets       = discovery.relabel.containers.output
  forward_to    = [loki.process.pino.receiver]
  relabel_rules = discovery.relabel.containers.rules
}

// Pino logs are JSON; lift level/msg/requestId into labels/structured metadata.
loki.process "pino" {
  forward_to = [loki.write.default.receiver]
  stage.json {
    expressions = { level = "level", msg = "msg", requestId = "requestId" }
  }
  stage.labels { values = { level = "level" } }
}

loki.write "default" {
  endpoint { url = "http://loki:3100/loki/api/v1/push" }
}

// ---------- METRICS: infra + API -> Prometheus ----------
// Static infra targets (native endpoints + exporters).
prometheus.scrape "infra" {
  scrape_interval = "15s"
  targets = [
    { __address__ = "redpanda:9644",         job = "redpanda" },
    { __address__ = "clickhouse:9363",        job = "clickhouse" },
    { __address__ = "postgres-exporter:9187", job = "postgres" },
    { __address__ = "redis-exporter:9121",    job = "redis" },
  ]
  forward_to = [prometheus.remote_write.default.receiver]
}

// API replicas: discover all `api` containers, scrape each on the internal :3001/metrics.
discovery.relabel "api" {
  targets = discovery.docker.containers.targets
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    regex         = "api"
    action        = "keep"
  }
  rule { target_label = "__address__"      replacement = "" } // set per-container below
}

prometheus.scrape "api" {
  scrape_interval = "15s"
  targets         = discovery.relabel.api.output
  // override port to the internal listener
  // (Alloy resolves each api container IP via Docker SD; metrics path defaults to /metrics)
  forward_to      = [prometheus.remote_write.default.receiver]
}

prometheus.remote_write "default" {
  endpoint { url = "http://prometheus:9090/api/v1/write" }
}
```

> Implementation note for the plan: the exact relabel rule that rewrites each discovered
> `api` container's address to `<container-ip>:3001` must be pinned down against the running
> Alloy version's Docker-SD meta labels (`__meta_docker_network_ip` + a port override).
> Verify against `redpanda:9644/metrics` and `clickhouse:9363/metrics` returning data before
> wiring the API scrape.

### 4.4 ClickHouse Prometheus endpoint (`deploy/clickhouse/config.d/`)

Add a `prometheus.xml` enabling the native exporter (the `config.d` directory is already the
mount point for CH config):

```xml
<clickhouse>
  <prometheus>
    <endpoint>/metrics</endpoint>
    <port>9363</port>
    <metrics>true</metrics>
    <events>true</events>
    <asynchronous_metrics>true</asynchronous_metrics>
  </prometheus>
</clickhouse>
```

The `clickhouse` service must expose `9363` on the Compose network (no host publish needed).

### 4.5 Grafana provisioning (`deploy/grafana/`)

Zero-click first boot via file provisioning:

- `provisioning/datasources/datasources.yaml` — Prometheus (`http://prometheus:9090`,
  default) and Loki (`http://loki:3100`).
- `provisioning/dashboards/dashboards.yaml` — a file provider pointing at
  `/etc/grafana/dashboards`.
- `dashboards/` — starter dashboards as JSON:
  - **Rovenue API (RED):** request rate / error rate / p50-p95-p99 latency from
    `http_request_duration_seconds`, plus event-loop lag and RSS from default metrics.
  - **Postgres**, **Redis**, **ClickHouse**, **Redpanda:** adapt well-known community
    dashboard JSON for each exporter/native endpoint (pin by source + revision in a comment).
  - **Logs explorer:** a Loki-backed dashboard with a `service` / `level` filter.

Admin credentials from env (`GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`); anonymous
access off.

## 5. Networking & ports summary

| Concern | Decision |
|---|---|
| Grafana UI | host **3300** → container 3000 |
| Prometheus / Loki / Alloy / exporters | **no** host ports; Compose-network only |
| API `/metrics` | internal listener `:3001`, network-only (not via Caddy) |
| ClickHouse metrics | `:9363` on network only |
| Docker socket | mounted **read-only** into `alloy` only |

## 6. Environment variables (`.env.example`)

New keys (all optional; stack is profile-gated):
- `GRAFANA_ADMIN_USER` (default `admin`)
- `GRAFANA_ADMIN_PASSWORD` (required when profile enabled; no insecure default in prod)
- `PROMETHEUS_RETENTION` (default `15d`)
- `METRICS_ENABLED` (default `true`) — feature flag the API checks before mounting `/metrics`
  and the scrape middleware, so the code change is a no-op when unset.

## 7. Files touched

**New**
- `deploy/alloy/config.alloy`
- `deploy/loki/config.yaml`
- `deploy/grafana/provisioning/datasources/datasources.yaml`
- `deploy/grafana/provisioning/dashboards/dashboards.yaml`
- `deploy/grafana/dashboards/*.json` (api-red, postgres, redis, clickhouse, redpanda, logs)
- `deploy/clickhouse/config.d/prometheus.xml`
- `apps/api/src/middleware/metrics.ts` (RED middleware)

**Modified**
- `docker-compose.yml` (root) — add `alloy`, `prometheus`, `loki`, `grafana`,
  `postgres-exporter`, `redis-exporter` under the `observability` profile; new volumes;
  expose CH `9363` on network.
- `apps/api/package.json` — add `prom-client`.
- `apps/api/src/lib/metrics-notifications.ts` — replace stub with real registry + helpers.
- `apps/api/src/internal-app.ts` — mount `GET /metrics`.
- `apps/api/src/app.ts` (or wherever middleware is composed) — register the metrics
  middleware, gated by `METRICS_ENABLED`.
- `.env.example` — new keys (§6).
- `CLAUDE.md` / deploy docs — document the `observability` profile and Grafana URL.

## 8. Testing / verification

- **Unit:** metrics middleware records `http_requests_total` and observes the histogram with
  the matched route label (not raw path); `/metrics` and `/health*` excluded. Registry
  renders Prometheus text format. `METRICS_ENABLED=false` → no `/metrics` route, middleware
  is a pass-through.
- **Manual / smoke (documented runbook):**
  1. `docker compose --profile observability up -d`.
  2. `curl redpanda:9644/metrics`, `clickhouse:9363/metrics`, `postgres-exporter:9187`,
     `redis-exporter:9121`, and the API internal `:3001/metrics` from inside the network all
     return Prometheus text.
  3. Prometheus `/targets` shows every job **UP**.
  4. Grafana at `http://localhost:3300` boots with both datasources and all starter
     dashboards present, panels populated.
  5. Loki shows logs for each `service`, filterable by `level`, with `requestId` in
     structured metadata.
- Follow CLAUDE.md test conventions (Vitest). No testcontainers suite required for Phase 1
  (the API code change is unit-testable; the rest is compose/config verified via the
  runbook).

## 9. Tracing follow-up (designed, not built)

Phase 2 adds Tempo + OTLP:
- Add `tempo` service (volume, network-only) and an `otelcol.receiver.otlp` +
  `otelcol.exporter.otlp` pair in `config.alloy` forwarding to Tempo.
- Instrument the API with `@opentelemetry/sdk-node` + Hono instrumentation, exporting OTLP to
  `alloy:4317`. Propagate W3C `traceparent`; reuse the existing `X-Request-Id` correlation as
  a span attribute.
- Add a Tempo datasource + trace-to-logs correlation (Loki `requestId` ↔ trace id) in Grafana
  provisioning.
This is intentionally deferred so Phase 1 ships value (RED + centralised logs) without the
larger instrumentation surface.

## 10. Risks / decisions

- **Profile-gated by default:** observability services do **not** start on a bare
  `docker compose up`, keeping local dev lean and avoiding RAM/disk cost for contributors.
  Production opts in via `COMPOSE_PROFILES=observability`.
- **API replica scraping:** the API is horizontally scalable; a single `api:3001` DNS name
  would round-robin and miss replicas. The spec uses Docker service discovery to scrape every
  `api` container. The exact relabel rule is the one config detail that must be verified
  against the pinned Alloy version during implementation (§4.3 note).
- **Dispatcher metrics:** the `dispatcher` container runs the same image but as the
  outbox/worker process; whether it exposes the internal HTTP listener determines if its
  BullMQ/worker metrics are scrapeable. Phase 1 scopes metrics to the public-API process; a
  dispatcher `/metrics` is a small follow-up if worker-level metrics are wanted.
- **Single-node Prometheus retention:** finite (`15d` default) — no long-term storage. Fine
  for operational dashboards; revisit with Mimir/Thanos only if long retention is required.
- **Docker socket exposure:** Alloy gets read-only socket access for discovery + log
  tailing. This is the standard Grafana pattern but is a privileged mount; documented so
  operators understand the trust boundary.
- **Label cardinality:** RED metrics use the matched route pattern and bounded status/method
  labels — never raw paths or user/project ids — to keep Prometheus series count bounded.
- **Image tags pinned:** every image gets a pinned tag (not `latest`) in the final compose to
  keep self-host deploys reproducible.
