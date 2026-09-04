# Backup & restore

`deploy/backup/backup.sh` and `deploy/backup/restore.sh` back up and restore
Postgres, ClickHouse and the paywall-asset bucket. This document is the
operator-facing half of that pipeline: what it actually protects, the traps
found running it for real, and the recurring obligation that keeps "we have
backups" from being a claim nobody has tested.

> **`ENCRYPTION_KEY` is the whole ballgame.** `backup.sh` never writes the
> application's `ENCRYPTION_KEY` (the AES-256-GCM key store credentials are
> encrypted with) anywhere — only its SHA-256 fingerprint goes into
> `manifest.json`. `restore.sh` refuses to run, before touching a single
> table, if the `ENCRYPTION_KEY` in the environment being restored into
> doesn't fingerprint-match the one the backup was taken under. There is no
> way to recover from a mismatch after the fact — a restore under the wrong
> key would silently corrupt every stored store credential, and the failure
> would only surface the next time a receipt is verified. Keep
> `ENCRYPTION_KEY` (and the `age` identity file, `BACKUP_AGE_IDENTITY`,
> which is a *different* key — see `backup.sh`'s header) in whatever secret
> store backs the rest of production, and make sure whoever restores a
> backup has both, or they cannot restore it at all — by design.

## What is, and is not, backed up

| Component | Backed up? | Why |
|---|---|---|
| **Postgres** (`pg_dump -Fc --no-owner`) | Yes, encrypted | The system of record: subscribers, entitlements, `credit_ledger`, the `audit_logs` hash chain, `outbox_events`, projects — everything else is derived from or downstream of this. |
| **ClickHouse** (native `BACKUP DATABASE`) | Yes, encrypted | **Not derived data.** `outbox_events` rows are deleted from Postgres once dispatched — the event that produced a ClickHouse row often no longer exists anywhere else. A ClickHouse loss without a backup is a **permanent** loss of analytics history, not a rebuild-from-Postgres. See [the ClickHouse gap](#the-clickhouse-analytics-gap-after-a-restore) below for the one thing a ClickHouse *restore* still can't get back. |
| **Paywall-asset bucket** (`mc mirror`, tarred) | Yes, encrypted | Uploaded asset bytes (images, Lottie, video) have no other authoritative copy. Encrypted even though the bucket's anonymous-read policy makes the *objects* public: the tar is effectively the full key listing, and the live bucket policy deliberately refuses to let anyone enumerate that (`deploy/minio/README.md`) — a plaintext local mirror hands that enumeration back out. |
| **Redis** (BullMQ queue state) | No | Repeatable jobs re-arm themselves on worker start. The only loss is a `DELAYED` job pending at the exact backup instant — reschedule it by hand after a restore if that matters. `backup.sh` prints this reason and records it in the manifest's `skipped.redis`. |
| **Redpanda / Kafka topics** | No | Topics hold in-flight events only. The durable record is the `outbox_events` row in Postgres before dispatch, and the ClickHouse tables it feeds after — both already covered above. `backup.sh` records this in `skipped.redpanda`. |

## Two things easy to get wrong

**1. `brew install mc` installs the wrong tool.** On macOS that formula name
is claimed by GNU Midnight Commander (a terminal file manager), not the
MinIO client `backup.sh`/`restore.sh` shell out to. Install the right one
explicitly:

```bash
brew install minio/stable/mc
```

An operator who follows a runbook that just says "install mc" hits exactly
this — `mc` exists, runs, and does something else entirely.

**2. `CLICKHOUSE_URL`/asset-store traffic has to reach the compose network,
not a Docker-Desktop-forwarded host port.** Both scripts need the Docker
CLI **and socket** on whatever host they run from — the ClickHouse step
locates its container with `docker compose ps -q clickhouse` and moves the
backup archive in/out with `docker cp`, which only works with direct
daemon access, not from an arbitrary container on the network. That makes
the operator's own host (or whatever CI runner already drives `docker
compose`) the right place to run these scripts — the same host the "Tooling
present" list in this repo's task briefs already assumes has `pg_dump`,
`mc` and `age` installed. The complication is narrower than "run inside the
network": only the *HTTP calls* to ClickHouse and MinIO need to avoid the
host-forwarded ports:

- ClickHouse's `<networks>` allow-list
  (`deploy/clickhouse/users.d/rovenue.xml`) permits loopback + `172.16/12` +
  `10/8` only. On Docker Desktop for Mac, a connection made through a
  published port (`127.0.0.1:8124`) arrives at the container as
  `192.168.65.1` — outside that range — and ClickHouse rejects it,
  reporting it to the client as **"password is incorrect,"** which reads
  like a credentials problem and isn't one. (A native Linux Docker host
  doesn't rewrite the source address the same way and may not hit this at
  all — this is chiefly a dev-machine gotcha, but worth knowing before
  debugging credentials that were never wrong.)
- Reaching MinIO from the host the same way reproducibly fails specifically
  on `?location=` (`GetBucketLocation`) queries — the same failure family,
  confirmed directly against a throwaway MinIO container while building the
  round-trip test this document describes.

The fix in both cases is the same one-off `socat` relay CLAUDE.md already
documents for `db:clickhouse:migrate`, generalised to MinIO — a container
on the compose network relays the connection, so ClickHouse/MinIO see it
arrive from a docker-network-native address instead of Docker Desktop's
gateway (verified directly: `mc mirror` and `BACKUP`/`RESTORE DATABASE`
both succeed through the relay; neither succeeds over the directly
published port):

```bash
docker run -d --rm --name backup-ch-relay --network rovenue_default -p 8125:8125 \
  alpine/socat tcp-listen:8125,fork,reuseaddr tcp-connect:clickhouse:8123
docker run -d --rm --name backup-minio-relay --network rovenue_default -p 9125:9125 \
  alpine/socat tcp-listen:9125,fork,reuseaddr tcp-connect:minio:9000

# backup.sh reads CLICKHOUSE_URL from the environment, but `mc mirror`
# reads its endpoint from a pre-configured alias, not from an env var —
# point both at the relay ports:
mc alias set rovenue-backup http://localhost:9125 "$ASSET_STORAGE_ACCESS_KEY_ID" "$ASSET_STORAGE_SECRET_ACCESS_KEY"
CLICKHOUSE_URL=http://localhost:8125 \
  bash deploy/backup/backup.sh --out /backups/$(date -u +%Y%m%dT%H%M%SZ)

docker rm -f backup-ch-relay backup-minio-relay
```

This is exactly the shape `deploy/backup/backup-restore.integration.test.ts`
uses against its own throwaway containers — it's the pattern this document
recommends because it's the one actually proven to work, not a guess.

## Restore order, and why

`restore.sh` always restores in the same order: **Postgres, then the asset
bucket, then ClickHouse.** This isn't arbitrary:

1. **Postgres first** — it's the only store the other two are consistent
   *against*. Every subscriber/project row the asset keys and ClickHouse
   analytics reference has to exist before anything downstream is restored.
2. **Assets second** — no ordering dependency on ClickHouse either way;
   restored right after Postgres purely to get the slower `mc mirror` step
   out of the way before the more failure-prone ClickHouse step.
3. **ClickHouse last** — its Kafka Engine tables (and their materialized
   views) are `DETACH`ed immediately after `RESTORE DATABASE` completes and
   re-`ATTACH`ed once the ClickHouse restore itself finishes — not held
   detached through the rest of verification, because
   `db:verify:clickhouse` needs them attached to report live consumer
   state, and holding them detached longer doesn't reduce the real risk
   below, which is a function of the consumer-group *offset*, not of how
   long the tables sit detached.

Throughout, `api`, `dispatcher` and every BullMQ worker are stopped before
anything is touched and are **never restarted by the script** — bringing
traffic back is an operator decision made after reading the verification
output, not something `restore.sh` assumes for you.

## The ClickHouse analytics gap after a restore

This is the most important thing in this document, and it is silent unless
you know to look for it.

**The mechanics.** ClickHouse's Kafka Engine tables track their consumption
progress as a **consumer-group offset stored in Redpanda**, not inside
ClickHouse itself — and therefore not inside the ClickHouse backup either.
`RESTORE DATABASE` rolls ClickHouse's data tables back to the instant the
backup was taken (the manifest's `createdAt`, call it **T0**). The
consumer-group offset in Redpanda, however, was never touched by the
restore — it still reflects whatever was consumed up to the moment that
prompted the restore (**T1**, later than T0, e.g. the outage itself).

When the Kafka tables are re-attached and consumption resumes, it resumes
**forward from T1**, not from T0. Every event dispatched between T0 and T1
was already marked consumed in Redpanda *before* the incident — re-attaching
does not redeliver it. The result is a **silent, permanent gap** in
ClickHouse analytics covering everything dispatched between T0 and T1.

**It is not recoverable from Postgres either.** `outbox_events` rows are
deleted after successful dispatch, and by definition every event in the T0–T1
gap was already dispatched (that's why it isn't redelivered) — so there is no
surviving copy anywhere to replay from except the one Redpanda still has, if
you reset the offset before it ages out.

**The remedy — do this before resuming the dispatcher.** Reset the Kafka
consumer group for each restored Kafka table to an offset **at or before**
the manifest's `createdAt`, so the T0–T1 window replays:

```bash
# For each table restore.sh printed in its gap warning, e.g. via rpk:
rpk group seek rovenue-ch-exposures --to timestamp:<createdAt, ms epoch> --topic rovenue.exposures
```

`restore.sh` prints this warning itself at the end of a successful run,
naming the manifest's `createdAt` and listing exactly which Kafka tables
need their consumer group reset — you do not need to reconstruct this from
memory at 3am.

**Why the replay is safe here specifically.** Replaying T0-and-earlier
messages means some of them arrive a second time (anything between the
consumer group's *original* offset going stale and T0 could double-deliver).
That's fine in this codebase: ClickHouse's revenue/credit rollups are
**query-time idempotent views**, not `SummingMergeTree` aggregates,
*precisely because* outbox delivery is at-least-once by design
(`docs`/CLAUDE.md's outbox note). A replayed message at or before `createdAt`
lands as a tolerated duplicate, not a double-counted row.

## Quarterly test-restore

A backup nobody has restored is not a backup — schedule an actual restore of
the latest production backup, quarterly, into a throwaway environment. Never
point `restore.sh` at anything that isn't disposable.

**Procedure:**

1. Copy the latest backup's directory (`manifest.json` + the three
   artifacts it names) to a throwaway host or VM — not the machine running
   production or your local dev stack.
2. Bring up disposable Postgres + ClickHouse + MinIO there (a fresh
   `docker compose` project, or the `backup` profile below) and run
   `restore.sh --from <dir>` against them, with `ENCRYPTION_KEY` and
   `BACKUP_AGE_IDENTITY` pulled from the same secret store production uses.
3. Compare the row counts `restore.sh` prints (`subscribers`,
   `credit_ledger`, `audit_logs`, `outbox_events`, `projects`) against a
   count taken from the production source **at the time the backup was
   made** (the manifest's `createdAt`) — not against production's current
   counts, which have moved on.
4. Confirm the `db:verify:clickhouse` step `restore.sh` already ran reported
   `ClickHouse schema: OK` with no drift (re-run
   `pnpm --filter @rovenue/db db:verify:clickhouse` by hand against the
   throwaway environment if you want a second, human-triggered look).
5. Verify the audit hash chain for every restored project. There's no
   wrapped CLI for this yet — `verifyAuditChain(projectId)`
   (`apps/api/src/lib/audit.ts`) is the primitive; it returns
   `{ rowCount, errors }`, and a passing chain has `errors.length === 0`:

   ```bash
   DATABASE_URL=<throwaway restore's connection string> \
     pnpm --filter @rovenue/api exec tsx -e '
       import { Client } from "pg";
       import { verifyAuditChain } from "./src/lib/audit";
       const pg = new Client({ connectionString: process.env.DATABASE_URL });
       await pg.connect();
       const { rows } = await pg.query("SELECT id FROM projects");
       for (const { id } of rows) {
         const r = await verifyAuditChain(id);
         console.log(id, r.errors.length === 0 ? "OK" : JSON.stringify(r.errors));
       }
       await pg.end();
     '
   ```

6. Read `restore.sh`'s ClickHouse-gap warning and confirm you understand
   which Kafka tables it named — on a real restore you'd reset their
   consumer groups next; on a test-restore there's nothing live to resume,
   so this step is "did the warning fire and name the right tables," not
   "reset the offset."
7. Tear the throwaway environment all the way down. Nothing from this
   procedure should still exist afterward — the same discipline this
   document's own round-trip test (`deploy/backup/backup-restore.integration.test.ts`)
   uses against uniquely-named, self-cleaning containers.

**Scheduling.** This is an operator decision — `backup.sh`/`restore.sh` take
no opinion on cadence, and neither does this document beyond "quarterly, on
a calendar, not on memory." A cron entry for the recurring backup (not the
quarterly *test*-restore, which stays a deliberate, watched exercise):

```cron
# Nightly backup at 03:15 UTC, run on the docker host itself (see "two
# things easy to get wrong" above for why this isn't run through a
# container on the compose network).
15 3 * * * cd /opt/rovenue && bash deploy/backup/backup.sh --out /backups/$(date -u +\%Y\%m\%dT\%H\%M\%SZ) >> /var/log/rovenue-backup.log 2>&1
```

`backup.sh` itself needs `docker compose ps`/`docker cp` (direct daemon
access, for the ClickHouse step) plus `pg_dump`/`mc`/`age` — a real
container can still host it via docker-outside-of-docker (the socket
bind-mounted in, not a nested daemon), which is what a `backup` compose
profile buys you over a bare cron line: it keeps the one-off runner's
image out of the default `docker compose up` boot list while still
installing its own tooling and reaching Postgres/ClickHouse by service
name — but it needs an image with the docker CLI and the backup tooling
in it, which the existing `api`/`migrate` image (a `pnpm deploy` of
`@rovenue/api` alone — see that service's own comment in
`docker-compose.yml`) is not built for:

```yaml
services:
  backup:
    image: alpine:3.20
    profiles: ["backup"]
    env_file: [.env]
    volumes:
      - .:/repo:ro
      - /var/run/docker.sock:/var/run/docker.sock
      # `docker cp` (inside backup.sh's ClickHouse step) writes into
      # THIS container's own filesystem, not the host's, even though it
      # talks to the host's daemon over the bind-mounted socket — the
      # output directory needs its own mount or the backup vanishes with
      # the container.
      - /opt/rovenue/backups:/backups
    working_dir: /repo
    entrypoint: ["sh", "-c"]
    command:
      - |
        apk add --no-cache bash docker-cli postgresql16-client age curl \
          && curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
          && chmod +x /usr/local/bin/mc \
          && exec bash deploy/backup/backup.sh --out /backups/$$(date -u +%Y%m%dT%H%M%SZ)
    depends_on:
      db: { condition: service_healthy }
      clickhouse: { condition: service_healthy }
```

invoked as `docker compose --profile backup run --rm backup`. Installing
tooling on every run is the honest tradeoff for staying out of the default
image build — bake a purpose-built image instead once this profile earns
its keep.

**Retention.** Keep enough backups to cover the gap between two quarterly
test-restores plus a safety margin — 90 days of nightly backups is a
reasonable starting point for most self-hosts, longer if compliance
requirements say otherwise. This document does not implement rotation;
pick a retention window and enforce it with whatever your storage layer
already offers (S3/R2 lifecycle rules, a `find -mtime +90 -delete` cron
line next to the backup one, etc.) rather than teaching `backup.sh` to
delete its own output.
