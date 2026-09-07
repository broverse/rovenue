# Self-host operator handbook

Everything that comes after day one: scaling past a single node, discovering
and using the monitoring that already ships, sizing ClickHouse/Kafka storage,
keeping partition maintenance actually running, pooling Postgres connections
sanely, disaster recovery arithmetic, and rotating secrets.

**Read this alongside, not instead of:**

- [`backup-restore.md`](./backup-restore.md) — what is backed up, restore
  order, the `ENCRYPTION_KEY` fingerprint hazard, the post-restore ClickHouse
  gap, the mandated quarterly test-restore. This document does not repeat any
  of that; §6 below only adds the RPO/RTO arithmetic on top of it.
- [`upgrade.md`](./upgrade.md) — expand/contract discipline, migration
  routing, ClickHouse migrations, Kafka-fed materialized-view recreation,
  rollback (forward-only migrations, so rollback means restoring the backup).
- [`deployment.md`](./deployment.md) — first install, secrets, image
  verification, Apple Pay, the asset origin. [`deployment-rehberi.md`](./deployment-rehberi.md)
  is the broader Turkish walkthrough and remains the reference for DNS/TLS
  (§9) and the optional Cloudflare edge cache (§10); §1 below reconciles its
  §11 (horizontal scaling) into English so the two stop drifting apart.
- [`docs/architecture/outbox-dispatcher.md`](../architecture/outbox-dispatcher.md)
  — *why* the API is stateless and the dispatcher is not.
- [`docs/runbooks/notifications.md`](../runbooks/notifications.md) — the
  existing scenario runbook for the notification pipeline specifically. §8
  below points at the runbooks for the scenarios *outside* notifications.

Every command below that was actually run against a live stack while writing
this document says so. Commands that weren't are labelled **NOT EXECUTED**.

---

## 1. Scaling

`api` is stateless and horizontally scalable. Two other services are **not**,
and the constraint is load-bearing enough to repeat verbatim from
[`deployment-rehberi.md` §11](./deployment-rehberi.md#11-yatay-ölçekleme-api):

> **`dispatcher` and `digest-scheduler` must never exceed one replica.**

Why, specifically:

- **`dispatcher`** is the single outbox→Kafka publisher
  (`OUTBOX_DISPATCHER_ENABLED=true` only on this service; `docker-compose.yml`
  forces it `false` everywhere else, and `dispatcher-guard.test.ts` asserts
  the contract in CI). Delivery is at-least-once by design — see
  [outbox-dispatcher.md](../architecture/outbox-dispatcher.md) — so a second
  dispatcher instance would not corrupt anything (migration `0012`'s
  query-time idempotent views already collapse duplicate `eventId`s before
  summation), it would just re-publish and waste ingest work. `replicas: 1`
  is set explicitly in `docker-compose.yml`.
- **`digest-scheduler`** uses a shared repeatable BullMQ `jobId`, which is
  already idempotent across replicas — but idempotent is not the same as
  free. A second replica ticks the same schedule and throws its work away;
  `docker-compose.yml` pins it to `replicas: 1` for exactly this reason.

Every other in-process worker (`notifier-worker`, `send-email-worker`,
`send-push-worker`, and the workers running inside `api` itself — expiry, fx,
webhook delivery, retention, cleanup, partition maintenance, scheduled
actions, funnel, custom-domain, rovi, refund-shield) is safe at N replicas:
each is either BullMQ jobId-idempotent or claims rows with `FOR UPDATE SKIP
LOCKED`. Scale `api` with:

```bash
API_REPLICAS=3 docker compose up -d api
```

Caddy round-robins across replicas via Docker's internal DNS; a managed load
balancer in front of Caddy works the same way. Before raising `API_REPLICAS`
much past 3, read §5 (Connection pooling) below — Postgres's connection
ceiling, not CPU, is what you hit first.

---

## 2. Monitoring and alerting

This is the section that exists because the gap wasn't "nothing shipped," it
was "everything shipped and nobody wrote down that it existed."

### What already runs

- **Metrics.** The API registers seven custom Prometheus metrics — verified
  against [`apps/api/src/lib/metrics.ts`](../../apps/api/src/lib/metrics.ts):

  | Metric | Type | What it means |
  |---|---|---|
  | `http_requests_total` | Counter | Every request, labelled `method`/`route`/`status` (route = the matched pattern, never the raw path — keeps cardinality bounded) |
  | `http_request_duration_seconds` | Histogram | Request latency; `500ms` is a real bucket boundary because the latency SLO is defined against it |
  | `rovenue_webhook_replay_guard_failopen_total` | Counter | The webhook replay dedup guard failed open on a Redis error — events are being processed without dedup for as long as this is non-zero |
  | `rovenue_webhook_events_reclaimed_total` | Counter | The reaper found `webhook_events` rows stuck in `PROCESSING` from a dead process |
  | `rovenue_access_drift_detected_total` | Counter, by `class` | Subscribers whose `subscriber_access` disagreed with `computeDesiredAccess` |
  | `rovenue_access_drift_healed_total` | Counter | Subscribers the reconciler actually rewrote |
  | `rovenue_access_drift_circuit_breaker_total` | Counter | The reconciler refused to auto-heal a sweep because its drift ratio exceeded threshold — the metric's own source comment says "ALERT ON ANY NON-ZERO VALUE" |

  Plus `prom-client`'s Node/process/event-loop/GC defaults (e.g.
  `nodejs_eventloop_lag_seconds`, `process_resident_memory_bytes`).

  Served at `GET /metrics` on the **internal** listener only
  (`apps/api/src/internal-app.ts`, port `INTERNAL_PORT`/3001 — not published
  in `docker-compose.yml`'s `ports:`), gated by `METRICS_ENABLED` (defaults
  `true`, `.env.example`).

- **Alerting rules.** [`deploy/prometheus/rules/slo.yml`](../../deploy/prometheus/rules/slo.yml)
  defines two SLOs against those metrics — an **availability SLO** (99.9%
  non-5xx over 30 days) and a **latency SLO** (99% under 500ms over 30 days)
  — each with Google-SRE-workbook-style multi-window, multi-burn-rate
  alerts, plus a **correctness** group that pages on
  `RovenueAccessDriftCircuitBreakerTripped` (any non-zero increase, no
  delay) and tickets on drift step-changes, the replay guard failing open,
  and pods dying mid-webhook. Verified executable: `promtool check rules`
  against this file reports **"SUCCESS: 25 rules found"** (14 recording
  rules across the two SLIs' seven windows each, 11 alerting rules).

- **Dashboards.** `deploy/grafana` auto-provisions a dashboard titled
  **"Rovenue API — RED"** (`deploy/grafana/dashboards/rovenue-api-red.json`,
  confirmed valid JSON, 4 panels: request rate by route, 5xx rate, p50/p95/p99
  latency, event-loop lag + RSS) into a "Rovenue" folder
  (`deploy/grafana/provisioning/dashboards/dashboards.yaml`), with Prometheus
  and Loki wired as datasources
  (`deploy/grafana/provisioning/datasources/datasources.yaml`).

- **Logs & infra metrics.** `deploy/alloy/config.alloy` tails every
  container's stdout via Docker service discovery and ships it to Loki
  (lifting Pino's `level` into an indexed label, `msg`/`requestId` as
  structured metadata), and scrapes `redpanda:9644`, `clickhouse:9363`,
  `postgres-exporter:9187`, `redis-exporter:9121`, and `api:3001` into
  Prometheus via remote-write.

None of this is behind a special flag — it's the `observability` Compose
profile, off by default so a bare `docker compose up` doesn't pay its
resource cost:

```bash
COMPOSE_PROFILES=observability docker compose up -d
# Grafana: http://<host>:3300 (GF_SECURITY_ADMIN_USER/PASSWORD, default admin/admin — change it)
```

**NOT EXECUTED against this session's stack**: bringing up the full
`observability` profile end-to-end (Grafana rendering live panels, Alloy
shipping real logs). The stack available while writing this was `db`,
`redis`, `clickhouse`, `redpanda` only — no `api`, so there was no live
`/metrics` endpoint to scrape. What *was* independently verified:
`promtool check rules` against the real rule file (above), the dashboard
JSON's validity and panel queries against the real metric names in
`metrics.ts`, and the provisioning YAML's shape.

### What does not exist — say it plainly

**No Alertmanager is wired into `docker-compose.yml`.** There is no
`alertmanager` service, and `deploy/prometheus/prometheus.yml` has no
`alerting:` block (verified: it's one `global:` section plus a
`rule_files:` glob, nothing else). The rules above **evaluate** — they show
up as firing/pending in Prometheus's own UI and in Grafana — but nothing
**routes** them anywhere. An alert labelled `severity: page` reaches exactly
nobody until an operator adds an Alertmanager and points
`prometheus.yml`'s `alerting.alertmanagers` at it, or wires Grafana's own
contact points (Grafana can alert directly off the same Prometheus
datasource without a separate Alertmanager, which is the lower-effort
option for a single-node self-host). Both `slo.yml` and `prometheus.yml`
already carry this same comment in their source — this handbook is the
first place it's said to an operator instead of to the next engineer
reading the config.

**The Alloy API scrape target is static, not service-discovered.**
`deploy/alloy/config.alloy`'s `prometheus.scrape "infra"` block hardcodes
`{ __address__ = "api:3001", job = "rovenue-api" }`. That's correct for the
default `API_REPLICAS=1` topology — Docker's internal DNS round-robins a
single scrape to *some* replica — but once `API_REPLICAS>1` (§1), a static
target scrapes only one replica's process-level metrics
(`nodejs_eventloop_lag_seconds`, `process_resident_memory_bytes`) at a time,
though `http_requests_total`/`http_request_duration_seconds` still reflect
whichever replica Caddy routed the request to, not necessarily the one
Alloy is scraping — the two are decoupled once there's more than one
process. The file's own comment already names the fix: switch to
`discovery.docker` + a `discovery.relabel` block keeping containers where
`com_docker_compose_service == "api"`, rewriting the container's per-network
IP meta-label to `__address__:3001` (the file explains why the
network-name-dependent label doesn't work reliably in Alloy v1.4.2). Not
implemented — this handbook is the place that tells you it needs to be, the
day you set `API_REPLICAS>1`.

### Health endpoints (for external probes, not Prometheus)

Read from [`apps/api/src/routes/health.ts`](../../apps/api/src/routes/health.ts):

| Endpoint | Checks | Use it for |
|---|---|---|
| `GET /health` | Nothing — never touches Postgres or Redis | Container liveness probe |
| `GET /health/ready` | Postgres (`SELECT 1`), Redis (`PING`), the `webhook`/`delivery`/`fx` BullMQ queues' job counts, and whether FX rates are stale (>24h) | Readiness probe — returns `503` if anything is down, so a load balancer stops routing to this instance |
| `GET /health/stores?projectId=` | Per-project Apple/Google/Stripe credential presence, last processed webhook timestamp per store, and circuit-breaker state — dashboard-auth only | Debugging a specific project's store connection from the dashboard, not an infra probe |

---

## 3. Capacity planning

### ClickHouse

Every raw event table carries a **2-year hot TTL**
(`TTL toDateTime(...) + INTERVAL 2 YEAR DELETE`), verified across
`packages/db/clickhouse/migrations/000{2,4,5,9}*.sql` and `0017` (exposures,
revenue, credit, sdk-session-events, paywall-events) and the daily-aggregate
materialized views built on top of them. This is a hot analytics window, not
your authoritative record — Postgres holds the 7-year VUK-retention copy of
revenue/credit history via pg_partman (§4). Budget ClickHouse disk for 2
years of event volume at your own traffic, not indefinite growth.

Checking current size (**run from inside the compose network** — ClickHouse's
allow-list rejects Docker-Desktop-forwarded host traffic; see
[backup-restore.md](./backup-restore.md#two-things-easy-to-get-wrong)):

```bash
# The bare default user has no password set up in this stack's
# users.d config — auth as the write user (rovenue) or the reader
# (rovenue_reader), same credentials .env already has. The
# database='rovenue' filter on every query below is load-bearing —
# see the callout after the output for why.
docker compose exec clickhouse clickhouse-client --user rovenue --password "$CLICKHOUSE_WRITE_PASSWORD" --query "
  SELECT formatReadableSize(sum(bytes_on_disk)) AS total_size, count() AS parts
  FROM system.parts WHERE active AND database='rovenue'"

docker compose exec clickhouse clickhouse-client --user rovenue --password "$CLICKHOUSE_WRITE_PASSWORD" --query "
  SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(rows) AS rows
  FROM system.parts WHERE active AND database='rovenue'
  GROUP BY table ORDER BY sum(bytes_on_disk) DESC"

docker compose exec clickhouse clickhouse-client --user rovenue --password "$CLICKHOUSE_WRITE_PASSWORD" --query "
  SELECT name, formatReadableSize(free_space) AS free, formatReadableSize(total_space) AS total
  FROM system.disks"
```

**Executed** against this session's dev stack (`docker exec rovenue-clickhouse-1
clickhouse-client --user rovenue --password rovenue --query ...` — the dev
default for both `CLICKHOUSE_WRITE_PASSWORD` and the SHA-256 hash it must
match; there was no `api`/compose project running to `exec` through, and a
bare unauthenticated `clickhouse-client --query "SELECT 1"` was tried first
and confirmed to fail with `AUTHENTICATION_FAILED` — the `default` user has
no working password in this stack's `users.d` config, so the `--user
rovenue` form above is not optional): total active data in the `rovenue`
database was **400.10 KiB across 26 parts** — a seed-scale dev database,
not a sizing reference.

**Filter on `database='rovenue'` explicitly, and check the total, not just
the per-table breakdown, against it.** An earlier draft of this section
reported a total of 1.56 GiB across ~130 parts — that number is real, but
it's ClickHouse's own internal `system` database (`query_log` and
friends), not `rovenue`'s actual data, confirmed live:

```
SELECT database, formatReadableSize(sum(bytes_on_disk)), count()
  FROM system.parts WHERE active GROUP BY database ORDER BY 2 DESC;
  system    1.56 GiB   114
  rovenue   400.10 KiB  26
```

The per-table query above already carried the `database='rovenue'` filter
and was always correct (`raw_revenue_events` at 322.28 KiB / 1257 rows,
matching exactly); the total quoted alongside it had been read off a
separate, unfiltered query. Run the corrected total query above against
your own install, with the filter, before trusting the number. There is no
built-in retention alarm, so watch `system.disks`' free space yourself (or
scrape it — `clickhouse:9363` is already an Alloy target, §2).

The `clickhouse` service is capped at `cpus: 2, mem_limit: 3g` in
`docker-compose.yml` — raise both together if `system.parts` shows sustained
growth pushing query latency up; ClickHouse degrades by slowing down before
it falls over.

### Kafka / Redpanda

Verified live against this session's `rovenue-redpanda` container
(`rpk topic list`, `rpk topic describe rovenue.revenue`, `rpk cluster config
get log_retention_ms`):

| Topic | Partitions | Replicas |
|---|---|---|
| `rovenue.billing`, `.credit`, `.exposures`, `.funnel`, `.notifications`, `.revenue`, `.sdk-sessions`, `.subscription` | 3 | 1 |
| `rovenue.paywall_events` | 1 | 1 |

Replication factor 1 across the board is intentional at this scale —
`docker-compose.yml`'s own comment on the `redpanda` service argues a
single-node broker beats Kafka+ZooKeeper+Schema-Registry on ops weight for a
self-hosted install, and Rovenue doesn't need multi-broker durability yet.
It does mean **no broker-level redundancy**: losing the one Redpanda
container's volume loses whatever hasn't been consumed into ClickHouse yet
(the durable record is `outbox_events` in Postgres pre-dispatch and the
ClickHouse raw tables post-dispatch — see
[outbox-dispatcher.md](../architecture/outbox-dispatcher.md) — Redpanda
itself is a relay, not a system of record).

**Cluster-wide retention is 7 days** (`log_retention_ms = 604800000`,
verified live; no per-topic override — `rpk topic describe` shows
`initial.retention.local.target.ms -1`, i.e. inherits the cluster default).
This number matters beyond "how much disk Redpanda uses" — it's the hard
ceiling on [backup-restore.md's ClickHouse-gap replay
remedy](./backup-restore.md#the-clickhouse-analytics-gap-after-a-restore):
if more than 7 days elapse between the backup being taken and the restore
being performed, the consumer-group offset the replay needs has already
aged out of the topic, and the gap is permanently unrecoverable — see §6
below for how this bounds disaster-recovery arithmetic.

`redpanda` is capped at `cpus: 2, mem_limit: 2g` in `docker-compose.yml`
(with `--memory=1G --reserve-memory=0M` passed to the binary itself, leaving
headroom under the container limit for page cache). Raise the topic
partition count (`rpk topic alter-config` / re-create with more partitions)
before raising broker count if a single topic's consumer throughput becomes
the bottleneck — partitions parallelize a Kafka Engine table's ingestion,
replicas add durability this deployment doesn't currently use.

### Compose resource limits, for reference

Every service in `docker-compose.yml` sets `cpus:`/`mem_limit:` explicitly
(verified by reading the file in full):

| Service | cpus | mem_limit |
|---|---|---|
| `db` | 2 | 2g |
| `clickhouse` | 2 | 3g |
| `redpanda` | 2 | 2g |
| `api` (×`API_REPLICAS`) | 2 | 2g |
| `dispatcher`, `notifier-worker`, `digest-scheduler`, `send-email-worker`, `send-push-worker` | 1 each | 1g each |
| `migrate` | 2 | 2g |
| `minio` | 1 | 1g |
| `redis` | 0.5 | 512m |
| `dashboard`, `docs` | 0.5 each | 512m each |
| `caddy` | 0.5 | 256m |
| `redpanda-console` | 0.5 | 512m |
| `minio-init` | 0.5 | 512m |
| Observability profile: `prometheus`, `loki`, `grafana` | 1 each | 2g / 2g / 1g |
| Observability profile: `alloy` | 0.5 | 512m |
| Observability profile: `postgres-exporter`, `redis-exporter` | 0.25 each | 256m each |

Sum the row for whatever you actually run before sizing a host. Default
boot (no observability, `API_REPLICAS=1`, excluding the transient
`migrate`/`minio-init` one-shots) totals **16.5 vCPU / ~17.3 GiB** of
limits — not a load estimate, a ceiling each container is capped at. Adding
the `observability` profile (`prometheus`+`loki`+`grafana`+both exporters+
`alloy`) adds another **4 vCPU / ~6 GiB** of ceiling on top.

---

## 4. pg_partman partition maintenance

This has previously **never once completed successfully** in this repo's
history — three independent bugs stacked (`SELECT` on a `PROCEDURE`, a
bound-parameter INSERT that Postgres rejects at parse time before `IF NOT
EXISTS` can short-circuit, and — the one this section is really about — a
fresh-install database silently having a different partition-management
story than an upgraded one). All three are fixed in
[`apps/api/src/workers/partition-maintenance.ts`](../../apps/api/src/workers/partition-maintenance.ts)
today, but "fixed" only means "the verification query below returns
something," not "you can skip checking." Read the file's own comments; this
runbook adds the operational half.

### What it does, and on which tables

Runs daily at 03:00 UTC via a BullMQ repeatable job
(`rovenue-partition-maintenance`), and does two independent things:

1. `CALL partman.run_maintenance_proc()` — premakes upcoming partitions and
   drops retention-aged ones for every table pg_partman actually knows
   about (`partman.part_config`).
2. Hand-rolls the next 13 months of monthly partitions for
   `outgoing_webhooks`, which is deliberately **not** partman-managed (its
   retention predicate is composite — status + age — and stays on the
   existing webhook-retention worker).

### The fresh-install divergence — closed by migration 0130

This section used to tell you to run `partman.create_parent` by hand before
2029. **You no longer have to, and you should not.** Migration `0130` does it,
on both install paths. What follows is the history, because you will still see
two different partition NAMING schemes on the same table and it is easier to
read a hand-inspected partition list knowing why.

`revenue_events` and `credit_ledger` are the two tables migration `0019`
registers with pg_partman. `0019` is one of eleven specific migrations the
fresh-install runner (`packages/db/src/fresh-install.ts`'s
`TIMESCALE_LEGACY_TAGS`) marks applied **without executing**, on any database
that never ran against the old `timescale/timescaledb` image — which is every
self-hosted install starting fresh against the shipped `postgres:16-bookworm`
image. **The skip set is sparse, not a contiguous range**: `0001`–`0007`,
`0009`, `0010`, `0014`, and `0019` — eleven of the nineteen migrations between
`0001` and `0019`. `0008`, `0011`–`0013`, and `0015`–`0018` all execute
normally on a fresh install. On those databases:

- `revenue_events`/`credit_ledger` still get partitioned — migrations
  `0015`/`0016` **do execute** and bulk pre-create 60 monthly partitions
  covering **2024-01 through 2028-12**, named `revenue_events_2024_01` …
  `revenue_events_2028_12`. `fresh-install.ts` rewrites their upgrade-path
  `RENAME`-to-`_legacy_hypertable` statement into a no-op first
  (`PARTITION_RENAME_TAGS`), since a fresh install has no legacy hypertable
  to rename away — the partitioning itself still runs.
- Until migration `0130`, that was the end of the story: both tables were
  absent from `partman.part_config`, nothing premade a 2029 partition, and
  neither table had a default partition — so an insert dated 2029-01-01 or
  later failed outright with `no partition of relation "revenue_events"
  found for row`. A dated outage, documented here as an operator chore.

**What `0130` changes.** It registers both parents starting at the first month
the hand-made children do not already cover (computed from the catalog, so no
proposed range can collide with a hand-made child — that collision,
`partition "revenue_events_p20240101" would overlap partition
"revenue_events_2024_01"`, is exactly why `0019` could not simply be
un-skipped). From then on `partman.run_maintenance_proc()` — already called
daily by the partition-maintenance worker — keeps a 12-month premake window
rolling forward. Nothing to run by hand, on either install path.

Two consequences worth knowing before you inspect partitions by eye:

- **Two naming schemes on one table.** `revenue_events_2024_01` … `_2028_12`
  are the hand-made children from `0015`; `revenue_events_p20290101` onward
  are pg_partman's. This is cosmetic — partman resolves a set from
  `pg_inherits` + partition bounds, not from names, so it reads the hand-made
  children correctly and continues past them.
- **There is now a default partition** (`revenue_events_default`,
  `credit_ledger_default`), created by `create_parent` exactly as it already
  was for `funnel_sessions`/`funnel_answers`/`integration_deliveries`. A row
  dated beyond the premake window lands there instead of failing — but
  Postgres will then refuse to attach the real partition for that month, so a
  stranded row turns an immediate error into a later maintenance failure.
  `SELECT * FROM partman.check_default();` reports the count; it should be
  zero, and a non-zero value is a thing to fix, not to ignore.

**Retention is deliberately NOT enabled on these two parents.** `0019` intended
`retention = '7 years'`; `0130` leaves `retention` NULL and clears the value
`0019` left on upgrade-path databases. `apps/api/src/workers/retention-sweep.ts`
owns dropping these two tables (`DROP_PARTITION` in
`packages/shared/src/retention/policies.ts`): it drops a partition only at the
longest window any project resolved, only when every project resolved one, and
writes a per-project audit row into that project's hash chain first. Its floors
are 365 days for both tables — far shorter than 7 years — so partman retention
could only ever be a second, unconditional, unaudited dropper racing it. **Do
not set `partman.part_config.retention` on `public.revenue_events` or
`public.credit_ledger`.**

`outgoing_webhooks` remains deliberately unregistered: its retention predicate
is composite (status AND age), so a whole month is never uniformly expired, and
the partition-maintenance worker hand-creates its months.

### The verification query

Don't infer success from "the worker didn't log an error" — a skipped
partman call on a table not in `part_config` also logs nothing alarming.
Query pg_partman's own bookkeeping instead:

```sql
SELECT parent_table, premake, retention, retention_keep_table,
       infinite_time_partitions, maintenance_last_run
  FROM partman.part_config
 ORDER BY parent_table;
```

**Executed** against a database built from migrations on this repo's own
image (`deploy/postgres`). Real output — five parents, and `retention` is
NULL on the two migration `0130` registers, by design (see above):

```
         parent_table          | premake | retention | infinite_time_partitions
-------------------------------+---------+-----------+--------------------------
 public.credit_ledger          |      12 |           | t
 public.funnel_answers         |       4 | 18 months | t
 public.funnel_sessions        |       4 | 18 months | t
 public.integration_deliveries |       7 | 30 days   | f
 public.revenue_events         |      12 |           | t
```

(`maintenance_last_run` is NULL on a database whose maintenance job has never
run, as a freshly-migrated one is; on a live install it is the column to
check, below.)

A `maintenance_last_run` within the last ~25 hours (the job runs daily at
03:00 UTC) is a pass; a `NULL` or stale timestamp means either the worker
isn't running (check the `api` process logs for `partition maintenance
worker started`) or the BullMQ repeatable job was never scheduled
(`schedulePartitionMaintenance()` runs once at boot — confirm it was called).
This query is more reliable than checking BullMQ's own job history in
Redis: `runPartitionMaintenance()` can also be invoked directly (a test, a
manual `tsx` call) without going through the queue at all, which updates
`part_config` but leaves no BullMQ trace — `part_config` is pg_partman's own
source of truth regardless of how maintenance was triggered.

If `public.revenue_events` or `public.credit_ledger` is missing from the
output, migration `0130` has not been applied (or its availability guard
skipped because the server has no pg_partman — it says so with a `0130
SKIPPED` notice naming the consequence). Run `pnpm db:migrate` and re-check;
until then those tables' partitions still stop at 2028-12. Anything else
missing that you expected pg_partman to manage is a problem in its own
migration.

---

## 5. Connection pooling

Nothing in this repo documents pool sizing today. Here's the arithmetic,
derived from [`packages/db/src/drizzle/pool.ts`](../../packages/db/src/drizzle/pool.ts)
and each service's entrypoint.

- Every process that talks to Postgres calls `getPool()`, a singleton `pg`
  `Pool` with **`max: 10`**, hardcoded in `DEFAULT_POOL_OPTIONS`. There is
  **no environment variable that overrides this today** — the module's own
  comment says real deployments can override via `DATABASE_URL
  ?connection_limit=…`, but `connection_limit` is a Prisma convention, not
  one `node-postgres`'s `Pool` reads; grepping the codebase confirms nothing
  parses that query parameter. Treat that comment as aspirational, not
  load-bearing, until someone wires it up — every process pools at exactly
  10 connections today, full stop.
- `api` additionally opens a **second, separate** pool for import-job
  advisory locks (`apps/api/src/workers/import-runner.ts`), sized
  `WORKER_CONCURRENCY + 2 = 7`, created lazily on the first import run and
  drained back down after ~30s idle. It exists specifically so a
  long-running import lock doesn't starve the shared pool's 10 connections
  — it does not exist on any process other than `api`.

Steady-state connection count, with no import running:

| Service | Replicas | Connections |
|---|---|---|
| `api` | `API_REPLICAS` | `10 × API_REPLICAS` |
| `dispatcher`, `notifier-worker`, `digest-scheduler`, `send-email-worker`, `send-push-worker` | 1 each | `10 × 5 = 50` |
| `migrate` | transient, only during a deploy | `10` (briefly) |

**Total ≈ `10 × API_REPLICAS + 50`**, plus up to `7 × API_REPLICAS` more
while an import job is actively running on any replica.

Postgres's `max_connections` is **100** — the Postgres 16 default, not
overridden anywhere in `deploy/postgres/{Dockerfile,init.sql}` or
`docker-compose.yml` (verified live: `SHOW max_connections;` against this
session's `rovenue-db-1` returned `100`). Plug in the formula:

| `API_REPLICAS` | Steady-state total | Headroom under 100 |
|---|---|---|
| 1 | 60 | 40 |
| 2 | 70 | 30 |
| 3 | 80 | 20 |
| 4 | 90 | 10 |
| 5 | 100 | **0** — no room for `migrate`, an admin `psql`, an exporter, or an active import |

**Recommendation:** don't run `API_REPLICAS` above 3 without also raising
`max_connections` (no config file currently sets it — you'd be adding one,
e.g. a custom `postgresql.conf` mounted into the `db` service) or fronting
Postgres with a transaction-mode pooler (PgBouncer or equivalent — not
present in this stack today). Above `API_REPLICAS=4`, headroom is thin
enough that a single concurrent import plus a manual `psql` session can
exhaust `max_connections` and start rejecting connections stack-wide.

---

## 6. Disaster recovery — RPO and RTO

This stack does not ship a disaster-recovery guarantee, because RPO and RTO
are not properties of the software — they're a direct function of how often
*you* run `backup.sh` and how fast *you* can stand up a replacement host.
[`backup-restore.md`](./backup-restore.md#quarterly-test-restore) says this
explicitly ("this document does not implement rotation... pick a retention
window") for backup retention, and the same honesty applies here: this
section states the arithmetic, not an invented number.

### RPO (Recovery Point Objective — how much data you can lose)

RPO ≈ your backup interval, plus the backup job's own runtime margin (data
written *during* a backup that crashes mid-run isn't captured, so the true
worst case is "since the last **successful** backup completed," not "since
the last backup started"). `backup-restore.md`'s own example cron runs
nightly at 03:15 UTC:

```
RPO ≈ 24 hours + backup.sh's own runtime (Postgres dump + ClickHouse BACKUP + asset mirror)
```

Run backups more often (hourly, every 4h) to shrink this — nothing about
`backup.sh`/`restore.sh` assumes a nightly cadence, that's just the example
in the cron line. Postgres/ClickHouse/asset-bucket size and I/O are what
actually bound how *frequently* you can run it without the backup job
itself becoming the bottleneck; measure `backup.sh`'s own wall-clock time on
your install before committing to a cadence tighter than it can finish in.

**A second, sharper ceiling applies specifically to the ClickHouse
analytics gap** (`backup-restore.md`'s "T0–T1" replay remedy): that remedy
only works if Redpanda's consumer-group offset for the affected topic
hasn't aged out of retention yet. §3 above verified this cluster's
**default retention is 7 days** (`log_retention_ms=604800000`, live). If the
elapsed time between the backup (`T0`) and the restore exceeds 7 days, the
offset is already gone and that specific gap is **permanently
unrecoverable** — not a matter of trying harder, per `backup-restore.md`'s
own "Precondition" paragraph. This doesn't change your Postgres/asset RPO
(those don't depend on Redpanda retention at all), but it does mean: the
longer you wait to actually perform a restore after an incident, the more
of the ClickHouse-analytics RPO promise quietly evaporates. Don't sit on a
backup once you know you need to restore from it.

### RTO (Recovery Time Objective — how long a restore takes)

**Not benchmarked anywhere in this repo.** `restore.sh` has no published
runtime, and this handbook will not invent one — it depends on your
Postgres/ClickHouse/asset-bucket size, your host's I/O, and network
distance to wherever the backup archive lives. What RTO actually is, for
your install, is: (time to provision a replacement host + pull/build
images) + (`restore.sh`'s wall-clock time, in the Postgres → assets →
ClickHouse order `backup-restore.md` documents and does not skip) +
(verification: the row-count checks, `db:verify:clickhouse`, the audit-chain
script, all in `backup-restore.md`'s quarterly procedure).

The quarterly test-restore `backup-restore.md` already mandates is the
*only* honest way to know this number — measure it there, on your actual
data volume, rather than assuming. If your quarterly test-restore doesn't
currently record how long the whole procedure took, start recording it: an
untimed test-restore proves the backup is restorable, but not that you know
your own RTO.

---

## 7. Secret and key rotation

Two other documents in this repo refer to key rotation as "a separate
runbook" (`integrations-manual-qa.md`'s pre-deployment checklist, and
`backup-restore.md`'s retention disclaimer, in spirit). It didn't exist.
See [`docs/runbooks/secret-rotation.md`](../runbooks/secret-rotation.md).

The short version: most secrets in `.env.example` rotate by "generate a new
value, update `.env`, restart the affected service(s)" — no data
migration involved. **`ENCRYPTION_KEY` is the one exception**, and it is
hazardous precisely because of the fingerprint-match hazard
[`backup-restore.md`](./backup-restore.md) already documents for restores:
rotating it without re-encrypting every stored credential in place first
breaks every future receipt verification silently, and — separately —
means any backup taken under the old key can no longer be restored into an
environment now running the new one without deliberately keeping the old
key around too. The runbook covers the order of operations, and states
plainly that the repo's existing `scripts/rotate-encryption-key.ts` does
not currently run (verified: `pnpm --filter @rovenue/scripts typecheck`
fails against it today) — do not point an operator at it as-is.

---

## 8. Incident runbooks

[`docs/runbooks/notifications.md`](../runbooks/notifications.md) is the only
scenario runbook that existed before this handbook, scoped to the
notification pipeline. The alerts in §2 above fire on different subsystems
that had no runbook at all. See
[`docs/runbooks/incident-response.md`](../runbooks/incident-response.md) for
a scenario per alert: what each one actually means, how to confirm it
against live data, and where to look first.
