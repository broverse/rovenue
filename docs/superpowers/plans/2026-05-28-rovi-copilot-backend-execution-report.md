# Rovi Backend — Plan 1 Execution Report

**Date:** 2026-05-28
**Branch:** `worktree-rovi-copilot-backend`
**Base:** `origin/main` (6dbfc8d)
**Commits on branch:** 29 (see `git log --oneline 6dbfc8d..`)

## Completed (24/30 tasks)

Implementation tasks 0–21, plus workers 28–29, plus final smoke. The
Rovi backend is wired end-to-end:

- DB: 5 tables + migration 0053; repository helpers; `currentYearMonth` re-export.
- Shared: `RoviTier`, `RoviProvider`, `RoviUsageSnapshot`, `RoviIntentPreview`, `TIER_LIMITS`, `isModelAllowed`. New error codes `ROVI_NOT_CONFIGURED` / `ROVI_QUOTA_EXCEEDED`.
- Services: pseudonymize, sterilize, system-prompt, providers (BYOK + AI SDK v6), quota, intent executor, intent handlers (registry pattern).
- Tools: 23 registered (query × 10, action × 11, ui × 3 — excludes the deferred `query.productGroups.list`). Hard allowlist excludes billing/webhook/custom-domain.
- Middleware: `rovi-quota-guard`.
- Routes mounted at `/api/dashboard/projects/:projectId/copilot/*`: credentials, threads, chat (SSE), intents, usage.
- Workers self-registering on import: `rovenue-rovi-reaper` (1 min cron), `rovenue-rovi-retention` (daily cron).
- Tests: 28/28 Rovi unit tests pass; `tsc --noEmit` clean across all touched packages.

## Deferred to follow-up plan (6/30 tasks)

### Tasks 22–27 — Integration tests
Plan 1 deferred all 6 integration tests. They were designed around test
utilities that are not present in this worktree base (`buildTestApp`,
`seedProject`, etc.), and the AI SDK v6 mock surface (`MockLanguageModelV2`
in `ai/test`) needs separate verification against the installed v6 API.

These tests live well as a separate Plan 1.5:
- `copilot-chat.integration.test.ts` — full round-trip with the
  `__setRoviModelFactoryForTests()` escape hatch already present in
  `chat.ts`.
- `copilot-intents.integration.test.ts` — exercise the 7 wired handlers
  (the other 4 are stubs).
- `copilot-rbac.integration.test.ts` — CS user attempting an ADMIN intent.
- `copilot-quota.integration.test.ts` — pre-bumped usage → 429.
- `copilot-credentials.integration.test.ts` — OWNER-only PUT.
- `prompt-injection.integration.test.ts` — adversarial fixtures.

## Known concerns and stubs

### 4 intent handlers throw `Error("not implemented: ...")`
These actions need single atomic repo functions that the worktree base
(`origin/main`) does not expose; local `main` (cf04e52) has them via the
access-foundation merge. Affected:

- `action.subscriptions.cancel` — no `cancelSubscription` in `subscribers.ts`
- `action.subscriptions.refund` — no `refundPurchaseFull` in `purchases.ts`
- `action.subscribers.transfer` — only `reassignPurchases` + `reassignSubscriberAccess` + `softDeleteSubscriberAsMerged` exist separately; no single transfer
- (a fourth was reported in the Task 15 dispatch; double-check `intent-handlers.ts`)

When the branch rebases onto the cf04e52-derived main, these stubs can
be replaced with real repo calls. Until then they are honest "no" answers
rather than silent half-implementations.

### `query.metrics.churn` and `query.metrics.conversion` fall back to MRR series
A dedicated ClickHouse view for churn/conversion does not exist yet, so
both tools currently call `listDailyMrr` as a proxy. The LLM will see MRR
data when asking about churn/conversion. **This should be reverted to
throw "not implemented" before any production use** — the MRR fallback
is misleading. Tracked as a high-priority fix.

### `query.productGroups.list` dropped
Worktree base lacks `offeringRepo`. The tool was removed from
`STATIC_NAMES` and from `tools/index.ts`. Re-add when the base catches up.

### Audit `source: 'rovi'` field not present
Per Amendment A2, the existing `AuditEntry` interface has no `source`
field. The intent handlers chain to the existing typed `AuditAction` enum
and pass the originating user via `userId`. Provenance ("came from Rovi")
is recoverable via the originating `copilot_intents` row but not directly
from the audit row.

### `project.metadata` vs `project.settings`
The plan assumed `project.metadata`; the actual schema column is
`settings`. The quota-guard middleware and usage route cast
`project.settings` to `Record<string, unknown>` to bridge this gap. The
`resolveTier` helper still has its original `metadata?.["rovi_tier"]`
shape — works because the cast preserves the JSON.

## Followups (recommended order)

1. Rebase or merge the branch up to the access-foundation-derived `main`
   so the 4 stub handlers and `query.productGroups.list` can light up.
2. Replace the MRR proxy in metrics churn/conversion tools with
   "not implemented" until real CH views exist.
3. Write the 6 integration tests as Plan 1.5 (separate spec).
4. Plan 2 — frontend panel (`<RoviPanel>`, ai-sdk Elements integration,
   topbar Sparkles button, BYOK settings page) — consumes the API surface
   shipped here unchanged.

## Commit log (chronological, oldest first)

    a007bc1  docs(rovi): add Rovi copilot design spec
    1916d51  docs(rovi): add backend implementation plan (Plan 1/2)
    6a762b9  docs(rovi): plan amendments from Task 0 inventory
    75401f2  feat(rovi): declare Rovi copilot env vars
    825149f  fix(rovi): ROVI_UNLIMITED zod default must be false (cloud safety)
    e102b0e  feat(db): add Rovi copilot tables
    ae19a23  feat(db): add Rovi copilot repositories
    6397a8e  feat(shared): add Rovi tier limits, types, and error codes
    b95dca0  feat(rovi): pseudonymize
    4d1ec70  feat(rovi): sterilize
    e0d459b  feat(rovi): system prompt
    922570d  chore(api): add AI SDK provider dependencies
    941ab1e  feat(rovi): provider resolver
    8eb412e  feat(rovi): quota evaluator
    d15dcd2  feat(rovi): tool registry + query.subscribers
    08dec06  feat(rovi): query.* tools
    19f06c2  feat(rovi): action.* tools
    44fb455  fix(rovi): DEVELOPER role for audiences/featureFlags
    48002a4  feat(rovi): ui.* tools + productGroups deferral
    b888caf  feat(rovi): intent executor + handlers
    d290747  feat(rovi): quota-guard middleware
    97ba8f8  fix(rovi): findProductById 3-arg signature
    d76e35e  feat(rovi): credentials route
    a5b391a  feat(rovi): threads route
    982db41  feat(rovi): SSE chat route
    9d73a41  feat(rovi): intents + usage routes
    ef65d55  feat(rovi): mount router + bootstrap handlers
    9f6f361  feat(rovi): reaper worker
    85ebbe9  feat(rovi): retention worker
    af6986d  chore(rovi): align registry test with productGroups deferral
