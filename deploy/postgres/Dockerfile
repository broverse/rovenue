# Plan 3 §G.1 — vanilla Postgres 16 + pg_partman.
# Replaces the timescale/timescaledb:2.17.2-pg16 image. Bookworm is
# chosen over alpine because the apt-installable `postgresql-16-partman`
# package saves the ~30MB of musl + build-from-source plumbing.

FROM postgres:16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-partman \
 && rm -rf /var/lib/apt/lists/*

# pg_partman ships an optional background worker (`pg_partman_bgw`).
# Rovenue runs partition maintenance via its own BullMQ worker
# (apps/api/src/workers/partition-maintenance.ts), so loading the
# bgw is forward-compatibility only — operators who later want to
# move scheduling into Postgres can flip the GUC without rebuilding
# the image.
RUN echo "shared_preload_libraries='pg_partman_bgw'" \
      >> /usr/share/postgresql/postgresql.conf.sample
