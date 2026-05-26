# Notifications runbook

Operational handbook for the notification pipeline shipped in
the Phase 1–15 notifications plan. Each section is a single
on-call scenario: the symptom you see, how to confirm it, and
the commands that resolve it.

## Pipeline shape (quick reference)

```
domain-write → outbox_events → outbox-dispatcher → rovenue.notifications (Kafka)
                                                 ↓
                                          notifier-worker
                                                 ↓
                          notifications + notification_deliveries (Postgres)
                                                 ↓
                           notifier-send-email / notifier-send-push (BullMQ)
                                                 ↓
                                       SES / APNs / FCM
                                                 ↓
                            SES webhook → notification_suppression_list
                                       → notification_deliveries.status update
```

Four worker containers ship with `docker-compose.yml`:

| service              | command                                               |
| -------------------- | ----------------------------------------------------- |
| `notifier-worker`    | `tsx src/workers/notifier-process.ts`                 |
| `digest-scheduler`   | `tsx src/workers/digest-scheduler-process.ts`         |
| `send-email-worker`  | `tsx src/workers/send-email-process.ts`               |
| `send-push-worker`   | `tsx src/workers/send-push-process.ts`                |

## Required environment

The full list is in `.env.example`. The non-obvious ones:

- `UNSUB_SIGNING_KEY` — 32-byte hex. Required in production; the
  `/unsubscribe` route refuses to start without it (503).
- `AWS_SES_CONFIGURATION_SET` — must match the configuration set
  tagging outbound mail, otherwise the SES feedback webhook
  filters every event out as "unrelated config set".
- `APNS_KEY_P8` — full PEM body including BEGIN/END lines.
  Multiline values go in `.env` with `\n` escapes or as a YAML
  block in `docker-compose.yml`.
- `KAFKA_BROKERS` — comma-separated, used by both the notifier
  consumer and the outbox-dispatcher.

## Scenario 1 — Email transport down

**Symptom:** `notifier_dispatched_total{channel="email",status="failed"}`
spiking, dashboard inbox showing nothing arriving in test
accounts, `notifier.send-email` logs full of `attempt_failed`.

**Confirm:**

```bash
# Recent failed deliveries
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT status, COUNT(*) FROM notification_deliveries
  WHERE channel='email' AND createdAt > now() - interval '15 min'
  GROUP BY status;"

# BullMQ queue depth
docker compose exec redis redis-cli LLEN bull:notifier-send-email:wait
docker compose exec redis redis-cli LLEN bull:notifier-send-email:failed
```

**Resolve:**

1. Check `EMAIL_PROVIDER` + SES creds. If they rotated, update
   `.env` and `docker compose restart send-email-worker`.
2. If SES itself is throttling (`Throughput` errors in logs),
   lower the worker concurrency via `rateLimit` in
   `send-email-worker.ts` and redeploy.
3. Drain stuck jobs once the transport is healthy:
   `docker compose restart send-email-worker` — BullMQ retries
   `attempts: 4` per job; permanently-failed ones land on the
   `failed` set and surface in Sentry via
   `captureNotifierError(component: "send-email")`.

## Scenario 2 — Push transport down

**Symptom:** Same as above but for `channel="push"`. The push
worker also logs `worker_error` on transport-level failures
(APNs HTTP/2 session drop, FCM auth refresh).

**Confirm:**

```bash
# Push devices being revoked at an unusual rate
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT platform, COUNT(*) FROM push_devices
  WHERE revokedAt > now() - interval '15 min'
  GROUP BY platform;"

# Push send worker log tail
docker compose logs --tail=200 send-push-worker | grep -E "worker_error|attempt_failed"
```

**Resolve:**

- **APNs `BadDeviceToken` bursts** → token format changed
  client-side (sandbox vs production environment mismatch). Set
  `APNS_ENVIRONMENT=sandbox` if the affected devices come from
  TestFlight builds.
- **APNs `ExpiredProviderToken`** → the JWT cache hit the 1h
  hard limit. The transport renews automatically; if it's still
  failing, the `.p8` key may have been revoked in App Store
  Connect.
- **FCM `UNREGISTERED`** → expected for uninstalled apps. The
  worker already revokes those tokens; no action required unless
  the revocation rate spikes (>5% of active devices), which
  usually means a regression in the app's token registration.

## Scenario 3 — DLQ growth (`rovenue.notifications.dlq`)

**Symptom:** `notifier_dlq_total{topic="rovenue.notifications.dlq"}`
incrementing. Each DLQ message is a message the notifier worker
couldn't parse or process.

**Confirm:**

```bash
# Inspect the DLQ from redpanda-console (http://localhost:8080)
# OR via rpk in the container:
docker compose exec redpanda rpk topic consume rovenue.notifications.dlq -n 10 --offset start
```

**Resolve:**

1. Read the `error` header on each DLQ message — it carries the
   exception message from the notifier worker.
2. Most common causes:
   - **Schema drift** — producer added a context field the
     catalog doesn't know. Update `EVENT_CATALOG` in
     `packages/shared/src/notifications/event-catalog.ts` to
     accept the new shape, redeploy notifier-worker.
   - **Unknown eventKey** — producer typo. Fix the producer
     (`emitNotification` call site).
3. After fixing the root cause, replay the DLQ:
   ```bash
   docker compose exec redpanda rpk topic consume rovenue.notifications.dlq \
     --offset start --format '%v' \
     | docker compose exec -T redpanda rpk topic produce rovenue.notifications
   ```
   The notifier worker's per-`(userId, eventId)` unique index in
   `notifications` makes the replay idempotent.

## Scenario 4 — Bounce-rate spike

**Symptom:** SES feedback webhook flips a lot of
`notification_deliveries.status` rows to `'bounced'` in a short
window. Suppression list grows. Sender reputation at risk.

**Confirm:**

```bash
# Bounces vs sends in the last hour
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT status, COUNT(*) FROM notification_deliveries
  WHERE channel='email' AND createdAt > now() - interval '1 hour'
  GROUP BY status;"

# Recent suppression additions
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT reason, COUNT(*) FROM notification_suppression_list
  WHERE createdAt > now() - interval '1 hour'
  GROUP BY reason;"
```

**Resolve:**

1. If bounce-rate exceeds ~5%, **pause non-essential sends** to
   protect SES reputation:
   ```bash
   # Stop the send-email worker but leave the notifier running —
   # deliveries pile up in BullMQ but no SES requests fire.
   docker compose stop send-email-worker
   ```
2. Investigate. Most likely cause is a data-quality regression
   (test fixtures leaking into prod, or a typo in a producer's
   `recipients` list). Query the bounced addresses:
   ```sql
   SELECT user.email
   FROM notification_deliveries d
   JOIN notifications n ON n.id = d.notificationId
   JOIN "user" ON "user".id = n.userId
   WHERE d.status='bounced' AND d.createdAt > now() - interval '1 hour';
   ```
3. After the root cause is fixed, resume the send worker:
   ```bash
   docker compose start send-email-worker
   ```
   Suppressed addresses are permanently in the suppression list
   and won't trigger fresh bounces.

## Manually replay a stuck notification

```bash
# Re-enqueue every notification_delivery currently 'queued' that's
# older than 5 minutes (BullMQ should already be retrying these,
# but if the worker was down for an extended period the BullMQ
# job may have aged out of the queue).
docker compose exec db psql -U rovenue -d rovenue -c "
  SELECT id, channel FROM notification_deliveries
  WHERE status='queued' AND lastAttemptAt < now() - interval '5 min'
  LIMIT 100;"

# Use the test-send endpoint (dev only — returns 404 in production)
# to sanity-check the pipeline end-to-end without writing prod data.
curl -X POST http://localhost:3000/dashboard/notifications/test-send \
  -H "cookie: <your dashboard session cookie>"
```

## Test send (dev only)

`POST /dashboard/notifications/test-send` emits a synthetic
`security.signin.new_device` outbox row addressed to the caller.
Requires:

- A valid Better Auth session (any logged-in dashboard user).
- OWNER role on at least one project.
- `NODE_ENV !== 'production'` (returns 404 otherwise).

Useful for verifying:
- The outbox-dispatcher is publishing to Kafka.
- notifier-worker is consuming.
- The send-email-worker is processing and SES is accepting.
- The SES feedback webhook is correctly mapping the resulting
  delivery back to a `notification_deliveries` row.

## Related docs

- Spec: `docs/superpowers/specs/2026-05-26-notifications-design.md`
- Plan: `docs/superpowers/plans/2026-05-26-notifications-infrastructure.md`
- Event catalog: `packages/shared/src/notifications/event-catalog.ts`
