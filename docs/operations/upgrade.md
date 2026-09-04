# Rovenue Upgrade Runbook

How to move a running self-hosted Rovenue install from one version to
another without losing data or serving broken requests mid-rollout.

See also: [`deployment.md`](./deployment.md) for the first install, and
[`backup-restore.md`](./backup-restore.md) for what step 3 below actually
does.

## 0. Which install path applies

This document covers **Docker Compose** in full. Coolify and Helm chart
paths (`deploy/coolify/`, `deploy/helm/`) do not exist in this repo yet —
when they land, their upgrade procedure will be added here rather than
guessed at now. If you are running Coolify or a Helm chart from a fork or a
downstream repo, the ordering and traps below (migration routing, the
expand/contract consequence, ClickHouse MV recreation, `caddy-data`
persistence, rollback) still apply; only the exact commands in step 4
differ — redeploy with the new tag on Coolify, `helm upgrade` with a
`pre-upgrade` hook Job driving migrations on Helm.

## 1. Pin the version

`latest` is for a first install. For an upgrade, name the tag explicitly:

```bash
export ROVENUE_VERSION=v1.4.0   # never `latest`
```

Floating tags (`latest`, the bare `X.Y` minor) are skipped entirely on
prerelease versions, so they never silently point at a prerelease — but
pinning to an exact `vX.Y.Z` is still what makes the upgrade repeatable and
lets you name precisely what you are rolling back *to* if you have to.

## 2. Read the release notes first

Before touching anything, read the release notes for:

- **Breaking changes** — anything that isn't a strict superset of the
  previous behavior.
- **A downtime-required marker.** A release that cannot be expressed as an
  expand/contract migration (see step 5) is marked **downtime-required** in
  its notes. That changes the procedure in step 4 from a rolling update to
  scale-to-zero, migrate, scale-up.
- **A ClickHouse materialized-view change.** If the notes mention one, read
  step 7 before you do anything else — recreating a Kafka-fed MV loses
  in-flight events unless you pause ingestion first.

## 3. Back up first

This is the rollback plan. Take a backup before pulling anything.

**If you are upgrading from a release older than this one, `deploy/clickhouse/config.d/backup.xml`
(which declares the `backups` disk `BACKUP DATABASE` writes to) is new.**
ClickHouse only reads `config.d/*.xml` at startup or on its own config
reload — `docker compose pull && docker compose run --rm migrate` in step 4
does not restart the already-running `clickhouse` container, so a first
backup attempted on the still-old process fails with "disk is not allowed
for backups" (the file's own comment concedes this). Restart or reload
ClickHouse before running `backup.sh` for the first time on this host:

```bash
docker compose restart clickhouse
```

`backup.sh` does not read `.env` itself — load it into the shell first
(`DATABASE_URL`, `ENCRYPTION_KEY`, `BACKUP_AGE_RECIPIENT`, `ASSET_STORAGE_*`,
... all come from the environment it's invoked with), then run it:

```bash
set -a; . ./.env; set +a
bash deploy/backup/backup.sh --out /backups/$(date -u +%Y%m%dT%H%M%SZ)
```

`backup.sh` refuses to run without `BACKUP_AGE_RECIPIENT` set (unless
`--allow-plaintext` is passed) — see
[`backup-restore.md`](./backup-restore.md) for what that key is and why it
must be a *different* keypair from `ENCRYPTION_KEY`. `backup.sh` also
needs an `mc` alias named `rovenue-backup` already configured
(`mc alias set rovenue-backup $ASSET_STORAGE_ENDPOINT
$ASSET_STORAGE_ACCESS_KEY_ID $ASSET_STORAGE_SECRET_ACCESS_KEY`, one-time
per host — see
[`backup-restore.md`'s "two things easy to get
wrong"](./backup-restore.md#two-things-easy-to-get-wrong) for the
Docker-Desktop-specific variant) or the object-storage step fails with
"alias does not exist."

Full detail — what's covered, the `ENCRYPTION_KEY` fingerprint guard, the
`mc` install trap, the ClickHouse restore gap — is in
[`backup-restore.md`](./backup-restore.md). Do not proceed past this step
without a backup you could actually restore: rollback in step 8 depends on
it.

## 4. Order of operations

### Docker Compose

```bash
docker compose pull
docker compose run --rm migrate
docker compose up -d
```

`docker compose run --rm migrate` runs migrations to completion and exits;
`up -d` then brings the new images up. This is also what the `migrate`
service already does automatically ahead of `api`/the workers on a plain
`docker compose up -d` — running it explicitly here just makes the boundary
visible so you can watch it finish before rolling the rest forward.

### Coolify (forthcoming)

Not documented yet — `deploy/coolify/` does not exist in this repo. When it
lands: redeploy with the new tag, same ordering guarantee (migrate before
serve) enforced by the platform's deploy hook.

### Helm (forthcoming)

Not documented yet — `deploy/helm/` does not exist in this repo. When it
lands: `helm upgrade` with the chart's `pre-upgrade` hook Job running
migrations before the new pods roll out.

## 5. The expand/contract consequence

Migrations run **before** the new application version finishes rolling
out — `docker compose run --rm migrate` completes before `up -d` even
starts pulling new containers into rotation. For the length of that
rollout, **the old image is still serving requests against the new
schema**.

That's why the schema-change policy in
[`.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) exists and is
enforced by `packages/db/src/migration-policy.test.ts`: `DROP COLUMN`,
`DROP TABLE`, `RENAME COLUMN`, and `SET NOT NULL` may never land in the
same release that introduces their replacement. Every schema change ships
as expand (add, nullable/defaulted) → migrate (write both, backfill) →
contract (drop, once nothing reads the old shape) across separate
releases.

A release that genuinely cannot be expressed that way is marked
**downtime-required** in its notes. For those, the ordering in step 4
changes:

```bash
docker compose stop api dispatcher notifier-worker digest-scheduler send-email-worker send-push-worker
docker compose run --rm migrate
docker compose pull
docker compose up -d
```

Scale to zero, migrate, scale back up — never a rolling update.

## 6. Migration routing

`pnpm db:migrate` (== `pnpm --filter @rovenue/db db:migrate`) self-routes:
a database with no migration history gets the fresh-install runner, which
dedupes already-applied migrations **by content hash**; a database with
existing history goes to drizzle's migrator, which dedupes by a
`created_at` **watermark**. You do not choose between them — the entrypoint
decides based on what's already in `drizzle.__drizzle_migrations`.

**Never point `pnpm db:migrate:fresh`
(`pnpm --filter @rovenue/db db:migrate:fresh`) at a database that has been
upgraded before.** It's the fresh-install runner invoked directly, and its
content-hash dedup means a migration file edited *after* it was already
applied — four of the shipped migration files were — no longer matches its
recorded hash and gets treated as unapplied. `db:migrate:fresh` is for a
brand-new database only. If you're not sure which category yours is in,
run plain `db:migrate` and let it route itself.

## 7. ClickHouse migrations

`pnpm --filter @rovenue/db db:clickhouse:migrate` and
`db:verify:clickhouse` must run **from inside the compose network, not the
host.** `deploy/clickhouse/users.d/rovenue.xml` allow-lists only loopback +
`172.16/12` + `10/8`. Docker Desktop's host-forwarded traffic arrives from
`192.168.65.1`, which the allow-list rejects — and ClickHouse reports that
rejection to clients as **`password is incorrect`**, not as a network
error. If you hit that message, suspect the allow-list before the
credentials.

In the normal flow this is already handled: `docker compose run --rm
migrate` (step 4) runs `migrate.ts` then `clickhouse-migrate.ts` back to
back, inside the network, as one command — you don't invoke ClickHouse
migrations separately on a routine upgrade. This section is for the
one-off case: re-running `db:clickhouse:migrate` or `db:verify:clickhouse`
by hand (debugging a partial migration, verifying post-upgrade) from your
own host instead of through the `migrate` service. Bridge it with `socat`:

```bash
docker run -d --rm --name ch-devfwd --network rovenue_default -p 8125:8125 \
  alpine/socat tcp-listen:8125,fork,reuseaddr tcp-connect:clickhouse:8123

CLICKHOUSE_URL=http://localhost:8125 CLICKHOUSE_USER=rovenue \
  pnpm --filter @rovenue/db db:clickhouse:migrate

docker rm -f ch-devfwd
```

Use the `rovenue` user (the write user) for migrations — `.env`'s
`rovenue_reader` is read-only and cannot run DDL.

## 8. Kafka-fed materialized views

Recreating a materialized view that reads from a Kafka Engine table (any
`rovenue.*_queue` table — `revenue_queue`, `credit_queue`,
`sdk_session_events_queue`, `exposures_queue`, `paywall_events_queue`)
**loses
every event consumed between the `DROP` and the `CREATE`.** The Kafka
offset is committed broker-side under the table's `kafka_group_name`
regardless of whether an MV is attached to receive what gets consumed, so
the gap is silent — nothing errors, rows are just missing.

If a release's notes mention a ClickHouse MV change, before applying it on
a live system:

```sql
-- Pause ingestion for the affected queue table first:
DETACH TABLE rovenue.<name>_queue;
```

Apply the migration, then either backfill the gap window into the raw
table from the corresponding Postgres source table (`credit_ledger`,
`revenue_events`, etc.) before resuming, or accept the gap if the release
notes say it's a fresh table with no live traffic yet. Re-attach last:

```sql
ATTACH TABLE rovenue.<name>_queue;
```

A migration that only touches the raw or downstream tables — not the MV
reading from the queue table — doesn't need this; the note in the
migration file itself says which category it is.

## 9. `caddy-data` must persist

Losing the `caddy-data` volume re-issues every TLS certificate on next
start, and repeated re-issuance risks hitting Let's Encrypt rate limits.
Never run `docker compose down -v`, `docker volume rm rovenue_caddy-data`,
or any host-migration step that doesn't explicitly carry this volume
forward.

- **Compose:** it's the named volume `caddy-data` in `docker-compose.yml`
  (mounted at `/data` in the `caddy` service) — persists automatically
  across `docker compose down` / `up -d` as long as you don't pass `-v`.
- **Coolify:** name it as persistent storage on the Caddy service, mounted
  at the same path, once that install path exists.
- **Helm:** back it with a PVC on the Caddy pod's `/data` mount, once that
  chart exists.

## 10. Rollback

Postgres migrations are **forward-only**. There are no down-migrations to
run.

Rolling back the *image* to the previous tag is safe **only when the
release notes say the schema is unchanged** for that release. If they
don't say that, the new schema is already in place and the old code may
not be compatible with it in the other direction — the expand/contract
policy in step 5 protects the old code running *during* a forward rollout;
it makes no promise about running old code against a schema that has since
moved further than one release forward, or been contracted.

**If the schema changed, rollback means restoring the backup you took in
step 3** — the full Postgres + ClickHouse + asset-bucket restore documented
in [`backup-restore.md`](./backup-restore.md#restore-order-and-why), not a
partial undo. There is no in-between option. Treat "just check out the
previous tag" as safe only after confirming the release notes say so —
never as the default.

```bash
# Only after confirming the release notes say the schema is unchanged:
docker compose down          # keeps named volumes, including caddy-data
git checkout <prev-tag>
docker compose up -d --build

# Otherwise: restore the backup from step 3 instead (see backup-restore.md).
```

## 11. Post-upgrade verification

- [ ] `docker compose ps` — every service `Up`, `migrate` exited 0.
- [ ] `curl -fsS https://rovenue.io/health` — `200`.
- [ ] `curl -fsS -o /dev/null -w '%{http_code}\n' https://app.rovenue.io/` —
      `200`.
- [ ] `curl -I https://docs.rovenue.io` — `200`.
- [ ] If the release touched ClickHouse: confirm the paused `*_queue` table
      was re-attached (step 8) and that
      `pnpm --filter @rovenue/db db:verify:clickhouse` passes from inside
      the compose network (step 7).
- [ ] `ASSET_PUBLIC_BASE_URL=https://assets.example.com/rovenue-assets
      pnpm --filter @rovenue/scripts verify:asset-headers
      <projectId>/<assetId>.webp` against a real asset — confirms the asset
      origin (Caddy or your CDN front-end) is still serving the headers it
      promises after the restart. See `deployment.md`'s
      [paywall asset origin section](./deployment.md#9-paywall-asset-origin-self-host)
      for the full setup this depends on.
