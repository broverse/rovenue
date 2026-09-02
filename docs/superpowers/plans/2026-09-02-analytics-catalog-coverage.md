# Analytics Catalog Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chart catalog's series actually available — today 2 of 16 ids have a reader — by delegating to the metric services that already compute each concept, and give the commission rate a settings form so proceeds stop living behind a curl command.

**Architecture:** `readChartSeries` gains a case per id that **delegates to the existing service**, never its own SQL. Ids are grouped by the service that backs them so each group is independently testable. The export inherits the coverage for free because it already builds on the readers.

**Tech Stack:** TypeScript (strict), Hono, ClickHouse, React (Vite) dashboard, Vitest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-02-analytics-catalog-coverage-design.md` — read it in full before Task 1. §4.1 (delegate, never re-query), §4.6 (verify backing first) and the non-goals are requirements, not commentary.

## Global Constraints

- **Never create or switch branches or worktrees.** Commit on whatever HEAD is checked out.
- **Never stage** `apps/dashboard/src/components/assets/asset-library.tsx` or `packages/db/seed.ts` — both are dirty in the working tree for unrelated reasons and must stay that way.
- **Throttle:** `nice -n 19` on every heavy command; vitest `--maxWorkers=2`; suites strictly sequential; run the dashboard suite from inside `apps/dashboard`.
- **`docker ps` first** — check the services you need are up, not just the daemon.
- **`apps/api`'s test suite is two passes**: `vitest run` excludes testcontainer suites; `VITEST_CONTAINER_PASS=1 vitest run` runs them. Any number you report must name which pass it covers.
- **No new ClickHouse SQL for a concept an existing service already computes.** This is the plan's central constraint. If a service must be widened, widen it *in its own file* so both callers keep reading the same number.
- **No new chart types.** Widening `ChartSeriesResponse.unit` for money and teaching the panel to format it IS in scope; building a new chart renderer is not.
- **Nothing is added to or removed from `SYSTEM_CATALOG`.**
- TypeScript strict. Zod for API input. No magic values. No self-confirming tests.
- Conventional commits. One task = one commit unless the task says otherwise.

### Confirmed facts (verified 2026-09-02 — do not re-derive; re-confirm only if something fails)

- **The catalog** is `apps/api/src/services/metrics/chart-catalog.ts`, `SYSTEM_CATALOG`, 16 ids: `mrr`, `arr`, `arpu`, `rev_per_install`, `gross_vs_net`, `new_subs`, `trials_started`, `reactivations`, `churn`, `retention_curve`, `ltv`, `trial_to_paid`, `paywall_view_rate`, `paywall_purchase`, `credit_burn`, `liability`. **All 16 have i18n labels** under `charts.items.<id>` in `apps/dashboard/src/i18n/locales/en.json`.
- **The reader** is `readChartSeries` (`services/metrics/charts.ts:679`). It handles `paywall_view_rate` and `paywall_purchase`; its `default` branch returns `{ unit: "count", points: [], supported: false }` with **zero ClickHouse round-trips** and must keep doing so for anything still unwired.
- **`ChartSeriesResponse`** (`packages/shared/src/dashboard.ts:891`) is `{ chartId, unit: "count" | "percent", from, to, points, supported }`. **There is no money unit** — `series-chart-panel.tsx:162` formats `percent` as `${v.toFixed(PERCENT_DECIMALS)}%` and everything else through `formatCount`. Money ids need the union widened and the panel taught.
- **`supported: false` is deliberately distinct** from "supported but every point was null" (`series-chart-panel.tsx:149-150`). Do not collapse them.
- **`isSystemChartId` reserves the id namespace**: system charts are read-only (`403`, `routes/dashboard/charts.ts:277`) and undeletable (`:310`).
- **The export** (`services/metrics/export.ts`) iterates `SYSTEM_CHART_IDS` (`:344`) and issues **zero ClickHouse queries of its own** by design — it builds on the readers. It streams, and on a reader throwing mid-stream it emits `# error: <message>` and closes with **HTTP 200**.
- **The schema-contract harness** is `services/metrics/schema-contract.integration.test.ts`. It enumerates exports reflectively and **fails by name** on an unregistered reader. Needs `VITEST_CONTAINER_PASS=1`.
- **Commission rates**: `routes/dashboard/commission-rates.ts` gates on `assertProjectCapability(projectId, userId, "project:read")` for the read (`:79`) and `"project:settings:write"` for `PUT` (`:104`) and `DELETE` (`:152`). `COMMISSION_RATE_PRESETS` is `services/metrics/proceeds.ts:51` with sourced citations, read by nothing outside its own test.
- **Retention** is `computeRetention` in `services/cohorts.ts`, exposed by `routes/dashboard/cohorts.ts` (gated `assertProjectAccess(..., MemberRole.CUSTOMER_SUPPORT)`), **not** by anything under `services/metrics/`.
- **Project settings form** is `apps/dashboard/src/components/projects/SettingsForm.tsx`; it just gained `holdoutPercentage` and is the established home for per-project settings.
- **Money is normalised to `amountUsd`** throughout the pipeline; `summary.ts` and `proceeds.ts` both rely on it.

---

## Task 1: Verify each id's backing before writing a single reader

**Files:** none modified. Deliverable is a report.

**Interfaces:**
- Produces: the backing table Tasks 2-5 consume. If this table is wrong, every later task builds on sand.

- [ ] **Step 1: For each of the 14 unwired ids, find the function that already computes it.** Not the file whose name resembles it — the function, and what it returns. `grep` matches names; open the function and read what it computes.
- [ ] **Step 2: Record a row per id**: id · backing function (`file.ts:line`) · what it returns (shape and grain: daily? monthly? single figure?) · the unit it implies · and one of `MATCHES` / `NAME ONLY` / `NONE`.
- [ ] **Step 3: Three ids are pre-flagged as doubtful — resolve them explicitly.** `arpu` (only `summary.ts` mentions it), `new_subs` (the catalog is the ONLY file naming it), `retention_curve` (backed by `services/cohorts.ts`, outside `services/metrics`). Say for each whether a real backing exists.
- [ ] **Step 4: Note the grain mismatch for every id whose service returns a monthly or single figure** rather than a daily series. That is the work Tasks 2-5 will have to do inside the service, and knowing it now is what stops an implementer reaching for new SQL mid-task.
- [ ] **Step 5: Report. Change no code.** An id with `NONE` is a finding — it stays `supported: false` and gets reported, never a fabricated series.

---

## Task 2: Money units, then the revenue group

**Files:**
- Modify: `packages/shared/src/dashboard.ts` (widen `unit`)
- Modify: `apps/dashboard/src/components/charts/series-chart-panel.tsx` (format money)
- Modify: `apps/api/src/services/metrics/charts.ts` (+ the backing services if widening is needed)
- Test: alongside each

**Interfaces:**
- Consumes: Task 1's table.
- Produces: the money `unit` value every later money id uses.

- [ ] **Step 1: Widen `ChartSeriesResponse["unit"]`** to carry money. Keep `"count"` and `"percent"` exactly as they are — this is an addition, and every existing caller must keep compiling and behaving identically.
- [ ] **Step 2: Teach `series-chart-panel.tsx` to format the money unit.** Follow how `percent` is handled at `:162`. Money is USD; do not invent a currency selector.
- [ ] **Step 3: Wire the revenue ids Task 1 confirmed** — `mrr`, `arr`, `gross_vs_net`, and `arpu` if Task 1 found it a backing. Each case **delegates** to the service that owns the concept and reshapes to `ChartSeriesPoint[]`. If you find yourself writing `SELECT`, stop: either the service needs widening in its own file, or Task 1 said this id has no backing.
- [ ] **Step 4: If you widen a service, pin its existing caller first.** Add or identify a test that fixes the current caller's numbers, watch it pass, then widen, then watch it still pass. A widened service that quietly changes an existing card is worse than an unwired chart.
- [ ] **Step 5: Register every new reader in the schema-contract harness** and run it under `VITEST_CONTAINER_PASS=1`. It fails by name on an unregistered reader — that harness exists because this area once shipped a reader querying columns that never existed, green in CI because every test mocked the client.
- [ ] **Step 6: Commit** `feat(metrics): money unit and the revenue chart series`.

---

## Task 3: The subscription-lifecycle group

**Files:** `apps/api/src/services/metrics/charts.ts` (+ backing services), tests alongside.

- [ ] **Step 1: Wire the ids Task 1 confirmed** among `new_subs`, `trials_started`, `reactivations`, `churn`. `new_subs` is the one Task 1 flagged as possibly unbacked — if it is, leave it `supported: false` and say so.
- [ ] **Step 2: Match the existing card's definition.** `churn` and `trial_to_paid` already appear on `RevenueKpisCard`. The series must mean the same thing the tile means, and say so at the reader — an analytics definition that lives only in a reviewer's head is this area's recurring failure.
- [ ] **Step 3: Units.** `churn` is a rate. Whether it is a fraction or a percentage is decided by what the existing card shows — match it, do not choose.
- [ ] **Step 4: Register in the schema-contract harness; run the container pass.**
- [ ] **Step 5: Test** each id against a testcontainer ClickHouse with real rows. **No mocked ClickHouse.**
- [ ] **Step 6: Commit** `feat(metrics): subscription-lifecycle chart series`.

---

## Task 4: LTV, retention and trial-to-paid

**Files:** `apps/api/src/services/metrics/charts.ts`, `services/cohorts.ts` if widening is needed, tests alongside.

- [ ] **Step 1: Wire `ltv` and `trial_to_paid`** through `ltv.ts` / `ltv-extrapolation.ts` and `summary.ts`.
- [ ] **Step 2: Wire `retention_curve` through `computeRetention` (`services/cohorts.ts`)**, which lives outside `services/metrics` — that is the delegation target, not a new query.
- [ ] **Step 3: Assert equality with the existing surfaces.** Spec acceptance criterion 7: the `retention_curve` and `ltv` series must produce the SAME numbers as `/cohorts`' heatmap and `PredictedLtvCard`. Write the test that compares them directly. Two surfaces disagreeing about one number is worse than one surface missing.
- [ ] **Step 4: Register in the schema-contract harness; run the container pass.**
- [ ] **Step 5: Commit** `feat(metrics): ltv, retention and trial-to-paid chart series`.

---

## Task 5: The credits group

**Files:** `apps/api/src/services/metrics/charts.ts`, `services/metrics/credits.ts` if widening is needed, tests alongside.

- [ ] **Step 1: Wire `credit_burn` and `liability`** through `credits.ts`.
- [ ] **Step 2: `liability` is money** — use the unit Task 2 added. Credit liability is a balance, not a flow; make sure the series' grain says which.
- [ ] **Step 3: Register in the schema-contract harness; run the container pass.**
- [ ] **Step 4: Commit** `feat(metrics): credit burn and liability chart series`.

---

## Task 6: The export, measured

**Files:** `apps/api/src/services/metrics/export.ts`, test alongside.

- [ ] **Step 1: Measure the export's wall-clock BEFORE anything else in this task**, on a project with data, and write the number down. You cannot report a regression you never baselined.
- [ ] **Step 2: Confirm the export now covers every wired id.** It iterates `SYSTEM_CHART_IDS` and delegates, so coverage should follow automatically — verify that it does rather than assuming it.
- [ ] **Step 3: Measure again and report both numbers.** Roughly seven times the readers now run per request.
- [ ] **Step 4: If it is unreasonable, run the readers concurrently** — `readChartSeries`'s `paywall_view_rate` case already sets that precedent with `Promise.all`. **Do not quietly drop ids from the export**; that would re-create the coverage gap this plan exists to close.
- [ ] **Step 5: Pin the mid-stream error behaviour.** The endpoint emits `# error: <message>` and closes with HTTP 200 if a reader throws. With thirteen more readers that path is far likelier — add the test that proves a single failing reader does not abort the whole export.
- [ ] **Step 6: Commit** `feat(metrics): export covers the wired catalog`.

---

## Task 7: The commission-rate settings form

**Files:**
- Modify: `apps/dashboard/src/components/projects/SettingsForm.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: alongside

- [ ] **Step 1: One row per store**, writing through the existing `PUT`/`DELETE /dashboard/projects/:projectId/commission-rates/:store`. No new API.
- [ ] **Step 2: Offer `COMMISSION_RATE_PRESETS` with their citations shown, not summarised.** An operator choosing 15% vs 30% is making a claim about their App Store Small Business Program status; the sourcing is in `proceeds.ts` and belongs on screen.
- [ ] **Step 3: A store with no rate keeps reporting "not configured — proceeds unknown".** Offering a default is not assuming one, and these are money figures. Test this explicitly: rendering the form must not write a rate.
- [ ] **Step 4: Match the endpoint's gate exactly** — `assertProjectCapability` with `project:settings:write`. The form must not be a wider door than the API it writes through.
- [ ] **Step 5: i18n.** `en.json` has no missing-key handler, so an absent key renders as the raw key path. Grep your finished component for `t("` and confirm every key exists.
- [ ] **Step 6: Commit** `feat(dashboard): commission-rate settings form`.

---

## Task 8: ROADMAP, docs and the battery

**Files:** `ROADMAP.md`, `apps/docs` if the metrics-export page names coverage.

- [ ] **Step 1: Tick the two items that shipped** — chart-catalog series coverage and the commission-rate settings UI — noting which ids, if any, Task 1 found unbacked and left honest.
- [ ] **Step 2: CLOSE the country item with its two reasons**, not as done and not as open: the Stripe half is a deliberate ruling (a billing address is not a storefront, `stripe-webhook.ts:877-886`), and the backfill is impossible from retained data (no country column, no raw store payload) and would need a three-party re-verification campaign. Whoever reads §5 next must not re-derive this.
- [ ] **Step 3: Note `rev_per_install`** as catalogued-but-unbacked, with what would have to exist first.
- [ ] **Step 4: Update §5's score and the table's header date.**
- [ ] **Step 5: If any docs page describes the export's coverage, correct it.**
- [ ] **Step 6: Battery**, sequential and throttled, real numbers, **naming which api pass each covers**: `nice -n 19 pnpm build --concurrency=2`; `@rovenue/shared`; the dashboard suite from inside `apps/dashboard`; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`; then `VITEST_CONTAINER_PASS=1`. Known-good baselines: api non-container 414 files / 3597 tests, api container 11 files / 73 tests, dashboard 129 files / 1155 tests, shared 44 files / 842 tests, build 9/9. `pnpm --filter @rovenue/docs check:links` already exits 1 on the pre-existing `reference/methods.mdx → /docs/guides/funnel-attribution` link — report it, do not fix it here.
- [ ] **Step 7: Commit** `docs: analytics catalog coverage and ROADMAP §5 close-out` with the battery numbers in the body.

---

## Self-review notes (for executors)

- **Task 1 gates everything.** Its table decides what Tasks 2-5 wire. An id it marks `NONE` must stay `supported: false`; inventing a series for it is the worst outcome this plan can produce.
- **The moment you type `SELECT` in `charts.ts`, stop.** Either widen the owning service in its own file, or the id has no backing. A second query set drifts from the first — that is why the export was built to issue none, and why the experiments area just had to delete a duplicate results implementation.
- Task 2's unit widening is a shared-type change: every existing `ChartSeriesResponse` consumer must keep compiling and behaving identically.
- Task 4's equality assertion is the one that protects against the product disagreeing with itself in two places.
- **Do not add or remove catalog ids.** `rev_per_install` stays, unbacked and honest.
