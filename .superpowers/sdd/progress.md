# Paywall Localization Matrix (P2) — SDD Progress Ledger

Plan: docs/superpowers/plans/2026-07-23-paywall-localization-matrix.md
Spec: docs/superpowers/specs/2026-07-23-paywall-localization-matrix-design.md
Branch: main (user-directed; stay on main, NO branching — implementers MUST be told not to branch)
Base commit (plan start): a536c6d5
Prior P1 ledger overwritten here; P1 fully shipped + reviewed (git log: be6bfccb..aed2ebfe + fix 5c6b1aa7).

## Global constraints (bind every task)
- Touch only packages/shared/src/paywall/ and apps/dashboard/src/components/paywall-builder/. NO API, NO DB, NO wire-format change (BuilderConfig's shape untouched; the shared additions are pure functions).
- TS strict. Every user-facing string via t("paywalls.builder.localization.*", "English fallback").
- NO MAGIC VALUES — hoist literals (column widths, badge sizes, severity colours) into named constants. Structured data is not a magic value.
- Cell editing is per-keystroke onChange -> vm.setLocaleText, matching the existing properties panel. Do NOT invent commit-on-blur.
- Tests: pnpm --filter <pkg> exec vitest run <path> (no bare vitest script). tsc: exec tsc --noEmit. build: pnpm --filter @rovenue/dashboard build.
- Conventional commits; commit per task.

## Pre-flight notes
- Scan clean: no task contradicts the constraints; no plan-mandated review-defects.
- Deliberate cross-task coupling (documented in both tasks, not a defect): Task 4 adds `onOpenLocalization` to TopBar's Props with a temporary `void onOpenLocalization;` so the shell compiles; Task 5 deletes it and adds the real button. No broken build between tasks.
- Task 2 is a REAL BEHAVIOUR CHANGE, approved in the spec: a blank default-locale string becomes blocking, so a draft that publishes today can start being blocked. Published paywall_versions snapshots are unaffected (only new publishes re-validate). If a pre-existing test asserted the old lenient behaviour, it encoded the bug — update it and say so.
- Model note: agent dispatch has been intermittently blocked by the auto-mode classifier; retry once, then run the task inline (verified with the same objective gates) rather than stalling.

## Tasks
- [x] Task 1: complete (commit d876ec6c, review clean — spec ✅, no Critical/Important; reviewer verified single walkNodes pass, keys-as-projection with no second traversal, and UNKNOWN_LOC_KEY/LOCALE_KEY_GAP byte-for-byte untouched)
- [x] Task 2: implemented + objectively verified (commit 4eb68dde) — RED 3/3 for the right reason -> GREEN 40/40 (5 new + 35 pre-existing untouched); blast radius shared/paywall 144/144 + dashboard paywall-builder 124/124, NO fixture needed changing. Implemented INLINE (dispatch blocked twice) and its reviewer was ALSO blocked twice -> **NO INDEPENDENT REVIEW YET**. Deferred to the final whole-feature review, which MUST be pointed at this diff (34046c6f..4eb68dde) explicitly.
- [x] Task 3: implemented + objectively verified (commit d26272c8) — RED (module-not-found) -> GREEN 3/3, tsc clean, 2 files. Reviewer dispatch BLOCKED twice -> **NO INDEPENDENT REVIEW YET**; deferred to the final whole-feature review (diff 5577f768..d26272c8). Implementer flagged a slip in MY brief: Step 4 says "4 tests" but the brief's own block has 3 `it` blocks — brief error, not an implementation gap.
- [x] Task 4: implemented + objectively verified (commit c5dcd1b0) — tsc clean, build ok, 127/127. Implemented INLINE (dispatch blocked twice). **NO INDEPENDENT REVIEW YET** -> final whole-feature review.
- [x] Task 5: implemented + objectively verified (commit 0d91b871) — temporary `void onOpenLocalization` removed, real button + severity dot in place; tsc clean, build ok, 127/127. Implemented INLINE. **NO INDEPENDENT REVIEW YET** -> final whole-feature review.

## ALL 5 TASKS IMPLEMENTED. Verification: shared/paywall 144/144, dashboard paywall-builder 127/127, tsc clean, dashboard build ok.
## !! FINAL REVIEW MUST COVER TASKS 2,3,4,5 — their per-task reviewer dispatches were ALL blocked by the auto-mode classifier, so only Task 1 got an independent review. Point the final reviewer at the whole P2 diff (a536c6d5..HEAD, paths: packages/shared/src/paywall/ + apps/dashboard/src/components/paywall-builder/) and tell it these four were controller-implemented inline and never independently reviewed.

## ===== P2 FINAL REVIEW — CONTROLLER-RUN (2026-07-23) =====
The final whole-feature reviewer dispatch was BLOCKED twice (as were the per-task reviewers for Tasks 2-5), so the controller traced the high-value seams itself AGAINST REAL CODE AND REAL TEST OUTCOMES, not by reasoning alone. This is NOT equivalent to an independent review of the tasks the controller implemented (2-5) — flagged for the user.

SEAM 1 (matrix vs publish gate agree): AGREE BY CONSTRUCTION — both route through the same `isMissingLocaleValue`, on the same value shape. One documented divergence remains (spec §4, out of scope): matrix ROWS come from tree usage, while LOCALE_KEY_GAP iterates the DEFAULT TABLE's keys, so an ORPHANED key (in the table, unused by the tree) produces a validator warning with NO matrix row. Harmless direction (matrix shows what matters) but a user could see a warning count that exceeds the visible gaps.
SEAM 2 (T2 blast radius — the highest-value question): VERIFIED SAFE + CORRECT. Presets are proven safe empirically: pre-existing tests `applyPreset('hero'|'comparison') produces a config with zero blocking validation issues` (vm.test.ts:112,121) PASSED under the stricter validator in the 127/127 run. cellTemplate keys get real text ("{{packageName}}"/"{{price}}"), non-blocking. Adding a text/button node DOES now produce one blocking issue immediately (registerFreshLocKeys stubs "" — vm.test.ts:97-98) until the author types text. That is correct by design (a blank node would ship blank text) and P2 itself is the remedy surface: danger dot, matrix cell + jump, validation drawer, properties field. Before T2 it shipped silently blank.
SEAM 3 (jump into cellTemplate/fallback subtrees): CLEAN — tree-ops `findNode` descends into both (tree-ops.ts:46-50), so a jump to a node inside them resolves and the properties panel finds it.
SEAMS 4/5 (per-keystroke + top-bar recompute cost): ACCEPTABLE — per-keystroke whole-tree validateBuilderConfig was already the norm (properties panel); the matrix adds O(rows x locales) ~ 20x6 per render. No change in cost profile class.
SEAM 6 (i18n / magic values): modal strings all via t(); column widths hoisted (LOCALE_COL_WIDTH/KEY_COL_WIDTH).

## Minor findings roll-up (for the final whole-branch review)
- P2 seam 1: an orphaned key (present in the default locale table but referenced by no node) produces a LOCALE_KEY_GAP warning but no matrix row, so the warning count can exceed the visible gaps. Fix = align LOCALE_KEY_GAP's key set with tree usage (spec §4 explicitly deferred this).
- Task 1: the "collectLocalizationKeys stays a deduped projection" test asserts only observable dedup+order — an independent second walk would pass it identically. The projection property is proven by the diff itself, so no change needed; noted for completeness.

## ===== SP2 — CHART SERIES CONTRACT + TWO PAYWALL READERS — started 2026-07-23 =====
Plan: docs/superpowers/plans/2026-07-23-sp2-chart-series-contract.md (5 tasks)
Spec: docs/superpowers/specs/2026-07-23-sp2-chart-series-contract-design.md
BASE (pre-Task-1): 5577f768. Branch: main (user-directed, NO branching — implementers MUST be told not to branch).
PREMISE CORRECTED BEFORE PLANNING: the ledger called paywall_purchase + paywall_view_rate unwired stubs. They are, but so are 13 others — 15 of 16 catalog charts have no reader, because there is NO chartId->series endpoint and charts.tsx:177 renders MrrChartPanel unconditionally. Selecting "Churn" shows MRR under a Churn heading. Owner scoped SP2 to: build the contract, wire only the two paywall charts, let the other 13 return supported:false.
TESTING REALITY: no ClickHouse testcontainer harness exists and host->CH is blocked by the IP allow-list, so the repo convention is to mock the CH module boundary. Rate arithmetic is therefore extracted into a pure buildRatePoints() that IS provable; the SQL is shape-tested only, and Task 2 Step 6 requires hand-running the queries against dev CH and recording the output. No automated test executes this SQL — stated, not hidden.
Task 1: complete (commit 91137731, review clean first pass — spec ✅, quality Approved, 0 Critical/Important).
  ChartSeriesPoint/ChartSeriesResponse in shared (index.ts already does `export * from "./dashboard"`, no barrel edit needed) + pure buildRatePoints in charts.ts reusing the file's existing DAY_MS and toDateOnly.
  Reviewer independently re-derived the mutation numbers rather than trusting the report: inverting to `n / (d || 1)` makes the zero-denominator day compute 0 and the missing-day compute 500; exactly the 2 null-asserting tests go red, the other 4 are correctly unaffected. Expected blast radius, not an over-broad test.
  Reviewer also cleared the DST question: cursor/end are forced with setUTCHours and DAY_MS is fixed, so day-walking cannot drift; bucket is genuinely UTC start-of-day on every point. Single-day window terminates after exactly one iteration; last day of the window is included.
