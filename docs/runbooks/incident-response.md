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
