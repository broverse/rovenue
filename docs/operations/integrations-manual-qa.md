# Integrations framework — manual QA checklist

Use before flipping `is_enabled=true` in production for any new Meta CAPI or TikTok Events connection. All steps are operator-facing — no SQL access required.

## Pre-deployment environment check

- [ ] `ENCRYPTION_KEY` is set and is the same value used to encrypt all other existing credentials (rotate-then-deploy is a separate runbook).
- [ ] `KAFKA_BROKERS` resolves and the API process has reached its first heartbeat against Redpanda (`integrations-fanout` consumer group registered).
- [ ] `REDIS_URL` reachable; `BullMQ` queues `rovenue-integrations-deliver` visible in the BullMQ UI.
- [ ] Migration `0053_integrations_framework.sql` applied (verify via `pnpm db:migrate:status` or `SELECT * FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5`).
- [ ] `pg_partman` registered `public.integration_deliveries` as a managed parent (verify: `SELECT parent_table FROM partman.part_config WHERE parent_table='public.integration_deliveries'`).

## Connection creation flow

- [ ] Open dashboard → Apps → click the Meta CAPI tile. Drawer opens with Step 1 (Credentials).
- [ ] Paste pixel_id + access_token. Click **Validate**. Within ~2s the validation result row appears (green check).
- [ ] Bad credentials (intentionally wrong access_token) → red error with provider-supplied reason; **Next** stays disabled.
- [ ] Advance through Steps 2 → 3 → 4. Defaults all populated.
- [ ] In Step 4, set `test_event_code=TEST_<your_initials>` and click **Send test event**.
  - Verify the event appears in **Meta Events Manager → Test Events**: <https://www.facebook.com/events_manager2/list/pixel/{PIXEL_ID}/test_events>.
  - For TikTok: <https://ads.tiktok.com/i18n/events_manager/{PIXEL_CODE}/diagnostic>.
  - The event_id in both UIs must equal the `outbox_event.id` Rovenue used (visible in Step 4's response panel).
- [ ] Click **Activate** in Step 5.

## Activation side-effects

- [ ] An `integration.connection.updated` audit row exists with `{backfillWindowDays: 7}` in metadata.
- [ ] An `integration.backfill.started` audit row exists for the connection.
- [ ] Within ~15 minutes the matching `integration.backfill.completed` row exists, and `integration_deliveries` for the connection contains rows with the `isBackfill=true` job tag.

## Failure mode validation

- [ ] **Bad token (401):** rotate the access_token in the provider admin UI without updating Rovenue. Within the next event delivery the worker should write a row with `status='dead_letter'` and an `integration.delivery.dead_letter` audit row. Sentry breadcrumb visible in the API project.
- [ ] **Rate limit (429):** if you can synthesize one (or wait for one in production), confirm the delivery row's `attempt` count increments and `status` returns to `succeeded` after backoff (or to `dead_letter` after exhausting 5 attempts).
- [ ] **Disabled flow:** PATCH the connection to `is_enabled=false`. Within 60s (cache TTL) new events stop generating delivery rows. The 60-second window is documented and expected.

## Rollback

- [ ] To pause an integration without losing config: PATCH `is_enabled=false`. Re-enable replays the previous 7d (idempotent against Meta 7d / TikTok 14d dedup windows).
- [ ] To fully remove: DELETE — cascades to `integration_deliveries` for that connection.
