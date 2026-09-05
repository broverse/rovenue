# Load tests

k6 profiles for the traffic shapes that actually break subscription
infrastructure. Each one is a scenario, not a number: they exist to be run
against *your* deployment on *your* hardware, because a throughput figure
means nothing without the machine it came from.

## Running

k6 needs no installation if you have Docker:

```bash
docker run --rm -v "$PWD/load:/load:ro" grafana/k6:latest \
  run -e BASE_URL=https://api.example.com -e API_KEY=rov_pub_... \
  /load/k6/steady-read.js
```

`BASE_URL` and `API_KEY` are required and have no defaults. A load generator
whose target defaults to something reachable is one typo away from being
pointed at production.

On Docker Desktop, a server on your laptop is `http://host.docker.internal:PORT`,
not `localhost` — inside the container, localhost is the container.

## Profiles

| File | Shape | What it exercises |
|---|---|---|
| `k6/steady-read.js` | Constant arrival rate | `/v1/me/entitlements` and `/v1/placements/:identifier` — the two calls that dominate every install's traffic. Reads `subscriber_access`, walks placement audiences, draws experiment variants. |
| `k6/event-storm.js` | Ramping arrival rate to a peak | `/v1/events` — the write path. Envelope validation plus an `outbox_events` row in the caller's transaction. This is what backpressures clients on a release day. |
| `k6/receipt-spike.js` | Ramping arrival rate, **opt-in** | `/v1/receipts/apple` — a purchase surge. Gated behind `LOAD_ALLOW_OUTBOUND=1` because receipt verification calls a real store API. |

### Why arrival rate and not virtual users

Every profile uses an *open* model: k6 sends N requests per second regardless
of how fast they come back. A closed model — a fixed pool of VUs, each
waiting for its response before sending the next — cannot see the regression
you are looking for, because a server that gets slower simply receives less
traffic and the throughput number stays flat. Real clients do not wait their
turn.

### Pass criteria come from the SLOs

`lib/env.js` exports thresholds taken from
`deploy/prometheus/rules/slo.yml`: p99 under 500ms, failure rate under 0.1%.
One definition of "fast enough", shared by the alerting rules and the load
suite, so a run that passes here and a service that pages in production
cannot disagree about what good looks like.

`receipt-spike.js` deliberately carries no latency threshold — it is bounded
by a third party's response time, and holding the API to a budget for
something it does not control would fail the run for the wrong reason.

### Reading a receipt-spike result

With synthetic payloads, verification fails and the run measures the
*rejection* path — auth, rate limit, idempotency, validation, and the store
round-trip up to its refusal. That is a real number (it is what a replay
flood costs) but it is not the cost of a successful purchase, which also
writes a purchase, recomputes access, grants currencies and emits an outbox
row. For that, point it at a sandbox project with sandbox receipts.

## What is not here

**A published benchmark page.** Numbers are only meaningful with the
hardware, dataset size, and configuration that produced them, and this
repository has no reference deployment to produce them on. Publishing a
figure measured on a laptop as though it characterised the software would be
worse than publishing nothing. The profiles are here so that anyone with a
representative environment can generate numbers that mean something for it.
