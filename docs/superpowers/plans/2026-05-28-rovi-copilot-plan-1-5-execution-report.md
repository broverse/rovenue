# Rovi Copilot — Plan 1.5 Execution Report

**Date:** 2026-05-28
**Branch:** `worktree-rovi-copilot-plan-1-5` (worktree at `.claude/worktrees/rovi-copilot-plan-1-5`)
**Base:** local main with Plan 1 already merged (commit `d825932`)
**Plan:** `docs/superpowers/plans/2026-05-28-rovi-copilot-plan-1-5.md`

## Goal recap

Close Plan 1's deferred items: replace the misleading MRR-proxy on churn/conversion, re-add `query.productGroups.list` (offeringRepo now available), wire the transfer stub handler, and ship the 6 integration tests Plan 1 deferred.

## Completed (10/10 tasks)

| Task | Subject | SHA | Notes |
|---|---|---|---|
| 1 | Metrics churn/conversion throw not-implemented | `0914977` | Honest error replaces MRR series proxy; descriptions updated. |
| 2 | Re-add `query.productGroups.list` | `a5a238e` | `offeringRepo.listOfferings` wired; registry test extended. |
| 3 | Wire `action.subscribers.transfer` | `8d68902` | Multi-step: reassignPurchases + reassignSubscriberAccess + reassignExperimentAssignments + softDeleteSubscriberAsMerged inside one tx + audit. Subagent noticed `softDeleteSubscriberAsMerged` takes 4 args (added `new Date()`). |
| 4 | Integration test — chat round-trip | `0bb7fe9` | Uses `MockLanguageModelV3` (v6 surface — not V2). Pushed env injection up to `apps/api/tests/setup.ts` because `lib/env` parses once at module load. v6 `LanguageModelV3FinishReason` is `{ unified, raw }`, not a plain string. |
| 5 | Integration test — intent execute | `0f3498e` | `action.audiences.create` round-trip. Subagent corrected the plan's `filters: {}` to `rules: {}` after reading the actual handler payload shape. |
| 6 | Integration test — RBAC denial | `67ed89b` | **Caught a real pre-existing bug**: `ROLE_RANK` in `apps/api/src/lib/project-access.ts` had `CUSTOMER_SUPPORT: 2`, same as `DEVELOPER: 2`. Fixed to `CUSTOMER_SUPPORT: 1` so CS callers actually fail DEVELOPER-required checks. Security fix. |
| 7 | Integration test — quota 429 | `4d29c0d` | Uses `vi.mock("../../../lib/env", ...)` because the zod-frozen `env` const can't be overridden from `beforeAll`. Cleanest workaround. |
| 8 | Integration test — credentials | `43fe819` | OWNER guard + roundtrip + plaintext-leak check. 2/2 passing. |
| 9 | Integration test — prompt-injection | `41b9701` | Structural-only (allowlist + system-prompt content + spec-mirror sweep). Does not invoke a live LLM. 3/3 passing. |
| 10 | Plan 1.5 wrap | (this commit) | All 37 Rovi tests green; typecheck clean across the api package. |

## Test results

```
Test Files  15 passed (15)
     Tests  37 passed (37)
```

Files passing:
- Unit (9 files, 28 tests): pseudonymize, sterilize, system-prompt, providers, quota, intent-executor, tools/registry, rovi-reaper, rovi-retention.
- Integration (6 files, 9 tests): chat, intents, RBAC, quota, credentials, prompt-injection.

## Notable findings

### Security fix shipped under Task 6

`ROLE_RANK` previously assigned `CUSTOMER_SUPPORT` and `DEVELOPER` the same numeric rank (2). The `assertProjectAccess` ladder is `ROLE_RANK[member] >= ROLE_RANK[minimum]`, so a CUSTOMER_SUPPORT user passed checks intended to require DEVELOPER. The RBAC integration test exposed this; the implementer dropped `CUSTOMER_SUPPORT` to rank 1. This affects ALL dashboard write paths, not just Rovi — recommend a follow-up audit.

### v6 AI SDK surface confirmed

- `MockLanguageModelV3` (not V2) is what the v6 `ai/test` package exports.
- `LanguageModelV3FinishReason` is `{ unified, raw }`, not a string.
- `LanguageModel` type subsumes V2/V3 model surfaces; the Plan-1 chat route's `buildAiSdkModel` typing now compiles against v6.
- The `__setRoviModelFactoryForTests` escape hatch that landed in Plan 1 (Task 19) is what makes the chat integration test viable.

### Plan-text vs reality drift

Where the plan body and the live code disagreed, subagents preferred the live code (logged in their reports):
- `action.audiences.create` payload shape: `rules`, not `filters`.
- `softDeleteSubscriberAsMerged` signature: 4 args, not 3.
- Plan said `MockLanguageModelV2`; v6 exports `MockLanguageModelV3`.

## What's still deferred (out of scope by design)

### `action.subscriptions.cancel` and `action.subscriptions.refund` — webhook-driven

These remain stubs that throw `Error("not implemented: ...")`. Rovenue's subscription lifecycle is store-driven (Apple/Google/Stripe push cancellation and refund events; the dashboard records them, it does not initiate them). A "cancel from Rovi" surface would require a new operator-initiated mutation path that does not currently exist in this codebase. Designing it is a separate spec.

If/when those paths land, register the new handlers in `intent-handlers.ts` following the same pattern as the transfer wiring shipped in Task 3.

### `query.metrics.churn` and `query.metrics.conversion`

The tools are now honest about being unimplemented — they throw at execute time instead of silently returning MRR data. To actually implement them, add the relevant ClickHouse views (and the service helpers around them), then replace the throw with real calls. Track this against the metrics roadmap.

## Pointers

- **Plan 1 (backend)**: merged via `d825932` — see `docs/superpowers/plans/2026-05-28-rovi-copilot-backend.md` + execution report.
- **Plan 2 (frontend)**: not started. RoviPanel drawer, ai-sdk Elements integration, topbar Sparkles button, BYOK settings page. Consumes the API surface shipped by Plans 1 + 1.5 unchanged.

## Commit log (chronological)

    0d4f6cc  docs(rovi): plan 1.5 - cleanups + integration tests
    0914977  fix(rovi): metrics churn/conversion tools throw not-implemented
    a5a238e  feat(rovi): re-add query.productGroups.list (offeringRepo now available)
    8d68902  feat(rovi): wire action.subscribers.transfer to multi-step reassignment
    0bb7fe9  test(rovi): chat round-trip integration with mock LLM
    0f3498e  test(rovi): intent execute integration (audit + status transition)
    67ed89b  test(rovi): RBAC denial on intent execute  (+ ROLE_RANK fix)
    4d29c0d  test(rovi): quota guard returns 429 ROVI_QUOTA_EXCEEDED on free-tier ceiling
    43fe819  test(rovi): credentials RBAC + roundtrip (no plaintext leak)
    41b9701  test(rovi): prompt-injection structural defenses (allowlist, system prompt)
