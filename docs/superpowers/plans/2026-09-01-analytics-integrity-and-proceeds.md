# Analytics Integrity, Proceeds & Metrics Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the analytics layer's SQL provably valid against the real ClickHouse schema, repair the filter endpoint that is broken in production, add store-sourced country and estimated proceeds, and ship a metrics export for customer BI.

**Architecture:** A catalog-driven schema-contract test executes every metrics query against a migrated ClickHouse. Country arrives from the store's own per-transaction value, travels on the existing outbox → Kafka → `mv_revenue_to_raw` path, and lands as an additive ClickHouse column. Proceeds are computed at query time from a per-project, per-store configured rate — never written into events.

**Tech Stack:** ClickHouse (+ Kafka/Redpanda, outbox), Hono + TypeScript (strict), Drizzle/Postgres, React (Vite) dashboard, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-analytics-integrity-and-proceeds-design.md` — read it in full before Task 1. §4.1 (the contract test), §4.2 (why country comes from the store, not the device) and §4.3 (why proceeds are labelled estimated) are requirements, not commentary.

## Global Constraints

- **Never create or switch branches or worktrees.** Commit on whatever HEAD is checked out.
- **Never stage** `apps/dashboard/src/components/assets/asset-library.tsx` or `packages/db/seed.ts` — pre-existing unrelated dirty files.
- **Throttle:** prefix every heavy command with `nice -n 19`; vitest with `--maxWorkers=2`; suites strictly sequential; kill lingering vitest processes between suites.
- **`docker ps` before any DB-backed run, and check the services you need are up — not just the daemon.** A recent full run showed 52 failures across 21 files purely because Redis, MinIO, ClickHouse and Redpanda were down while Postgres was up. `docker compose up -d redis minio minio-init clickhouse redpanda`.
- **ClickHouse from the host is blocked.** `deploy/clickhouse/users.d/rovenue.xml` allow-lists loopback + `172.16/12` + `10/8`; Docker-Desktop host traffic arrives from `192.168.65.1` and is rejected as `IP_ADDRESS_NOT_ALLOWED`, which clients report as *"password is incorrect"* — **the credentials are fine**. Use the compose `migrate` service, or bridge: `docker run -d --rm --name ch-devfwd --network rovenue_default -p 8125:8125 alpine/socat tcp-listen:8125,fork,reuseaddr tcp-connect:clickhouse:8123`, then `CLICKHOUSE_URL=http://localhost:8125 CLICKHOUSE_USER=rovenue` (the write user — `.env`'s `rovenue_reader` is read-only and cannot run DDL), and `docker rm -f ch-devfwd` after.
- **ClickHouse migrations:** additive only, `ADD COLUMN IF NOT EXISTS ... DEFAULT ''`, following `0019`'s pattern. **Never DROP+CREATE a Kafka-fed materialised view on a live database** — messages consumed in the gap are lost because the Kafka offset advances without the MV. Pause the `*_queue` consumer first or backfill from Postgres.
- **The outbox is the only path to Kafka.** Never write a domain table and Kafka in the same code path.
- TypeScript strict; Zod for API input; `{ data }` / `{ error: { code, message } }` envelopes.
- **No magic values.** Commission tiers, row caps, window defaults are named constants.
- **No self-confirming tests.** The contract test executes SQL; it does not assert that a query string contains a column name.
- Conventional commits. One task = one commit unless a task says otherwise.

### Confirmed facts (verified 2026-09-01 against the live stack — re-confirm if something fails, do not re-derive)

- `raw_revenue_events` columns: `eventId, revenueEventId, projectId, subscriberId, purchaseId, productId, type, store, amount, amountUsd, currency, eventDate, ingestedAt, _version, placementId, paywallId, variantId, experimentKey`. **No country, no productGroupId.**
- `readFilterOptions` (`apps/api/src/services/metrics/charts.ts:288-306`) queries `subscriberCountry`, `country` and `productGroupId` → `Code: 47 UNKNOWN_IDENTIFIER` live. Only the `store` dimension works.
- Every metrics test mocks the ClickHouse client (`vi.mock("../../lib/clickhouse")`), which is why the above is green in CI.
- `apple-types.ts:108-109` types `storefront` / `storefrontId` on the decoded transaction; **nothing in production reads them.**
- `raw_exposures` has `country`, sourced from an optional SDK runtime attribute (`apps/api/src/routes/v1/experiments.ts:71`); 1 of 15 live rows carry one. Not persisted on `subscribers`.
- Chart catalog: 16 entries in `apps/api/src/services/metrics/chart-catalog.ts`. Route surface: `apps/api/src/routes/dashboard/charts.ts` (`/catalog`, `/channels`, `/funnel`, `/heatmap`, `/saved-views`, filter options).
- Dashboard chart test convention: RTL + `QueryClientProvider`, `data-testid` points, explicit empty-state assertions — see `apps/dashboard/src/components/charts/series-chart-panel.test.tsx`.
- CSV streaming precedent with a truncation marker: `apps/api/src/services/subscriptions/export-csv.ts`.
- **No project-settings or store-config table exists** to host a commission rate.

---

## File Structure

**New:**
- `apps/api/src/services/metrics/schema-contract.integration.test.ts` — the contract test
- `apps/api/src/services/metrics/proceeds.ts` — rate resolution + proceeds arithmetic
- `apps/api/src/services/metrics/export.ts` — BI export reader
- a Postgres migration for commission configuration
- a ClickHouse migration adding the country dimension

**Modified:**
- `apps/api/src/services/metrics/charts.ts` (filter options; country dimension)
- the revenue outbox payload builder and the Apple/Google/Stripe paths that populate it
- `packages/db/clickhouse/migrations/` (+ `mv_revenue_to_raw`)
- `apps/api/src/routes/dashboard/charts.ts` (proceeds + export routes)
- `apps/dashboard/src/components/charts/` (country filter honesty, proceeds display)
- `ROADMAP.md` §5

---

## Task 1: Schema-contract test, and the repair it exposes

**Files:**
- Create: `apps/api/src/services/metrics/schema-contract.integration.test.ts`
- Modify: `apps/api/src/services/metrics/charts.ts`

**Interfaces:**
- Produces: a test that executes every metrics query against a migrated ClickHouse; a `readFilterOptions` that no longer references absent columns.

- [ ] **Step 1: Build the harness.** Enumerate queries **from the catalog and the service exports**, not a hand-kept list — a chart added later must be covered without anyone remembering. Execute each against a real migrated ClickHouse with a bound project id. An empty result set is a pass; this checks schema validity, not data. The seam that lets the real SQL run without the mocked client is the main decision here — state in your report what you chose and why a re-typed copy of the SQL would have been worthless.
- [ ] **Step 2: Prove it catches the real defect.** Run it before touching `charts.ts` and capture the failure for `readFilterOptions` — the live error is:

```
Code: 47. DB::Exception: Unknown expression or function identifier 'subscriberCountry'
Code: 47. DB::Exception: Unknown expression or function identifier 'productGroupId'
```

This RED is the whole justification for the task. A harness that goes green on the first run has not been shown to work.

- [ ] **Step 3: Repair the endpoint.** Remove the **product-group** dimension from `readFilterOptions`, its response type and any consumer — it exists nowhere in the schema and, unlike country, has no partial presence to build on. Leave **country** returning an empty list for now with a comment pointing at Task 2, which adds the column; do not leave a query referencing it.
- [ ] **Step 4: Green.** The contract test passes; `GET /charts/filter-options` returns without a ClickHouse exception.
- [ ] **Step 5: Add a deliberate bad reference** to a scratch query, watch the test fail, remove it. Report that evidence.
- [ ] **Step 6: Commit** `test(metrics): execute every chart query against the real ClickHouse schema`.

---

## Task 2: Country from the store — Apple, end to end

**Files:**
- Create: a ClickHouse migration (next number in `packages/db/clickhouse/migrations/`)
- Modify: the revenue outbox payload builder; the Apple receipt/webhook path; `mv_revenue_to_raw`; `charts.ts`

**Interfaces:**
- Produces: `raw_revenue_events.country` (String, `DEFAULT ''`), populated for Apple-sourced revenue.

- [ ] **Step 1: Read `0019_revenue_presented_context.sql` first** — it is the exact precedent for adding a dimension to this table and its materialised view. Follow its shape.
- [ ] **Step 2: Thread `storefront` through.** It is already typed at `apple-types.ts:108-109` and read by nothing. Carry it from the decoded transaction into the revenue outbox payload. **Do not write ClickHouse directly** — the outbox is the only path.
- [ ] **Step 3: The ClickHouse migration** adds the column additively and updates `mv_revenue_to_raw` to extract it. Note the standing footgun: recreating a Kafka-fed MV on a live database loses messages consumed in the gap. State how you handled it.
- [ ] **Step 4: Re-enable the country dimension** in `readFilterOptions`, now that the column exists.
- [ ] **Step 5: Tests.** An Apple transaction carrying a storefront produces a revenue event whose payload carries the country; the contract test still passes with the new column; the filter options return country values. **Assert on state, not on the payload builder's return value.**
- [ ] **Step 6: Commit** `feat(metrics): record the store's per-transaction country on revenue events`.

---

## Task 3: Country for Google and Stripe — verify, then wire or document

**Files:** the Google and Stripe revenue paths; the migration guide note if a store cannot supply one.

- [ ] **Step 1: Verify, do not assume.** Determine from each store's actual payload whether a per-transaction country/region is available (Google's subscription resources expose a region concept; Stripe's objects expose customer/billing country). Report exactly what you found, with the field path.
- [ ] **Step 2: Wire what exists** into the same payload field, using the same semantics as Apple: the store's own value for that transaction.
- [ ] **Step 3: Where a store supplies nothing, record nothing** — no fallback to a device attribute, no borrowing from another store. Document the gap in the spec's terms: "the device reported this country" and "this transaction happened in this storefront" are different facts.
- [ ] **Step 4: Commit** `feat(metrics): source revenue country from Google and Stripe where available`.

---

## Task 4: Commission configuration and proceeds arithmetic

**Files:**
- Create: `apps/api/src/services/metrics/proceeds.ts`; a Postgres migration
- Modify: the dashboard settings API surface that will own the rate

**Interfaces:**
- Produces: per-project, per-store commission rate storage; `computeProceeds(net, rate)` and a rate resolver.

- [ ] **Step 1: Choose the rate's home and say why.** No project-settings or store-config table exists. Pick a small dedicated table or a column on `projects`, and justify it in the report. Migration numbering follows the current head; **`drizzle-kit generate` is trustworthy again as of `93a78098`** (seven enums were missing from `schema.ts`'s re-export block, which made it emit `DROP TYPE` on a clean tree) — but still read the generated SQL statement by statement before committing.
- [ ] **Step 2: Presets as named constants** — Apple Small Business 15%, Apple standard 30%, and a Google equivalent — plus a custom rate. The rate is the customer's statement about their own situation; **never infer it**.
- [ ] **Step 3: Proceeds are computed at query time.** Never write a proceeds figure into `raw_revenue_events`: a rate change must re-compute history, not require rewriting it.
- [ ] **Step 4: Refunds net first, then the rate applies** — the store returns its commission on a refund.
- [ ] **Step 5: Tests driven from the configured rate**, not from a hardcoded product of two constants. Cover both Apple tiers, a custom rate, a rate change re-computing an earlier period, and the refund ordering.
- [ ] **Step 6: Commit** `feat(metrics): per-project store commission rates and query-time proceeds`.

---

## Task 5: The proceeds surface

**Files:** `apps/api/src/services/metrics/charts.ts` or a sibling; `chart-catalog.ts`; `apps/api/src/routes/dashboard/charts.ts`

- [ ] **Step 1: Add the catalog entry** following the existing shape (`{ id, category, chartType, range, config }`).
- [ ] **Step 2: The response must carry the applied rate**, not just the figure — the UI has to show the basis.
- [ ] **Step 3: The contract test must cover the new query automatically.** If it does not, the harness was not catalog-driven and Task 1 needs revisiting — say so rather than adding a manual entry.
- [ ] **Step 4: Commit** `feat(metrics): estimated proceeds chart`.

---

## Task 6: Metrics export for BI

**Files:** Create `apps/api/src/services/metrics/export.ts`; modify `apps/api/src/routes/dashboard/charts.ts`

- [ ] **Step 1: Reuse the chart readers.** A second set of queries would drift from the first and would sit outside the contract test's coverage.
- [ ] **Step 2: Follow `subscriptions/export-csv.ts`** — async generator, paged, a hard row cap, and an explicit truncation marker. Project-scoped and capability-gated like the rest of the dashboard API.
- [ ] **Step 3: Test the truncation marker**, not only the happy path: set the cap low and assert the marker appears. A silently truncated export is a lying export.
- [ ] **Step 4: Commit** `feat(metrics): ClickHouse-backed metrics export`.

---

## Task 7: Dashboard — country honesty and the proceeds basis

**Files:** `apps/dashboard/src/components/charts/`

- [ ] **Step 1: The country filter states its coverage.** Events recorded before the column exists have no country; a window spanning that boundary is partly blind and must say so rather than showing those rows as an equal "unknown" bucket.
- [ ] **Step 2: Proceeds display the applied rate** next to the figure and the word **estimated**. Apple's tier depends on the developer's whole-account prior-year proceeds and both stores apply tax handling we cannot see; presenting this as a payout would be the same class of error as fabricating a currency.
- [ ] **Step 3: Remove the product-group control** if one is rendered.
- [ ] **Step 4: Tests** follow `series-chart-panel.test.tsx`'s convention: RTL + `QueryClientProvider`, `data-testid` points, explicit empty-state assertions. Assert the rendered rate and the coverage note.
- [ ] **Step 5: Commit** `feat(dashboard): country coverage note and estimated-proceeds basis`.

---

## Task 8: Dead components, ROADMAP, battery

**Files:** `apps/dashboard/src/components/charts/{hour-day-heatmap,sql-preview-card,mock-data,index}.tsx`; `ROADMAP.md`

- [ ] **Step 1: `HourDayHeatmap` and `SqlPreviewCard`** import from `mock-data.ts`, are exported from the barrel, and are imported by nothing. The `/heatmap` endpoint is real and served by `readHeatmap`. Either wire the heatmap to it or delete both components with `mock-data.ts` — decide and say why.
- [ ] **Step 2: ROADMAP §5** — tick the five items that already shipped (churn, retention curve, LTV incl. prediction, trial→paid, paywall funnel), tick what this plan adds, and leave genuinely open items open. **Correct the stale framing** that presented the whole section as unstarted. Tick nothing that did not ship.
- [ ] **Step 3: Full battery**, sequential and throttled, reporting real numbers: `nice -n 19 pnpm build --concurrency=2`; `@rovenue/shared`; `@rovenue/db`; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`; the dashboard suite; the docs build. Known-good baselines: api 393 files / 3430 tests, db 52/283, dashboard 124 files / 1090 tests, build 9/9. `pnpm --filter @rovenue/docs check:links` already exits 1 on a pre-existing broken link — report it, do not fix it here, and do not let it hide a new breakage.
- [ ] **Step 4: Commit** `docs: analytics roadmap §5 update` with the battery numbers in the body.

---

## Self-review notes (for executors)

- **Ordering is 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.** Task 1 must land first: it is the net that catches every later task's SQL.
- The contract test's value dies if it is weakened into a string check. If executing the real SQL turns out to be hard, that difficulty is the finding — report it rather than substituting an assertion about query text.
- **Do not fill a missing country with a device attribute** (spec §4.2). A row without a store-supplied country has none.
- **Do not write proceeds into events** (spec §4.3). Query-time only.
- Country coverage will be partial by store and partial in time. Both are correct outcomes, not gaps to paper over.
