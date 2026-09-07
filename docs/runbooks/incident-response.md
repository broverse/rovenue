# Incident response — the alerts in `slo.yml`

[`notifications.md`](./notifications.md) is the only other scenario runbook
in this repo, scoped to the notification pipeline. This one covers the
alerts `deploy/prometheus/rules/slo.yml` actually defines — verified against
that file — none of which had a runbook before this one. Read
[the operator handbook §2](../operations/handbook.md#2-monitoring-and-alerting)
first if you haven't: **none of these alerts page anyone** until you wire up
an Alertmanager or a Grafana contact point. Until then, this runbook is what
you check when *watching* the Grafana dashboard or Prometheus's own alert
list, not something a pager wakes you up for.

Every PromQL snippet below is copied from `slo.yml`, not paraphrased —
cross-check against the file if in doubt. **NOT EXECUTED**: every `curl`/
`docker compose logs`/`docker stats` command in this file — the stack
available while writing it had no running `api` or `prometheus` container
(no live requests to alert on, no Alertmanager to route through either).
The thresholds, `for:` delays, and metric/label names are verified against
`slo.yml` and `metrics.ts` directly; the commands themselves are untested
against a live incident.

## API 5xx rate — availability SLO

**Alerts:** `RovenueApiErrorBudgetBurningFast` (`severity: page`, 1h+5m
windows both > 1.44%), `RovenueApiErrorBudgetBurning` (`page`, 6h+30m > 0.6%),
`RovenueApiErrorBudgetDepleting` (`ticket`, 1d+2h > 0.3%),
`RovenueApiErrorBudgetSlowBurn` (`ticket`, 3d+6h > 0.1%).

**What it means:** the fraction of requests returning 5xx (never 4xx — a
rejected key or a malformed body doesn't burn this budget) is high enough
that, at the current rate, the 30-day 99.9%-availability budget runs out
before the 30 days do. The "Fast"/"Burning" pair pages because a hard outage
burns the budget in hours; "Depleting"/"SlowBurn" ticket because a slow,
sustained low-grade failure rate is a different kind of problem (an owner
during business hours, not 3am).

**Confirm:**

```bash
# The same numbers Prometheus is alerting on, queried directly:
curl -s 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=sum(rate(http_requests_total{status=~"5.."}[5m])) by (route)' \
  | jq '.data.result'

# Which routes are failing, and with what status:
curl -s 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=topk(5, sum by (route, status) (rate(http_requests_total{status=~"5.."}[5m])))' \
  | jq '.data.result'
```

Cross-check against `/health/ready` on the affected instance(s) — a 5xx
storm caused by a downstream dependency (Postgres, Redis, a store API) will
usually show `"status": "degraded"` there too, with the specific check
that's failing named in the response (see the operator handbook's health
endpoint table).

**Resolve:**

1. If a specific route dominates the `topk` query above, check that route's
   recent deploy — a schema-drift or a bad migration on `expand/contract`
   discipline (`upgrade.md` §5) is the most common cause of a step-change in
   5xx rate right after a rollout.
2. If `/health/ready` shows a downstream dependency down (`database`,
   `redis`, a queue), that dependency's own runbook applies — this alert is
   the symptom, not the cause.
3. If a specific store's circuit breaker is open (`GET
   /health/stores?projectId=...`, dashboard-auth), the 5xx rate may be
   concentrated in store-webhook-processing routes while the breaker
   recovers — expected during a real Apple/Google/Stripe outage, not
   necessarily a Rovenue-side bug.
4. Once the root cause is fixed, the alert clears on its own — the burn-rate
   windows are short-lived (the `for:` delays are 2m/15m/1h/3h respectively)
   and the recording rules recompute every 30s.

## API latency — latency SLO

**Alerts:** `RovenueApiLatencyBudgetBurningFast` (`page`, 1h+5m > 14.4%
slow), `RovenueApiLatencyBudgetBurning` (`page`, 6h+30m > 6% slow),
`RovenueApiLatencyBudgetDepleting` (`ticket`, 1d+2h > 3% slow). "Slow" means
over the 500ms bucket boundary — a real histogram bucket in
`http_request_duration_seconds`, chosen deliberately so the SLI doesn't
interpolate a threshold that isn't a bucket edge.

**Confirm:**

```bash
curl -s 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))' \
  | jq '.data.result | sort_by(.value[1] | tonumber) | reverse | .[0:5]'
```

Names the slowest routes by p95 over the last 5 minutes.

**Resolve:**

1. A single slow route usually means an added/regressed query — check
   whether it touches ClickHouse (`FINAL` reads over `raw_revenue_events`
   etc. are the most expensive query shape in this codebase — see
   [outbox-dispatcher.md](../architecture/outbox-dispatcher.md)) or a large
   unindexed Postgres scan.
2. A latency spike across *every* route more often points at resource
   contention: check `docker stats` against the `cpus:`/`mem_limit:` caps
   in the [operator handbook's capacity table](../operations/handbook.md#compose-resource-limits-for-reference)
   — a container pinned at its CPU limit degrades every route it serves,
   not just one.
3. If `API_REPLICAS>1`, confirm the slowdown isn't isolated to one replica
   (§5/§1 in the handbook) — Alloy's static scrape target only sees one
   replica's process metrics at a time, so a single struggling replica can
   hide behind healthy siblings in the dashboard while still contributing
   to the aggregate `http_request_duration_seconds` used by this alert.

## `RovenueAccessDriftCircuitBreakerTripped` — pages immediately, no delay

**What it means:** the entitlement drift reconciler found more disagreement
between `subscriber_access` and `computeDesiredAccess` in one sweep than
`MAX_DRIFT_HEAL_RATIO` allows, and **refused to auto-heal**. This is either
mass entitlement corruption or a bug in `computeDesiredAccess` itself — the
alert's own annotation says entitlement data is untrustworthy either way,
which is why it pages on the very first occurrence with no `for:` delay.

**Confirm:** the reconciler doesn't write drift findings to a table — it
logs the sweep that tripped the breaker as a structured `error` line
(`apps/api/src/workers/access-reconciliation.ts`), with the full per-class
breakdown and the ratio that exceeded `MAX_DRIFT_HEAL_RATIO` (0.05):

```bash
docker compose logs api | grep "entitlement drift ratio above threshold"
# The matching line's JSON fields include: drifted, candidates, ratio,
# threshold, and drift (the per-class counts).
```

```bash
# Historical rate by class, if you need it beyond the one sweep that tripped:
curl -s 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=sum by (class) (increase(rovenue_access_drift_detected_total[1h]))' \
  | jq '.data.result'
```

**Resolve:**

1. **Do not manually flip the circuit breaker back on to force a heal.**
   The breaker tripped because the batch's drift ratio said the data isn't
   trustworthy — forcing a heal writes what might be *wrong* entitlements
   over every affected subscriber.
2. Read the reconciler's logs for the sweep that tripped it — it names the
   drift class breakdown. A single dominant class (e.g. every drifted row
   sharing the same recent deploy timestamp) points at a code regression in
   `computeDesiredAccess`; a broad, unpatterned spread points at a genuine
   data incident (a bad backfill, a botched manual `UPDATE`).
3. Fix the root cause first. Only after you're confident the *desired*
   state computation is correct again should the reconciler be allowed to
   heal — that may mean redeploying a fix and letting the next scheduled
   sweep run clean, or manually re-running the reconciler in dry-run mode
   first if one exists.
4. This alert clearing on its own (no more increases) does not mean the
   underlying drift is fixed — it only means no *new* over-threshold sweep
   has happened. Confirm via the drift-detected rate (`rovenue_access_drift_detected_total`)
   trending back to its pre-incident baseline before considering this closed.

## `RovenueAccessDriftStepChange` — ticket, 30m sustained

**What it means:** `rovenue_access_drift_detected_total`'s rate over the
last hour is more than 5x the same hour yesterday
(`slo.yml`'s exact comparison: `rate(...[1h]) > 5 * rate(...[1d] offset
1d)`). A low steady rate is normal (a sweep can race a live webhook); a
step change means an ingestion path stopped calling `syncAccess`.

**Confirm:** identify what changed in the last hour — a deploy, a new
webhook source, a paused worker. Cross-reference against
`rovenue_webhook_events_reclaimed_total` (below) and each store's
`lastWebhookAt` via `/health/stores` — a store whose webhooks stopped being
processed will show both a stale `lastWebhookAt` and a rising drift rate
for subscribers on that store.

**Resolve:** find the code path that stopped calling `syncAccess` (usually
traceable to whatever deployed in the window the step change started) and
fix it. The reconciler will catch back up on its own once the ingestion
path is healed — it heals drift, it doesn't just detect it — but the
backlog it heals through is exactly the size of the gap, so expect elevated
`rovenue_access_drift_healed_total` for a while after the fix ships.

## `RovenueWebhookReplayGuardFailingOpen` — ticket, 10m sustained

**What it means:** the webhook replay dedup guard can't reach Redis and is
failing open — admitting webhook events without a dedup check, trading
availability for correctness on purpose. While this lasts, a replayed store
webhook (Apple/Google/Stripe retrying an already-processed event) is
processed **twice**.

**Confirm:**

```bash
docker compose exec redis redis-cli PING   # expect PONG; a timeout/error confirms Redis is the problem
docker compose logs --tail=200 api | grep -i "replay.*guard\|redis"
```

**Resolve:**

1. Fix Redis reachability first — this alert is a symptom of Redis being
   down or unreachable from `api`, not an independent bug.
2. Once Redis is back, check for actual double-processing during the
   outage window: duplicate `store_event_id` rows would normally be
   deduped, so this is specifically about the window where dedup was
   bypassed. Depending on the store and event type, a duplicate delivery
   may be harmless (idempotent handlers) or may need a manual reconciliation
   pass — check the specific webhook types that arrived during the outage
   window in `webhook_events`.
3. This is the same class of at-least-once/duplicate-handling problem the
   outbox dispatcher solves for analytics
   ([outbox-dispatcher.md](../architecture/outbox-dispatcher.md)) — if
   double-processing produced incorrect state (double credit grants,
   double revenue events), the remediation pattern is the same: find what
   isn't idempotent under a duplicate and fix that, rather than trying to
   prevent every possible Redis blip going forward.

## `RovenueApiPodsDyingMidWebhook` — ticket, 30m sustained

**What it means:** the webhook reaper is reclaiming `webhook_events` rows
stuck in `PROCESSING` — left there by an `api` process that died mid-work.
Non-zero and sustained means processes are being killed while holding
webhook work: OOM, a rollout with too short a grace period, or a crash loop.

**Confirm:**

```bash
docker compose logs api | grep -iE "oom|killed|exit code"
docker stats --no-stream api   # sustained near the mem_limit cap in docker-compose.yml is the OOM signature
```

**Resolve:**

1. If memory-capped: either the `api` service's `mem_limit: 2g` (per
   replica) is genuinely too tight for your traffic, or something is
   leaking — check whether the reclaim rate correlates with request volume
   (capacity) or grows over time regardless of load (leak).
2. If it's a rollout grace-period issue: `docker compose up -d` doesn't
   wait for in-flight webhook processing to drain before sending `SIGTERM`
   — if your deploy pipeline restarts `api` faster than a webhook handler
   can finish, every deploy will reclaim a few rows by design. This is
   usually fine (the reaper exists for exactly this), but a consistently
   high reclaim rate on every deploy is worth shortening deploy frequency
   or lengthening the grace period for.
3. Reclaimed rows are retried automatically — this alert is about *why*
   processes are dying, not about data loss (the reaper's whole job is to
   make sure reclaimed work isn't lost).

## `RovenuePartitionPremakeRunningOut` — ticket, 1h sustained

**What it means:** `rovenue_partition_premake_months_remaining{table=…}` has
dropped below 3. That gauge is the number of months between now and the
furthest-future partition bound on that table — i.e. how long the table
keeps accepting rows if nothing ever creates another partition. Partition
maintenance has stopped rolling the premake window forward.

This is the alert that would have caught the defect migration 0130 fixed.
`revenue_events` and `credit_ledger` had 60 hand-made monthly children
ending at 2028-12 and nothing registered to extend them, so every insert
dated 2029-01-01 or later was going to fail with `no partition of relation
"revenue_events" found for row` — and the only symptom available before
that date was none at all.

**Confirm:**

```bash
# What the gauge is reading, straight from the catalog:
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT parent.relname,
         max((substring(pg_get_expr(child.relpartbound, child.oid)
              FROM 'TO \(''(.*?)''\)'))::timestamptz) AS last_bound
    FROM pg_inherits i
    JOIN pg_class child  ON child.oid  = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
   WHERE parent.relname IN ('revenue_events','credit_ledger','outgoing_webhooks')
   GROUP BY parent.relname;"

# Has the worker run at all? It is scheduled 03:00 UTC daily.
docker compose logs api | grep partition-maintenance | tail -20
```

**Resolve:**

1. `revenue_events` / `credit_ledger` roll forward through pg_partman.
   Check the registration is still there and premake is what you expect:
   `SELECT parent_table, premake, retention FROM partman.part_config;`
   A missing row means migration 0130 never applied on this database.
2. `outgoing_webhooks` is **not** partman-managed —
   `apps/api/src/workers/partition-maintenance.ts` hand-rolls its next 13
   months. If only that table is short, the worker is failing partway.
3. Run maintenance by hand to buy runway immediately:
   `CALL partman.run_maintenance_proc();` for the partman tables, then let
   the worker's next run cover `outgoing_webhooks` (or restart `api`,
   which reschedules the repeatable job).
4. Then find out why the daily job stopped — check the BullMQ queue
   `rovenue-partition-maintenance` for failed jobs. Also check
   `rovenue_partition_maintenance_partman_ran` below.

## `RovenuePartitionPremakeCritical` — page, 15m sustained

Same gauge, under 1 month. Everything above applies; the difference is that
the daily cadence gives you roughly 30 more chances before inserts start
failing outright. Do step 3 first and diagnose afterwards.

## `RovenuePartitionDefaultRowsStranded` — page immediately, no delay

**What it means:** `partman.check_default()` found at least one row in a
partitioned table's DEFAULT partition. **Nothing recovers this
automatically, and it gets worse the longer it waits.**

A DEFAULT partition catches rows no real partition covers. Once a row for
period P sits there, Postgres refuses to attach the real partition for P:

```
ERROR:  updated partition constraint for default partition
        "revenue_events_default" would be violated by some row
```

Partition maintenance for that table then fails every night, and neither
partman nor the retention sweep ever relocates the row.

**Confirm:**

```bash
docker compose exec db psql -U rovenue -d rovenue -c "SELECT * FROM partman.check_default();"
# Which periods are stranded — this is what you have to move:
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT date_trunc('month', \"eventDate\") AS period, count(*)
    FROM ONLY revenue_events_default GROUP BY 1 ORDER BY 1;"
```

**Resolve:**

1. Create the real partition for each stranded period **first** — it will
   be refused while the rows are still in the default, so:
2. Take the rows out of the default into a temporary table, create the
   partition, then insert them back. Under an exclusive lock, in one
   transaction, per period. `partman.partition_data_time()` does this for
   you on a partman-managed parent and is the preferred route.
3. Ask how they got there: a row lands in the default only when it is
   dated past the premake horizon (see the two alerts above) or before the
   first partition. A backfill importing historical data is the usual
   cause — check `import_jobs`.

## `RovenuePartitionMaintenanceSkippingPartman` — ticket, 1h sustained

**What it means:** `rovenue_partition_maintenance_partman_ran` is 0. The
maintenance worker ran, found no `partman` schema, and skipped
`partman.run_maintenance_proc()` entirely. Every partman-managed parent —
`revenue_events`, `credit_ledger`, `funnel_sessions`, `funnel_answers`,
`integration_deliveries` — stops rolling forward while this is true.

Migration `0051_funnel_partitions.sql` installs pg_partman unguarded and
runs on both install paths (fresh install and upgrade), so a fully-migrated
database should never produce this. A 0 means either the database is not
fully migrated, or the extension was dropped.

**Confirm:**

```bash
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='partman') AS schema_present,
         (SELECT extversion FROM pg_extension WHERE extname='pg_partman') AS ext_version;"
docker compose logs api | grep "partman schema absent"
```

**Resolve:**

1. If migrations are behind, run `pnpm db:migrate` — 0051 will install it.
2. If the image itself lacks pg_partman, the database is not running
   `deploy/postgres` (a stock `postgres:16` has no `partman.control`).
   Rebuild from `deploy/postgres/Dockerfile`.
3. After it is back, run `CALL partman.run_maintenance_proc();` once by
   hand — the premake window has been standing still for as long as this
   alert was firing, so check `rovenue_partition_premake_months_remaining`
   afterwards rather than assuming it recovered.
