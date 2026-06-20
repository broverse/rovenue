# Grafana Alloy Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-hosted Grafana Alloy → Prometheus/Loki → Grafana observability stack to the Rovenue Compose deployment, collecting metrics and logs (tracing deferred).

**Architecture:** A single Alloy collector tails every container's stdout into Loki and scrapes infra + API metrics into Prometheus; Grafana provides the UI. New services live behind a Compose `observability` profile so local dev stays lean. The only application code change is wiring a real `prom-client` registry and exposing `/metrics` on the existing internal (non-public) listener.

**Tech Stack:** Docker Compose, Grafana Alloy, Prometheus, Loki, Grafana, `prom-client`, Hono, Vitest, TypeScript (strict).

**Design spec:** `docs/superpowers/specs/2026-06-20-grafana-alloy-observability-design.md`

## Global Constraints

- The live Compose file is the **repository-root `docker-compose.yml`**, NOT `deploy/docker-compose.yml`.
- All new observability services MUST be gated behind a Compose `profiles: ["observability"]` so a bare `docker compose up` does not start them.
- All new images MUST be pinned to a specific tag (never `latest`).
- `/metrics` MUST be served only on the internal listener (`env.INTERNAL_PORT`, default 3001), never the public app — it carries no auth.
- RED metric labels MUST use the matched Hono route pattern (`c.req.routePath`), never raw paths or any user/project id, to bound Prometheus cardinality.
- Grafana UI publishes to host port **3300** (host 3000 is the API; host 3001 is unused on the host because the API's internal listener is network-only).
- New named volumes: `rovenue-prometheus-data`, `rovenue-loki-data`, `rovenue-grafana-data`.
- TypeScript strict mode; Vitest for tests; conventional commits.

---

### Task 1: API metrics registry + RED middleware

**Files:**
- Modify: `apps/api/package.json` (add `prom-client`)
- Create: `apps/api/src/lib/metrics.ts`
- Create: `apps/api/src/middleware/metrics.ts`
- Test: `apps/api/src/middleware/metrics.test.ts`
- Modify: `apps/api/src/lib/env.ts:5-9` area (add `METRICS_ENABLED`)

**Interfaces:**
- Produces:
  - `registry: Registry` (prom-client) and metric singletons from `lib/metrics.ts`:
    `httpRequestsTotal: Counter`, `httpRequestDuration: Histogram`.
  - `metricsMiddleware: MiddlewareHandler` from `middleware/metrics.ts`.
  - `env.METRICS_ENABLED: boolean`.
- Consumes: `env` from `apps/api/src/lib/env.ts`.

- [ ] **Step 1: Add the dependency**

Run:
```bash
pnpm --filter @rovenue/api add prom-client
```
Expected: `prom-client` appears in `apps/api/package.json` dependencies.

- [ ] **Step 2: Add the env flag**

In `apps/api/src/lib/env.ts`, alongside `PORT`/`INTERNAL_PORT` (lines 5-9), add (follow the existing `z.enum(["true","false"]).transform(...)` toggle pattern used elsewhere in this schema):

```typescript
METRICS_ENABLED: z
  .enum(["true", "false"])
  .default("true")
  .transform((v) => v === "true"),
```

- [ ] **Step 3: Write the metrics registry**

Create `apps/api/src/lib/metrics.ts`:

```typescript
// =============================================================
// Prometheus metrics registry
// =============================================================
//
// A dedicated (non-global) prom-client Registry so importing this
// module twice in tests never collides with the default registry.
// Exposed as text via GET /metrics on the INTERNAL listener only.

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
} from "prom-client";

export const registry = new Registry();

// Node/process/event-loop/GC gauges.
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by the API",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
```

- [ ] **Step 4: Write the failing middleware test**

Create `apps/api/src/middleware/metrics.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { metricsMiddleware } from "./metrics";
import { httpRequestsTotal, registry } from "../lib/metrics";

describe("metricsMiddleware", () => {
  beforeEach(() => {
    httpRequestsTotal.reset();
  });

  function buildApp() {
    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/v1/items/:id", (c) => c.json({ ok: true }));
    return app;
  }

  it("records http_requests_total with the matched route pattern", async () => {
    const res = await buildApp().request("/v1/items/42");
    expect(res.status).toBe(200);

    const metric = await httpRequestsTotal.get();
    const sample = metric.values.find(
      (v) => v.labels.route === "/v1/items/:id",
    );
    expect(sample?.value).toBe(1);
    expect(sample?.labels).toMatchObject({
      method: "GET",
      route: "/v1/items/:id",
      status: "200",
    });
  });

  it("renders Prometheus text from the registry", async () => {
    await buildApp().request("/v1/items/7");
    const text = await registry.metrics();
    expect(text).toContain("http_requests_total");
    expect(text).toContain('route="/v1/items/:id"');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test metrics.test`
Expected: FAIL — `./metrics` has no `metricsMiddleware` export.

- [ ] **Step 6: Write the middleware**

Create `apps/api/src/middleware/metrics.ts`:

```typescript
import type { MiddlewareHandler } from "hono";
import { env } from "../lib/env";
import { httpRequestsTotal, httpRequestDuration } from "../lib/metrics";

/**
 * RED metrics (rate/errors/duration) for every request reaching this
 * middleware. Uses the MATCHED route pattern (e.g. /v1/subscribers/:id)
 * — never the raw path — to keep Prometheus series count bounded.
 * No-op when METRICS_ENABLED is false.
 */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  if (!env.METRICS_ENABLED) {
    return next();
  }

  const start = performance.now();
  await next();
  const seconds = (performance.now() - start) / 1000;

  const labels = {
    method: c.req.method,
    route: c.req.routePath ?? "unmatched",
    status: String(c.res.status),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDuration.observe(labels, seconds);
};
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test metrics.test`
Expected: PASS (both cases).

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/lib/metrics.ts apps/api/src/lib/env.ts apps/api/src/middleware/metrics.ts apps/api/src/middleware/metrics.test.ts
git commit -m "feat(api): add prom-client registry + RED metrics middleware"
```
(If the lockfile is at the repo root, `git add pnpm-lock.yaml` instead.)

---

### Task 2: Expose `/metrics` internally + register the middleware

**Files:**
- Modify: `apps/api/src/internal-app.ts:60` (add `/metrics` route)
- Modify: `apps/api/src/app.ts:101` (register `metricsMiddleware` after the health route)
- Test: `apps/api/src/internal-app.test.ts`

**Interfaces:**
- Consumes: `registry` from `lib/metrics.ts`, `metricsMiddleware` from `middleware/metrics.ts`, `env.METRICS_ENABLED`.
- Produces: `GET /metrics` on `internalApp` returning Prometheus text.

- [ ] **Step 1: Write the failing internal-app test**

Create `apps/api/src/internal-app.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { internalApp } from "./internal-app";

describe("internalApp GET /metrics", () => {
  it("serves Prometheus text", async () => {
    const res = await internalApp.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("process_cpu_user_seconds_total");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test internal-app.test`
Expected: FAIL with 404 (no `/metrics` route yet).

- [ ] **Step 3: Add the `/metrics` route to the internal app**

In `apps/api/src/internal-app.ts`, add these imports near the top:

```typescript
import { env } from "./lib/env";
import { registry } from "./lib/metrics";
```

(`env` is already imported in this file — keep a single import.) Then, after the
`/internal/health` route (line ~60), append:

```typescript
// Prometheus scrape target. Internal-only by design (no auth) — Alloy
// reaches it over the docker network; it is never published to the host.
internalApp.get("/metrics", async (c) => {
  if (!env.METRICS_ENABLED) return c.text("metrics disabled", 404);
  c.header("Content-Type", registry.contentType);
  return c.body(await registry.metrics());
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test internal-app.test`
Expected: PASS.

- [ ] **Step 5: Register the middleware on the public app**

In `apps/api/src/app.ts`, import the middleware near the other middleware imports:

```typescript
import { metricsMiddleware } from "./middleware/metrics";
```

Then insert it into the fluent chain **immediately after** `.use("*", globalIpRateLimit())`
(line 101) and before the first feature `.route(...)`. Registering it after
`.route("/health", healthRoute)` (line 100) means `/health` is intentionally excluded from
RED metrics:

```typescript
  .use("*", globalIpRateLimit())
  .use("*", metricsMiddleware)
```

- [ ] **Step 6: Verify the build and full API test suite**

Run: `pnpm --filter @rovenue/api build && pnpm --filter @rovenue/api test`
Expected: tsc clean; metrics + internal-app tests pass; no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/internal-app.ts apps/api/src/internal-app.test.ts apps/api/src/app.ts
git commit -m "feat(api): expose /metrics on internal listener and record RED metrics"
```

---

### Task 3: ClickHouse native Prometheus endpoint

**Files:**
- Create: `deploy/clickhouse/config.d/prometheus.xml`
- Modify: `docker-compose.yml` (expose port 9363 on the `clickhouse` service's network)

**Interfaces:**
- Produces: ClickHouse Prometheus metrics at `clickhouse:9363/metrics` on the Compose network.

- [ ] **Step 1: Add the ClickHouse Prometheus config**

Create `deploy/clickhouse/config.d/prometheus.xml`:

```xml
<clickhouse>
  <prometheus>
    <endpoint>/metrics</endpoint>
    <port>9363</port>
    <metrics>true</metrics>
    <events>true</events>
    <asynchronous_metrics>true</asynchronous_metrics>
    <errors>true</errors>
  </prometheus>
</clickhouse>
```

- [ ] **Step 2: Expose 9363 on the clickhouse service**

In `docker-compose.yml`, on the existing `clickhouse` service add an `expose` entry (network-only, NOT under `ports:`):

```yaml
  clickhouse:
    # ...existing config...
    expose:
      - "9363"
```

- [ ] **Step 3: Verify**

Run:
```bash
docker compose up -d clickhouse
docker compose exec clickhouse wget -qO- http://localhost:9363/metrics | head -n 5
```
Expected: Prometheus text lines (e.g. `# HELP ClickHouseProfileEvents_Query ...`).

- [ ] **Step 4: Commit**

```bash
git add deploy/clickhouse/config.d/prometheus.xml docker-compose.yml
git commit -m "feat(deploy): enable ClickHouse native Prometheus endpoint"
```

---

### Task 4: Prometheus + Loki services (observability profile)

**Files:**
- Create: `deploy/loki/config.yaml`
- Modify: `docker-compose.yml` (add `prometheus`, `loki` services + volumes)

**Interfaces:**
- Produces: `prometheus:9090` (with remote-write receiver) and `loki:3100` on the Compose network, both under the `observability` profile.

- [ ] **Step 1: Write the Loki config**

Create `deploy/loki/config.yaml` (single-binary, filesystem storage):

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 168h
  allow_structured_metadata: true
```

- [ ] **Step 2: Add the services + volumes to docker-compose.yml**

Add under `services:`:

```yaml
  prometheus:
    image: prom/prometheus:v2.54.1
    profiles: ["observability"]
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--web.enable-remote-write-receiver"
      - "--storage.tsdb.retention.time=${PROMETHEUS_RETENTION:-15d}"
    volumes:
      - rovenue-prometheus-data:/prometheus
    expose:
      - "9090"
    restart: unless-stopped

  loki:
    image: grafana/loki:3.1.1
    profiles: ["observability"]
    command: ["-config.file=/etc/loki/config.yaml"]
    volumes:
      - ./deploy/loki/config.yaml:/etc/loki/config.yaml:ro
      - rovenue-loki-data:/loki
    expose:
      - "3100"
    restart: unless-stopped
```

Prometheus needs a minimal config file even though Alloy remote-writes to it. Create
`deploy/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
# Targets are pushed via Alloy remote_write; no scrape_configs needed here.
```

And mount it — add to the `prometheus` service `volumes:`:

```yaml
      - ./deploy/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
```

Add to the top-level `volumes:` block:

```yaml
  rovenue-prometheus-data:
  rovenue-loki-data:
```

- [ ] **Step 3: Verify compose validity and boot**

Run:
```bash
docker compose --profile observability config >/dev/null && echo "compose OK"
docker compose --profile observability up -d prometheus loki
docker compose exec prometheus wget -qO- http://localhost:9090/-/ready
docker compose exec loki wget -qO- http://localhost:3100/ready
```
Expected: `compose OK`; Prometheus prints `Prometheus Server is Ready.`; Loki prints `ready`.

- [ ] **Step 4: Commit**

```bash
git add deploy/loki/config.yaml deploy/prometheus/prometheus.yml docker-compose.yml
git commit -m "feat(deploy): add Prometheus + Loki under observability profile"
```

---

### Task 5: Postgres + Redis exporters

**Files:**
- Modify: `docker-compose.yml` (add `postgres-exporter`, `redis-exporter`)

**Interfaces:**
- Produces: `postgres-exporter:9187` and `redis-exporter:9121` on the Compose network.

- [ ] **Step 1: Add the exporters to docker-compose.yml**

```yaml
  postgres-exporter:
    image: prometheuscommunity/postgres-exporter:v0.15.0
    profiles: ["observability"]
    environment:
      DATA_SOURCE_NAME: "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}?sslmode=disable"
    expose:
      - "9187"
    depends_on:
      - db
    restart: unless-stopped

  redis-exporter:
    image: oliver006/redis_exporter:v1.62.0
    profiles: ["observability"]
    environment:
      REDIS_ADDR: "redis://redis:6379"
    expose:
      - "9121"
    depends_on:
      - redis
    restart: unless-stopped
```

> Use the same `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` variable names the `db`
> service already references in `docker-compose.yml`; copy them verbatim from that service's
> environment.

- [ ] **Step 2: Verify the exporters scrape locally**

Run:
```bash
docker compose --profile observability up -d postgres-exporter redis-exporter
docker compose exec postgres-exporter wget -qO- http://localhost:9187/metrics | grep -m1 pg_up
docker compose exec redis-exporter wget -qO- http://localhost:9121/metrics | grep -m1 redis_up
```
Expected: `pg_up 1` and `redis_up 1`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(deploy): add postgres + redis exporters under observability profile"
```

---

### Task 6: Alloy collector (logs + metrics pipelines)

**Files:**
- Create: `deploy/alloy/config.alloy`
- Modify: `docker-compose.yml` (add `alloy` service)

**Interfaces:**
- Consumes: Docker socket (ro), `loki:3100`, `prometheus:9090`, the metric endpoints from Tasks 1–5.
- Produces: logs in Loki and metrics in Prometheus.

- [ ] **Step 1: Write the Alloy config**

Create `deploy/alloy/config.alloy`:

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

// Pino logs are JSON: lift level into a label, keep msg/requestId as
// structured metadata.
loki.process "pino" {
  forward_to = [loki.write.default.receiver]
  stage.json {
    expressions = { level = "level" }
  }
  stage.labels {
    values = { level = "level" }
  }
}

loki.write "default" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}

// ---------- METRICS: infra -> Prometheus ----------
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

// ---------- METRICS: API replicas -> Prometheus ----------
// Discover every `api` container and scrape the internal :3001/metrics.
discovery.relabel "api" {
  targets = discovery.docker.containers.targets
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    regex         = "api"
    action        = "keep"
  }
  rule {
    source_labels = ["__meta_docker_network_ip"]
    target_label  = "__address__"
    replacement   = "$1:3001"
  }
  rule {
    target_label = "job"
    replacement  = "rovenue-api"
  }
}

prometheus.scrape "api" {
  scrape_interval = "15s"
  targets         = discovery.relabel.api.output
  metrics_path    = "/metrics"
  forward_to      = [prometheus.remote_write.default.receiver]
}

prometheus.remote_write "default" {
  endpoint {
    url = "http://prometheus:9090/api/v1/write"
  }
}
```

> **Version-sensitive detail:** the `__meta_docker_network_ip` → `__address__:3001` rewrite
> for the API scrape must be confirmed against the pinned Alloy image's Docker-SD meta
> labels (Step 3 verifies it). If the meta label name differs in the pinned version, adjust
> the `source_labels` accordingly; the rest of the config is stable.

- [ ] **Step 2: Add the Alloy service to docker-compose.yml**

```yaml
  alloy:
    image: grafana/alloy:v1.4.2
    profiles: ["observability"]
    command:
      - "run"
      - "/etc/alloy/config.alloy"
      - "--server.http.listen-addr=0.0.0.0:12345"
    volumes:
      - ./deploy/alloy/config.alloy:/etc/alloy/config.alloy:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    depends_on:
      - loki
      - prometheus
    restart: unless-stopped
```

- [ ] **Step 3: Verify Alloy is healthy and targets are UP**

Run:
```bash
docker compose --profile observability up -d alloy
sleep 20
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=up' \
  | grep -o '"job":"[a-z-]*"' | sort -u
```
Expected: lines including `"job":"redpanda"`, `"job":"clickhouse"`, `"job":"postgres"`, `"job":"redis"`, and `"job":"rovenue-api"` (the API job requires the `api` service running with `METRICS_ENABLED=true`).
Also: `docker compose logs alloy | grep -i error` should be empty.

- [ ] **Step 4: Verify logs reach Loki**

Run:
```bash
docker compose exec loki wget -qO- \
  'http://localhost:3100/loki/api/v1/label/service/values'
```
Expected: JSON listing container service names (`api`, `dispatcher`, `caddy`, ...).

- [ ] **Step 5: Commit**

```bash
git add deploy/alloy/config.alloy docker-compose.yml
git commit -m "feat(deploy): add Grafana Alloy collector for logs + metrics"
```

---

### Task 7: Grafana with provisioned datasources + dashboards

**Files:**
- Create: `deploy/grafana/provisioning/datasources/datasources.yaml`
- Create: `deploy/grafana/provisioning/dashboards/dashboards.yaml`
- Create: `deploy/grafana/dashboards/rovenue-api-red.json`
- Create: `deploy/grafana/dashboards/.gitkeep` (community dashboards documented below)
- Modify: `docker-compose.yml` (add `grafana` service + volume)

**Interfaces:**
- Consumes: `prometheus:9090`, `loki:3100`.
- Produces: Grafana UI on host `:3300` with both datasources and the API RED dashboard.

- [ ] **Step 1: Datasource provisioning**

Create `deploy/grafana/provisioning/datasources/datasources.yaml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
  - name: Loki
    type: loki
    uid: loki
    access: proxy
    url: http://loki:3100
```

- [ ] **Step 2: Dashboard provider**

Create `deploy/grafana/provisioning/dashboards/dashboards.yaml`:

```yaml
apiVersion: 1
providers:
  - name: rovenue
    orgId: 1
    folder: Rovenue
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: /etc/grafana/dashboards
```

- [ ] **Step 3: API RED dashboard**

Create `deploy/grafana/dashboards/rovenue-api-red.json`:

```json
{
  "uid": "rovenue-api-red",
  "title": "Rovenue API — RED",
  "tags": ["rovenue"],
  "timezone": "utc",
  "schemaVersion": 39,
  "refresh": "30s",
  "time": { "from": "now-6h", "to": "now" },
  "panels": [
    {
      "type": "timeseries",
      "title": "Request rate (req/s) by route",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "expr": "sum by (route) (rate(http_requests_total[5m]))",
          "legendFormat": "{{route}}"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Error rate (5xx, req/s)",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m]))",
          "legendFormat": "5xx"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Latency p50 / p95 / p99 (s)",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        { "expr": "histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))", "legendFormat": "p50" },
        { "expr": "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))", "legendFormat": "p95" },
        { "expr": "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))", "legendFormat": "p99" }
      ]
    },
    {
      "type": "timeseries",
      "title": "Event loop lag (s) + RSS (bytes)",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        { "expr": "nodejs_eventloop_lag_seconds", "legendFormat": "loop lag" },
        { "expr": "process_resident_memory_bytes", "legendFormat": "rss" }
      ]
    }
  ]
}
```

- [ ] **Step 4: Document community dashboards (no silent gaps)**

Create `deploy/grafana/dashboards/README.md` listing the infra dashboards an operator can
drop in (pinned IDs so coverage is explicit, not assumed):

```markdown
# Grafana dashboards

`rovenue-api-red.json` is provisioned automatically. For infra, download these community
dashboards into this directory (they bind to the `prometheus` datasource UID):

- Postgres (postgres-exporter): grafana.com dashboard ID **9628**
- Redis (redis_exporter): grafana.com dashboard ID **763**
- ClickHouse: grafana.com dashboard ID **14192**
- Redpanda: grafana.com dashboard ID **18135**

After downloading each JSON, set its datasource references to the `prometheus` UID and place
the file here; the file provider picks it up within 30s. They are NOT committed by default to
avoid vendoring large third-party JSON; commit them if you want them in the image.
```

Also create an empty `deploy/grafana/dashboards/.gitkeep`.

- [ ] **Step 5: Add the Grafana service to docker-compose.yml**

```yaml
  grafana:
    image: grafana/grafana:11.2.2
    profiles: ["observability"]
    ports:
      - "3300:3000"
    environment:
      GF_SECURITY_ADMIN_USER: "${GRAFANA_ADMIN_USER:-admin}"
      GF_SECURITY_ADMIN_PASSWORD: "${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD}"
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_AUTH_ANONYMOUS_ENABLED: "false"
    volumes:
      - ./deploy/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./deploy/grafana/dashboards:/etc/grafana/dashboards:ro
      - rovenue-grafana-data:/var/lib/grafana
    depends_on:
      - prometheus
      - loki
    restart: unless-stopped
```

Add to the top-level `volumes:` block:

```yaml
  rovenue-grafana-data:
```

- [ ] **Step 6: Verify Grafana boots with datasources + dashboard**

Run:
```bash
GRAFANA_ADMIN_PASSWORD=devpass docker compose --profile observability up -d grafana
sleep 15
curl -s -u admin:devpass http://localhost:3300/api/datasources | grep -o '"type":"[a-z]*"'
curl -s -u admin:devpass http://localhost:3300/api/search?query=Rovenue | grep -o '"title":"[^"]*"'
```
Expected: datasource types `prometheus` and `loki`; search result includes `"title":"Rovenue API — RED"`.

- [ ] **Step 7: Commit**

```bash
git add deploy/grafana docker-compose.yml
git commit -m "feat(deploy): add Grafana with provisioned datasources and RED dashboard"
```

---

### Task 8: Env, docs, and end-to-end verification

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md` (Environment Variables + Commands sections)

**Interfaces:** none (documentation + final runbook).

- [ ] **Step 1: Add env keys to `.env.example`**

Append an observability block:

```bash
# --- Observability (optional; only used with COMPOSE_PROFILES=observability) ---
METRICS_ENABLED=true
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=
PROMETHEUS_RETENTION=15d
```

- [ ] **Step 2: Document in CLAUDE.md**

Under **Environment Variables**, add `METRICS_ENABLED`, `GRAFANA_ADMIN_USER`,
`GRAFANA_ADMIN_PASSWORD`, `PROMETHEUS_RETENTION` (one line each). Under **Commands**, add:

```markdown
- `COMPOSE_PROFILES=observability docker compose up` — start the stack WITH Grafana/Prometheus/Loki/Alloy (Grafana on http://localhost:3300)
```

- [ ] **Step 3: Full end-to-end verification (runbook)**

Run:
```bash
GRAFANA_ADMIN_PASSWORD=devpass COMPOSE_PROFILES=observability docker compose up -d
sleep 30
# 1. All Prometheus targets UP:
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=up' \
  | grep -o '"job":"[a-z-]*","[^}]*"value":\["[0-9.]*","1"\]' | sort -u
# 2. API RED metrics present (after a request through Caddy/API):
curl -s http://localhost:3000/health >/dev/null
docker compose exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/query?query=http_requests_total' | grep -o '"route":"[^"]*"' | head
# 3. Logs queryable in Loki:
docker compose exec loki wget -qO- \
  'http://localhost:3100/loki/api/v1/label/service/values'
# 4. Grafana UI reachable:
curl -s -o /dev/null -w "%{http_code}" http://localhost:3300/login
```
Expected: every job reports value `1` (UP); `http_requests_total` shows route labels; Loki lists services; Grafana returns `200`.

- [ ] **Step 4: Confirm the default profile stays lean**

Run:
```bash
docker compose config --services | sort
docker compose --profile observability config --services | sort
```
Expected: the first list does NOT contain `alloy`/`prometheus`/`loki`/`grafana`/`postgres-exporter`/`redis-exporter`; the second list DOES. (Confirms the profile gate.)

- [ ] **Step 5: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs(deploy): document observability profile and metrics env"
```

---

## Self-Review

**Spec coverage:**
- §4.1 new Compose services → Tasks 4, 5, 6, 7. ✓
- §4.2 API `/metrics` (prom-client, RED middleware, internal listener) → Tasks 1, 2. ✓
- §4.3 Alloy config (logs + metrics pipelines) → Task 6. ✓
- §4.4 ClickHouse Prometheus endpoint → Task 3. ✓
- §4.5 Grafana provisioning → Task 7. ✓
- §5 networking/ports (Grafana 3300, /metrics internal, CH 9363 network-only) → Tasks 2, 3, 7. ✓
- §6 env vars → Tasks 1 (METRICS_ENABLED), 8. ✓
- §7 files touched → all covered. ✓
- §8 testing (unit + runbook) → Tasks 1, 2 (unit); Tasks 3–8 (runbook). ✓
- §10 decisions: profile-gate (Task 8 Step 4 verifies), API replica SD (Task 6 Step 3 verifies), pinned tags (all image refs pinned), bounded cardinality (Task 1 route-pattern label). ✓
- Out of scope by design: tracing (spec §9), dispatcher `/metrics`, alerting, Mimir. Not planned — correct.

**Placeholder scan:** No TBD/“handle errors”/“similar to Task N”; every code and config step shows complete content. ✓

**Type consistency:** `registry`, `httpRequestsTotal`, `httpRequestDuration`, `metricsMiddleware`, `env.METRICS_ENABLED` named identically across Tasks 1 and 2; datasource UID `prometheus` matches between Task 7 datasource and dashboard targets. ✓
