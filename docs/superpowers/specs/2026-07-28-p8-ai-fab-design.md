# P8 — AI FAB + App Store Import (design)

**Date:** 2026-07-28
**Phase:** P8 of the paywall-builder gap-analysis plan (`2026-07-23-paywall-builder-gap-analysis.md` §7; endpoints §6.14–6.15; capability rows G + J).
**Status:** Approved design. Feeds an implementation plan.

## 1. Scope decisions (user, 2026-07-28)

1. **Imported images hot-link Apple's CDN** — image nodes are URL-only today and no asset pipeline exists; building one is out of scope (P10-adjacent follow-up). The spec's known risk: Apple artwork URLs (`*.mzstatic.com`) are third-party and can rot; the import writes them verbatim and the builder's normal image-URL editing is the recovery path.
2. **The AI FAB reuses the Rovi panel** — no bespoke mini-chat. The FAB is a visible builder-anchored opener for the existing panel (today reachable from the builder only via ⌘/Ctrl+`.` because the topbar Rovi button is covered by the builder's `inset-0` overlay).
3. **The AI-assist start tab is IN scope** — row G's third tab (free-text prompt + suggestion chips) ships alongside "From App Store".

## 2. Architecture: mutations apply CLIENT-SIDE

The builder VM holds an in-memory `config` with throttled autosave; a server-side write to `paywalls.builderConfig` while the builder is open would be clobbered by the next autosave of the stale in-memory config. Therefore **no P8 code path writes builderConfig server-side**:

- Intent handlers and the import/generate endpoints **validate and RETURN trees/patches**; the dashboard applies them to the VM (the `applyPreset` precedent: wholesale or subtree assignment → `isDirty` → autosave persists through the existing PATCH save-gate).
- The builder has no undo. Every AI/import application first stores a **one-shot pre-apply snapshot** in the VM (`configBeforeAiApply`); a "Revert" affordance restores it (cleared on the next manual edit or the next AI apply).
- Consequence: paywall chat tools are only offered when the chat request originates from the builder route (v1 constraint, enforced where tools are loaded — `loadTools` sees the request `context.route`). Outside the builder the tools are absent, so no orphan server-side application path exists.

## 3. AI FAB (§6.15, row J)

### 3.1 Entry + context
- FAB button anchored in `builder-shell.tsx`'s fixed container (z-[55]: above canvas chrome at 49/50, below modals at 60), opening the Rovi panel via the existing `RoviProvider` open state.
- The builder finally populates the ready-made-but-never-used `focusedEntityId` context field (client `copilot/types.ts:45`, server `chat.ts:72`) with the selected node id; `context.route` already carries the builder path. The system prompt gains a short paywall-context block when these are present.

### 3.2 Tools (registered via `loadTools`, names pinned in `STATIC_NAMES`)
- `query_paywall_tree` — read-only: returns the current draft's tree summary (node types, ids, localized text keys + default-locale values) so the model can ground mutations. Server-side it loads the paywall by id **scoped to ctx.projectId** and reads the DRAFT builderConfig.
- `action_paywall_editTree` — the mutation proposer. The `action_` prefix keeps `rovi-tool-ui.tsx`'s existing dispatch (`startsWith("action_")` → ApprovalCard) working unchanged. Payload:

```ts
{
  paywallId: string,
  op:
    | { kind: "insert"; parentId: string; index: number; subtree: PaywallNode }
    | { kind: "replace"; nodeId: string; subtree: PaywallNode }
    | { kind: "remove"; nodeId: string }
    | { kind: "updateProps"; nodeId: string; patch: Record<string, unknown> }
    | { kind: "setLocalizations"; locale: string; entries: Record<string, string> },
}
```

- Preview coerced into the existing flat `RoviIntentPreview` rows (no schema extension): title = human op summary ("Add timeline (3 steps)"), fields = position/target/summary rows. The real preview is the canvas after approval, backed by Revert.

### 3.3 Execute path
- The intent handler (registered as `action_paywall_editTree` in `intent-handlers.ts`) **does not write**. It: (1) verifies `payload.paywallId` belongs to `ctx.projectId` (the IDOR precedent from `intent-handlers.project-scope.test.ts` — target re-validated, not trusted); (2) structurally validates the op (subtree parses under the strict node schema; a DRY-RUN application against the paywall's current draft passes the SAVE tier — no DUPLICATE_NODE_ID, schema-valid; publish-tier gaps are allowed, matching the PATCH save-gate contract); (3) returns `{ op }` as the execution result.
- **Rovi→builder bridge:** `RoviProvider` gains a callback registry (`registerPaywallPatchListener(paywallId, fn)`); the builder VM registers while mounted. `ApprovalCard`'s execute success handler forwards an `action_paywall_editTree` result to the registered listener. Listener applies the op via `tree-ops` primitives (snapshot first), matching `updateNode`/insert semantics. If no listener is registered (builder closed mid-approval), the card shows "Open the paywall builder to apply this change" instead of silently dropping — the intent is already `executed`; the result carries the op and the card keeps it re-appliable for the session.

## 4. App Store import (§6.14, reconciled with row G)

§6.14's literal `POST /paywalls/from-app-store` (create a paywall) is reconciled with row G's placement (a start-modal tab inside an ALREADY-created paywall): the endpoint **builds and returns a tree, creates nothing**.

- `POST /dashboard/projects/:projectId/paywalls/from-app-store`, body `{ url: string }`. URL validated with the `validateStoreUrl(url, "apps.apple.com")` precedent (funnel `settings-normalize.ts`); the app id is extracted from the path (`/id(\d+)/`).
- Fetch via `ssrfSafeFetch` against `itunes.apple.com/lookup?id=<id>&country=<from-url-or-us>` — the codebase's first listing-metadata call. Response fields used: `trackName`, `description`, `artworkUrl512`, `screenshotUrls` (first 3, `IMPORT_MAX_SCREENSHOTS = 3`), `artistName`. Non-200/malformed/empty-results → 422 with a typed error code (`APP_STORE_LOOKUP_FAILED` / `APP_NOT_FOUND`), never a 500.
- A pure `buildImportTree(metadata, defaultLocale)` service assembles: root stack → icon image node (artwork), title text (trackName), body text (description truncated to `IMPORT_MAX_DESCRIPTION_CHARS = 280`, cut at a word boundary with an ellipsis), screenshots as a `carousel` of image nodes (the wave-C type — exists), then the commerce skeleton (packageList + purchaseButton) so the draft passes the save tier and warns (not blocks) on publish-tier gaps. All strings land in the DEFAULT LOCALE's localization table under generated keys; node ids generated collision-free.
- Response `{ data: { config: BuilderConfig, metadata: { name, iconUrl } } }`. The start modal's new "From App Store" tab: URL input → preview card (icon + name) → Apply via the existing choose/arm-confirm data-loss path → VM applies (snapshot + revert like §2).

## 5. AI-assist start tab (row G)

- Third start-modal tab: free-text prompt + suggestion chips (a named-constant list of 4-5 canned prompts, e.g. "3-tier subscription with trial", "minimal single-plan paywall").
- One-shot generation, not chat: `POST /dashboard/projects/:projectId/paywalls/:id/paywall-generate`, body `{ prompt: string }`. Server: `roviQuotaGuard` + `resolveProviderForProject` (BYOK-first, env fallback, `ROVI_NOT_CONFIGURED` surfaced to the tab as the existing `rovi-missing-config` affordance) + a structured-output generation (AI-SDK `generateObject` against a constrained tree-shape schema) → the SAME validation the intent handler uses (strict parse + save-tier dry-run; one regeneration retry on validation failure, then 422 `GENERATION_INVALID`) → returns `{ config }`. The tab applies it via the same arm-confirm + snapshot path.
- Prompt-injection posture: generated/imported text reaches ONLY localization VALUES and image URLs (URLs validated http(s)); node ids, types, and structural fields come from the server-side assembly/schema constraints, never verbatim from model/store text. The copilot suite's existing prompt-injection tests extend to the new tools.

## 6. What P8 does NOT touch

Shared paywall schema (all trees compose the existing 15 node types), renderers, SDKs, `copilot/intents.ts` route (toolName-generic), validator codes (none added), placements/serving. `RoviIntentPreview` shape unchanged.

## 7. Testing

- **iTunes fetch:** parse happy path, id extraction from URL variants, SSRF guard usage, 422 paths (not-found, malformed), screenshot cap.
- **buildImportTree / generation validation service:** output passes strict schema + save tier; unique node ids (mutation-check: forcing an id collision fails); description truncation; strings only in localization values.
- **Intent handler:** IDOR (foreign paywallId → rejected), each op kind validated, dry-run save-tier rejection (e.g. duplicate id insert → handler refuses), returns op without writing (repo write spies never called).
- **Registry:** `STATIC_NAMES` pin updated; tool gating by builder route (present on builder route, absent elsewhere).
- **Dashboard:** FAB opens the panel; focusedEntityId populated from selection; bridge applies an op to the VM with snapshot + revert; no-listener fallback card; start-modal tabs (URL flow with preview, AI flow incl. missing-config state, chips fill the prompt); arm-confirm preserved.
- **Test locations:** api tests may live in BOTH `apps/api/src/**` and `apps/api/tests/` — every task's "existing tests?" check must scan both (the P7 lesson).

## 8. Collision + sequencing

The parallel session's ledger shows RN-bridge/P4c work in renderers/SDKs — P8's surface (copilot services/routes, paywalls route, start-modal, builder-shell, rovi components) has **low overlap**; `top-bar.tsx` is avoided (FAB anchors in builder-shell, not the TopBar). Single block, no gate. Standing constraints: current branch, sequential dispatch, explicit staging, no bare `git stash`, named constants, static-literal `t()` keys with same-task `en.json` entries.
