# Integrations framework — deployment ordering

This document describes the correct deployment order for the first production rollout of the Meta CAPI / TikTok Events integrations framework. No feature-flag gates exist; follow the steps below to deploy safely.

## Steps

### 1. Apply the database migration

```bash
pnpm db:migrate
```

Specifically, `0053_integrations_framework.sql` must succeed. The migration installs the `integration_connections`, `integration_deliveries` (partitioned), and related tables, and calls `pg_partman.create_parent` to register the deliveries partition set.

**Verify:**

```sql
SELECT * FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5;
SELECT parent_table FROM partman.part_config WHERE parent_table = 'public.integration_deliveries';
```

### 2. Deploy the API binary

On startup the API process:

- `startIntegrationsFanout()` joins the `rovenue-integrations-fanout` Kafka consumer group on the `rovenue.revenue` and `rovenue.billing` topics.
- `ensureIntegrationsDeliverWorker()` starts the BullMQ worker that processes the `rovenue-integrations-deliver` queue.

Both functions are called from the API boot sequence automatically; no manual wiring is needed.

### 3. Dashboard routes are immediately live

The `/projects/:projectId/integrations` routes are mounted with no feature-flag guard. Until an operator creates a connection via the dashboard **Apps** page, no events are forwarded and no queue jobs are produced. The "off" state is simply "no enabled connection exists."

## Kill switch (if needed)

If you need to disable the framework after deploy without a rollback:

```bash
# Disable all connections for a project via API (no SQL required):
PATCH /projects/:projectId/integrations/:id  {"isEnabled": false}
```

For a hard env-level kill switch, add the following one-liner at the top of `apps/api/src/routes/dashboard/integrations.ts` before deploying:

```ts
if (process.env.INTEGRATIONS_FRAMEWORK_DISABLED === "true") {
  throw new HTTPException(503, { message: "Integrations framework disabled" });
}
```

## Rollback

1. PATCH all connections to `is_enabled=false` to stop live forwarding immediately.
2. Revert the API binary to the previous release.
3. The migration does **not** need to be rolled back for a clean binary rollback — tables are additive-only.

See also: [integrations-manual-qa.md](./integrations-manual-qa.md) for post-deploy validation steps.
