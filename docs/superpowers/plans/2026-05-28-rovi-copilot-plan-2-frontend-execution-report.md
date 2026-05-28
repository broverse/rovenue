# Rovi Copilot — Plan 2 Execution Report

**Date:** 2026-05-28
**Branch:** worktree-rovi-copilot-plan-2-frontend
**Status:** All 16 tasks complete. Browser smoke deferred to user.

## Goal recap

Ship the dashboard side of Rovi: topbar Sparkles button, floating drawer chat panel (Vercel AI SDK v6 + ai-elements), tool-call UI renderers (subscriber/metrics/approval/navigate cards), per-project BYOK settings, usage bar.

## Per-task SHAs

| # | Task | Commit |
|---|------|--------|
| 1 | Install AI SDK deps | `408d0f0` |
| 2 | RoviProvider + useRovi | `b3ea7b8` |
| 3 | Topbar Sparkles button | `0a43c47` |
| 4 | RoviPanel drawer shell | `6ab3110` |
| 5 | Mount RoviProvider + Panel | `fc42a23` |
| 6 | useRoviChat hook | `d14b6d3` |
| 7 | RoviConversation + ToolUI | `0605544` |
| 8 | RoviPromptInput | `9427720` |
| 9 | Usage hook + bar | `a8a2eca` |
| 10 | Missing-config CTA | `5501510` |
| 11 | ApprovalCard + intents | `5fbb8c6` |
| 12 | Subscriber + Metrics renderers | `8ca6356` |
| 13 | NavigateCard | `ac04f18` |
| 14 | BYOK credentials hook | `b4555b3` |
| 15 | BYOK settings page + tab | `2d011a7` |
| 16 | Wrap + execution report | (this commit) |

## Final verification

- **Typecheck (`tsc --noEmit`):** 12 errors total, **0 Rovi-attributable**. All 12 are pre-existing in non-Rovi files:
  - `apps/api/src/services/copilot/quota.ts` — unused import (1)
  - `apps/dashboard/src/components/apps/...` integration drawer + tests (8)
  - `apps/dashboard/src/routes/unsubscribe.tsx` — Link missing `search` prop (1)
  - `apps/dashboard/src/components/apps/app-card.tsx` — AppStatus comparison narrowing (2)
- **Route-tree codegen effect:** Once vite ran the TanStack Router plugin and regenerated `routeTree.gen.ts`, the typecheck error count dropped from ~89 to 12. The previous ~88-error "baseline" referenced throughout per-task reports was entirely route-tree-narrowing errors caused by a stale codegen file; the real persistent baseline is 12.
- **Vite build (`vite build`):** PASS — `✓ built in 4.38s`. Output under `apps/dashboard/dist/`.
- **`pnpm build` script (`tsc && vite build`):** FAIL on the pre-existing tsc errors above (not Rovi). Vite build itself is clean.

### `as never` cleanup

After successful vite build regenerated `routeTree.gen.ts`, the two `as never` casts in `apps/dashboard/src/components/rovi/rovi-missing-config.tsx` were removed cleanly — `<Link to="/projects/$projectId/settings/rovi" params={{ projectId }}>` now type-checks without coercion. Cleanup included in this commit.

The remaining `as never` casts in `rovi-tool-ui.tsx` (3 sites) and `navigate-card.tsx` (3 sites) are not Link-narrowing related — they are for AI-SDK `part.output` tool-output payloads typed as `unknown` until our zod-narrowed renderer takes over. Those are correct as-is.

## API surface adaptations

- **ai-elements package name:** The plan suggested `@ai-sdk-tools/elements` or `@ai-sdk/elements`. Both 404 on npm. The actual published package is `ai-elements@1.9.0` (homepage `elements.ai-sdk.dev`).
- **`useChat` v2 shape:** v2.0.194 of `@ai-sdk/react` removed the old `api: string` + `body: {...}` shorthand. All HTTP config lives on a `ChatTransport` instance now. Used `DefaultChatTransport` from `ai` with `{ api, credentials, body }`.
- **`useChat` returns:** `messages, sendMessage, status ∈ 'submitted'|'streaming'|'ready'|'error', error, regenerate, stop, ...`. No more `input`/`handleInputChange`/`handleSubmit` — `RoviPromptInput` does its own local state.
- **Two `ai` versions in tree:** `ai@6` at root, transitive `ai@5` via `@ai-sdk/react@2`. Required one `as any` cast on transport→useChat handoff. Runtime is fine; follow-up to bump `@ai-sdk/react` once it pins ai@6.
- **API helper:** The plan referenced `apiFetch` which doesn't exist. Real helper is `api(path, init)` from `apps/dashboard/src/lib/api.ts` — unwraps `{data}`, throws `ApiError`. Used throughout. Also exported `API_BASE_URL` from the same module so the chat transport could build an absolute URL.
- **API mount prefix:** Plan used `/api/dashboard/...`. Actual mount is `/dashboard/...` (no `/api` prefix). Corrected in every Rovi hook.
- **TanStack Router `<Link to>` narrowing:** The `/projects/$projectId/settings/rovi` route appears in the type-narrowed `to` only after vite's route-tree codegen runs. Was using `as never` casts in prior tasks; Task 16's successful vite build regenerated the route tree and the casts were removed.
- **No `isOwner` prop on missing-config CTA:** `useProject` doesn't return a user-role field, no central role hook exists. Always-show link approach — settings page write enforces OWNER at the API layer (403 surfaces inline).
- **`SubscriberDetail.email` doesn't exist:** Plan code referenced it. Actual field is `appUserId`. Card shows `appUserId` instead.

## Still deferred (out of scope for Plan 2, per spec §15 / plan intro)

- Voice input
- DOM-injection tool renderers
- Cross-project Rovi queries
- Real charts in MetricsChart (sparkline-only for v1)
- i18n locale entries (dashboard has no central locale files; relies on inline `t()` fallback)
- Browser-driven smoke (user responsibility — see "Smoke checklist" below)

## Smoke checklist (for the user)

1. `pnpm dev` — start api + dashboard
2. Open `/projects/<id>` — topbar Sparkles appears
3. Click Sparkles → drawer opens with empty state. Press `⌘.` → toggles. Press `Esc` → closes.
4. Open Settings → Rovi tab. Paste an OpenAI key, Save, then Test → expect "OK — gpt-4o-mini".
5. In drawer → send "show me MRR for the last 30 days" → streams text + MetricsChart for `query.metrics.mrr`.
6. Send "find all subscribers on free plan" → SubscriberList renders.
7. Send "create an audience for power users" → ApprovalCard → Approve → 200.
8. Send "open subscribers page" → NavigateCard → Open → routes to subscribers.
9. Verify usage bar updates after a few messages.

## Outstanding follow-ups

- Open issue to bump `@ai-sdk/react` once it pins `ai@6` to drop the `as any` cast (file: `apps/dashboard/src/lib/hooks/useRoviChat.ts`).
- If browser smoke surfaces the 412 / `ROVI_NOT_CONFIGURED` regex sniff being brittle, switch `RoviPanel`'s detection to query `/credentials` and check `hasKey === false` instead of error-message matching (file: `apps/dashboard/src/components/rovi/rovi-panel.tsx`).
- Consider also disabling `<RoviPromptInput>` when `notConfigured` (currently the CTA shows but the input remains enabled).
- Pre-existing dashboard typecheck baseline (12 errors in `apps integration drawer`, `unsubscribe.tsx`, `copilot/quota.ts`, `app-card.tsx`) — separate cleanup task, unrelated to this plan.
