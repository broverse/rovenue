# PeerDB bootstrap for rovenue analytics

PeerDB is vendored as a git submodule at `deploy/peerdb/upstream/`,
pinned to tag `v0.36.18`. We deploy it via PeerDB's own `run-peerdb.sh`
script — NOT via rovenue's `docker-compose.yml` — because PeerDB
bundles ~9 interdependent services (catalog postgres + 3 temporal
services + flow-api + flow-snapshot-worker + flow-worker + peerdb
server + peerdb-ui) whose topology drifts between versions.

## First-time setup

```bash
# 1. Ensure rovenue's Postgres + ClickHouse are running and published
#    on the host (default: localhost:5433 and localhost:8124).
docker compose up -d db redis clickhouse

# 2. Initialise the PeerDB submodule if not yet done.
git submodule update --init --recursive

# 3. Boot PeerDB. This runs on its own docker network; it reaches
#    rovenue's services via host.docker.internal.
cd deploy/peerdb/upstream
./run-peerdb.sh

# 4. Wait for the PeerDB UI to be reachable at http://localhost:3000
#    and the Postgres wire endpoint at localhost:9900
#    (user `peerdb`, password `peerdb`).

# 5. Apply the rovenue mirror config (Phase 4 creates setup.sql).
psql "postgresql://peerdb:peerdb@localhost:9900/peerdb" \
     -f deploy/peerdb/setup.sql
```

## Connecting PeerDB to rovenue services

PeerDB runs in its own docker network (created by `run-peerdb.sh`),
so its containers cannot resolve `db` or `clickhouse`. From inside
PeerDB's network, rovenue is reachable via:

- Postgres: `host.docker.internal:5433` (rovenue user/password)
- ClickHouse: `host.docker.internal:8124` (rovenue user/password)

`deploy/peerdb/setup.sql` (Phase 4) uses these host addresses in the
`CREATE PEER ... WITH (...)` statements.

## UI

- Dashboard: http://localhost:3000 — mirrors, peers, sync status.
- psql wire: localhost:9900 — scriptable via `psql`.

## Stopping PeerDB

```bash
cd deploy/peerdb/upstream
docker compose down
```

This leaves rovenue's own stack untouched. PeerDB's catalog state
persists in PeerDB's docker volumes; on next boot mirrors resume.

## Upgrading

Pin the submodule to a newer `v0.*.*` tag:

```bash
cd deploy/peerdb/upstream
git fetch --tags
git checkout v0.X.Y
cd -
git add deploy/peerdb/upstream
git commit -m "chore(peerdb): bump to v0.X.Y"
```

Then rerun `./run-peerdb.sh` and re-apply `deploy/peerdb/setup.sql`
if the peer / mirror schema changed. Verify the mirror resumes in
the UI.

## Production (Coolify / hosted)

Production runbook is out of scope for Plan 1. The simplest Coolify
deployment publishes PeerDB as an independent service stack
alongside rovenue's own stack, with ClickHouse and Postgres reachable
over the Coolify internal network (not host.docker.internal).
Operator notes land with Plan 2.
