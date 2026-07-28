# P7 — A/B from the Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch a paywall-level A/B test from inside the builder in one action — duplicate-or-pick variant B, default-Everyone audience, placement repoint — with stop-with-winner healing the placement.

**Architecture:** One atomic §6.19 orchestration endpoint (`POST /dashboard/projects/:projectId/paywalls/:id/experiments`) built on an extracted experiment-create service; a TopBar popover consuming existing hooks; a small extension to the existing stop handler. Zero SDK-wire/shared-schema/renderer changes.

**Tech Stack:** Hono + Drizzle + Zod (api), React + impair + react-query (dashboard), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-p7-builder-experiments-design.md` — read it first.

## Global Constraints

- **Stay on the current branch. Never create a branch or worktree.** The user manages branching.
- **Never dispatch implementers in parallel**; a parallel session may reappear on this tree — stage ONLY your own files (explicit `git add` paths, never `-A`), never bare `git stash`.
- **No magic values** — names like `EVERYONE_AUDIENCE_NAME`, `DEFAULT_VARIANT_SPLIT`, key-retry counts are named constants.
- New UI copy via `t("key", "English default")` **and** the `en.json` entries land in the same task (Task 5) — no deferred-i18n split in this phase.
- API responses `{ data: T }` via `ok()` / `HTTPException`; Zod for input; TS strict everywhere.
- `audit()` runs inside the caller's Drizzle tx (CLAUDE.md).
- Element-level A/B is DEFERRED: the popover renders the ELEMENT option disabled with "coming soon". No code path may create `type: ELEMENT`.
- Verification commands: `pnpm --filter @rovenue/api exec vitest run <files>`, `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`, `tsc --noEmit` per package. Route-test mocking idiom to copy: `apps/api/src/routes/dashboard/products.store-catalog.test.ts` (NOT integrations.test.ts — it's full-app style).

## File Structure

- `apps/api/src/services/experiment-create.ts` — NEW: validated experiment creation (extracted from the POST / handler) + `findOrCreateEveryoneAudience`.
- `apps/api/src/routes/dashboard/experiments.ts` — POST / delegates to the service; stop handler gains winner-repoint.
- `apps/api/src/routes/dashboard/paywalls.ts` — new `.post("/:id/experiments", …)` sub-route (mounted on the existing paywalls chain).
- `packages/db/src/drizzle/repositories/audiences.ts` — add `findMatchAllAudiences`.
- `apps/dashboard/src/components/paywall-builder/experiment-popover.tsx` — NEW: popover (form + status panel).
- `apps/dashboard/src/components/paywall-builder/top-bar.tsx` + `builder-shell.tsx` — button + `onOpenExperiment` threading.
- `apps/dashboard/src/lib/hooks/` — reuse `useExperiments`/`useStartExperiment` (exist, `useExperiments.ts`); placements/audiences/paywalls lists: reuse the existing project hooks if present (grep `usePlacements`, `useAudiences`, `useProjectPaywalls` under `src/lib/hooks/` first), else define thin `useQuery` wrappers INSIDE `experiment-popover.tsx` following the `useOfferingResolvedPrices.ts` rpc/unwrap idiom.
- `apps/dashboard/src/i18n/locales/en.json` — `paywalls.builder.experiment.*` keys.

---

### Task 1: Experiment-create service + Everyone audience helper

**Files:**
- Create: `apps/api/src/services/experiment-create.ts`
- Modify: `apps/api/src/routes/dashboard/experiments.ts` (POST / handler, lines ~166-243, becomes a thin delegate)
- Modify: `packages/db/src/drizzle/repositories/audiences.ts` (add `findMatchAllAudiences`)
- Test: `apps/api/src/services/experiment-create.test.ts`

**Interfaces:**
- Consumes: `drizzle.experimentRepo.{generateExperimentKey, createExperiment, findExperimentByKeyInProject?}` (check the repo for a by-key finder; if absent add `findExperimentByKey(db, projectId, key)`), `drizzle.audienceRepo.{findDefaultAudience, findAudienceInProject, createAudience}`, `assertPaywallVariantsValid` (export it from experiments.ts or move it into this service — move it: the service is its natural home), shared `experimentSchema`.
- Produces (Task 2 + the POST / route depend on these exact signatures):

```ts
export const EVERYONE_AUDIENCE_NAME = "Everyone";
export const EXPERIMENT_KEY_MAX_ATTEMPTS = 5;

export interface CreateExperimentInput {
  projectId: string;
  name: string;
  description?: string;
  type: ExperimentType;                 // callers pass PAYWALL etc.; no ELEMENT path in P7 UI
  audienceId: string;
  variants: ExperimentVariant[];        // the shared-schema variant type
  metrics?: string[];
  mutualExclusionGroup?: string;
}

/** Validates (shared schema + audience membership + paywall variants) and inserts as DRAFT.
 *  Key strategy: generate → SELECT-precheck → single INSERT, up to EXPERIMENT_KEY_MAX_ATTEMPTS.
 *  Works inside a caller's tx (a unique-violation retry loop cannot — a violation aborts the tx),
 *  and the unique index stays the backstop for the astronomically-unlikely precheck race. */
export async function createExperimentValidated(
  db: DbOrTx,
  input: CreateExperimentInput,
): Promise<Experiment>;

/** Spec §3.2 preference order: isDefault audience → rules-deep-equals-{} (prefer name "Everyone") → insert { name: "Everyone", rules: {} }. */
export async function findOrCreateEveryoneAudience(
  db: DbOrTx,
  projectId: string,
): Promise<{ id: string }>;
```

New repo function:

```ts
// audiences.ts — rules is jsonb; @> both ways is deep-equality for objects.
export async function findMatchAllAudiences(db: Db, projectId: string): Promise<Audience[]> {
  return db.select().from(audiences)
    .where(and(
      eq(audiences.projectId, projectId),
      sql`${audiences.rules} = '{}'::jsonb`,
    ))
    .orderBy(asc(audiences.name));
}
```

- [ ] **Step 1: Write failing tests** (`experiment-create.test.ts`, vi.mock the drizzle barrel the way `products.store-catalog.test.ts` mocks its deps):

```ts
describe("createExperimentValidated", () => {
  it("inserts a DRAFT experiment with a server-assigned key", async () => { /* repo mocks: precheck select → null, createExperiment echoes input; assert status DRAFT, key from generateExperimentKey, input.variants passed through */ });
  it("rejects variants failing the shared schema (weights not summing to 1)", async () => { /* expect throw before any insert */ });
  it("rejects an audience outside the project", async () => { /* findAudienceInProject → null → HTTPException 400 */ });
  it("rejects a PAYWALL variant whose paywallId is foreign", async () => { /* assertPaywallVariantsValid path: findPaywallsByIds returns fewer ids */ });
  it("regenerates the key when the precheck finds a collision", async () => { /* first precheck returns a row, second null; createExperiment called once with the SECOND key */ });
  it("gives up after EXPERIMENT_KEY_MAX_ATTEMPTS collisions", async () => { /* precheck always hits → throws */ });
});

describe("findOrCreateEveryoneAudience", () => {
  it("prefers the isDefault audience", async () => { /* findDefaultAudience → {id} → returned, no create */ });
  it("falls back to a rules-{} audience preferring the one named Everyone", async () => { /* findDefaultAudience null; findMatchAllAudiences → [{name:'All'},{name:'Everyone'}] → Everyone's id */ });
  it("creates Everyone with rules {} when nothing matches", async () => { /* both finders empty → createAudience called with { name: EVERYONE_AUDIENCE_NAME, rules: {} } */ });
});
```

- [ ] **Step 2: Run to verify failure:** `pnpm --filter @rovenue/api exec vitest run src/services/experiment-create.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** the service; move `assertPaywallVariantsValid` (experiments.ts:46-82) into it and re-export or import it in experiments.ts for the DRAFT-update path that still uses it.
- [ ] **Step 4: Refactor** experiments.ts POST / to: parse body → capability check → `createExperimentValidated(drizzle.db, { …body })` → `invalidateExperimentCache` → `audit` → `ok({ experiment })`. Delete the inline retry loop and the `.cause`-unwrapping comment block (behaviour preserved via precheck strategy — the unique index is still the backstop; note this in the commit message).
- [ ] **Step 5: Run** the new tests + any existing experiments route tests (`ls apps/api/src/routes/dashboard/experiments*.test.ts`; run what exists) + `tsc --noEmit` on api and db packages — PASS.
- [ ] **Step 6: Commit:** `refactor(api): extract validated experiment creation + Everyone audience helper`

---

### Task 2: §6.19 endpoint — atomic builder launch

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts` (append `.post("/:id/experiments", …)` to the chain — locate the chain by symbol; keep it before any parameterized route it could shadow, mirroring how offerings ordered `/:id/resolved`)
- Test: `apps/api/src/routes/dashboard/paywalls.experiments.test.ts`

**Interfaces:**
- Consumes: Task 1's `createExperimentValidated`, `findOrCreateEveryoneAudience`; `drizzle.paywallRepo.{findPaywallById, findPaywallByIdentifier, createPaywall}`; `drizzle.placementRepo.{findPlacementById, updatePlacement}`; `placementRowsSchema`/target types from `@rovenue/shared` (packages/shared/src/placements/schema.ts:7-39); `purgeProjectCatalogCache`; `assertProjectCapability(projectId, userId, "experiments:write")`.
- Produces: wire endpoint `rpc.dashboard.projects[":projectId"].paywalls[":id"].experiments.$post`; response `{ data: { experiment, createdPaywallId: string | null } }` (Task 4 consumes).

Body schema:

```ts
const DEFAULT_VARIANT_SPLIT = 0.5;
const IDENTIFIER_SUFFIX_MAX = 20;

const launchBodySchema = z.object({
  name: z.string().trim().min(1),
  variantB: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), paywallId: z.string().min(1) }),
    z.object({ kind: z.literal("duplicate"), name: z.string().trim().min(1) }),
  ]),
  audienceId: z.string().min(1).optional(),
  placement: z.object({ placementId: z.string().min(1), rowIndex: z.number().int().min(0) }).optional(),
});
```

Handler, inside ONE `drizzle.db.transaction(async (tx) => { … })`:
1. Load paywall A (`findPaywallById(tx, projectId, id)`), 404 if missing.
2. `variantB.kind === "duplicate"` → insert paywall B via `createPaywall(tx, …)` copying `offeringId`, `builderConfig`, `remoteConfig`, `configFormatVersion` from A; `name` from body; `identifier` = slugify(name) with `-2…-${IDENTIFIER_SUFFIX_MAX}` suffix loop over `findPaywallByIdentifier` until free (409 if exhausted); `isActive: true`, `status: "draft"`, `publishedVersionId: null`. `kind === "existing"` → `findPaywallById` B, 400 if missing or `B.id === A.id`.
3. `audienceId ?? (await findOrCreateEveryoneAudience(tx, projectId)).id`.
4. `createExperimentValidated(tx, { projectId, name, type: PAYWALL, audienceId, variants: [ { id: "a", name: A.name, value: { paywallId: A.id }, weight: DEFAULT_VARIANT_SPLIT }, { id: "b", name: B.name, value: { paywallId: B.id }, weight: DEFAULT_VARIANT_SPLIT } ] })`.
5. `placement` given → `findPlacementById(tx, projectId, placementId)` (404), parse rows, assert `rows[rowIndex]` exists AND its target is `{ type: "paywall", paywallId: A.id }` — else `HTTPException(409, "Placement row no longer targets this paywall")`; replace target with `{ type: "experiment", experimentId: experiment.id }`; `updatePlacement(tx, …)`.
6. Three `audit()` calls inside the tx (paywall create when duplicated, experiment create, placement update when repointed) with the same action/resource vocabulary the sibling routes use.
7. After the tx commits: `invalidateExperimentCache(projectId)`; `purgeProjectCatalogCache(projectId)` when a placement was repointed (matches placements.ts:171 idiom).
8. `ok({ experiment, createdPaywallId })`.

- [ ] **Step 1: Failing route tests** (mock idiom from products.store-catalog.test.ts; mock the drizzle barrel with an in-memory tx that records call order and supports rollback-on-throw): (a) duplicate happy path — paywall B created with copied config + draft/unpublished, experiment DRAFT with 0.5/0.5 `{paywallId}` variants, placement row repointed, response carries `createdPaywallId`; (b) existing-kind happy path, `createdPaywallId: null`; (c) `variantB.paywallId === id` → 400; (d) placement row target mismatch → 409 AND nothing persisted (the tx mock must prove rollback: experiment insert recorded then discarded); (e) identifier collision → suffixed identifier used; (f) no audienceId → `findOrCreateEveryoneAudience` consulted; (g) capability gate called with `experiments:write`; (h) dashboard tsc picks up the RPC path (run `pnpm --filter @rovenue/dashboard exec tsc --noEmit` as part of Step 4).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test file + api tsc + dashboard tsc — PASS.
- [ ] **Step 5: Commit:** `feat(api): POST /paywalls/:id/experiments — atomic builder A/B launch (§6.19)`

---

### Task 3: Stop-with-winner repoints placements

**Files:**
- Modify: `apps/api/src/routes/dashboard/experiments.ts` (stop handler, lines ~601-690)
- Test: `apps/api/src/routes/dashboard/experiments.stop-repoint.test.ts`

**Interfaces:**
- Consumes: `drizzle.placementRepo.{listPlacements, updatePlacement}`, placement row target types, `purgeProjectCatalogCache`.
- Produces: no new exports — behaviour only. Spec §3.3.

Behaviour: wrap the existing `updateExperiment(… COMPLETED …)` and the new repoint in one `drizzle.db.transaction`. When `existing.type === "PAYWALL"` and `body.winnerVariantId` resolves to a variant with a `value.paywallId`: `listPlacements(tx, projectId)`, for each placement map its rows replacing every target `{ type: "experiment", experimentId: id }` with `{ type: "paywall", paywallId: winnerPaywallId }`; persist only placements that changed; `audit()` per changed placement inside the tx. After commit: `purgeProjectCatalogCache` once when anything changed. Winner id not found among variants, or no `paywallId` on it → skip the repoint silently (matches the promoteToFlag guard style at :648). `promoteToFlag` behaviour untouched.

- [ ] **Step 1: Failing tests:** (a) winner + two placements, one with two rows targeting the experiment and one targeting something else → exactly the two rows rewritten to the winner's paywallId, other placement untouched, audit called once per changed placement, purge called once; (b) stop WITHOUT winner → `updatePlacement` never called; (c) non-PAYWALL experiment with winner → never called; (d) winner variantId not in variants → never called, stop still succeeds; (e) existing stop behaviours (COMPLETED status, promoteToFlag) still pass — port/extend the current stop tests if any exist, else pin status+audit in this file.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (tx-wrap the existing update — behaviour-preserving for the no-winner path).
- [ ] **Step 4: Run** + api tsc — PASS.
- [ ] **Step 5: Commit:** `feat(api): stop-with-winner repoints placements to the winning paywall`

---

### Task 4: Experiment popover component

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/experiment-popover.tsx`
- Test: `apps/dashboard/src/components/paywall-builder/experiment-popover.test.tsx`

**Interfaces:**
- Consumes: `PaywallBuilderViewModel` (`vm.projectId`, `vm.paywall` — id/name/`publishedVersionId`/`status`), `useExperiments` + `useStartExperiment` (apps/dashboard/src/lib/hooks/useExperiments.ts), rpc/unwrap. Before writing list hooks, grep `src/lib/hooks` for existing `usePlacements` / `useAudiences` / paywall-list hooks and reuse; missing ones become file-local `useQuery` wrappers on the rpc client (idiom: useOfferingResolvedPrices.ts).
- Produces: `export const ExperimentPopover = component(({ onClose }: { onClose: () => void }) => …)` — Task 5 mounts it. Overlay idiom byte-consistent with `diff-modal.tsx` (read it and copy the wrapper classes; neither sibling has Escape/role="dialog" — stay idiom-consistent).

Structure (all copy via `t("paywalls.builder.experiment.<key>", "<English>")`):
- **Branch 1 — status panel** when `useExperiments({ projectId, type: "PAYWALL" })` contains a non-COMPLETED experiment with a variant `value.paywallId === vm.paywall.id` (client-side filter, matching target-picker.tsx's `filterPaywallExperiments` spirit): name, status chip, prerequisite checklist (variant paywalls published? — needs the paywall list query; placement attached? — placements list scanned for a row targeting the experiment), Start button (`useStartExperiment`) enabled only when every check passes, links to `/projects/$projectId/experiments/$experimentId`. COMPLETED-with-rows-still-targeting shows the §3.3 dark-placement warning string.
- **Branch 2 — create form** otherwise: kind switch (PAYWALL active | ELEMENT disabled + "coming soon" caption); name input defaulting `` `${vm.paywall.name} A/B` ``; variantB radio — "Duplicate this paywall" (default, name input `` `${vm.paywall.name} (B)` ``) | "Use an existing paywall" (select from the paywall list minus A; unpublished flagged with a suffix); audience select defaulting to the isDefault/Everyone entry, with a "(will be created)" caption when the project has no match-all audience; placement radio-list of `placement.identifier · row N` for rows targeting paywall A (exactly one → preselected; none → warning + link to `/projects/$projectId/placements`); fixed "50/50 split — adjust weights later on the experiment page" caption; Create button → `rpc…paywalls[":id"].experiments.$post` → on success with `createdPaywallId`: "Open variant B in the builder" link (`/projects/$projectId/paywalls/$paywallId` builder route — confirm the exact route path from the router tree before hardcoding) + switch to the status panel.

- [ ] **Step 1: Failing component tests** (mounting idiom from `binding-tab.test.tsx` — impair ServiceProvider + vi.mock the hooks module and rpc): (a) create-form branch renders with duplicate preselected and ELEMENT disabled; (b) Create posts the exact payload `{ name, variantB: { kind: "duplicate", name }, audienceId, placement: { placementId, rowIndex } }`; (c) status-panel branch renders when an experiment targets this paywall, Start disabled while a variant paywall is unpublished, enabled when all checks pass; (d) no-placement warning branch.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file + `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` + dashboard tsc — PASS at current baseline.
- [ ] **Step 5: Commit:** `feat(dashboard): builder experiment popover (paywall A/B, element coming soon)`

---

### Task 5: TopBar wiring + i18n

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx` (button cluster, between the eligibility toggle ~:119-137 and the issues chip ~:139 — re-locate by symbol)
- Modify: `apps/dashboard/src/components/paywall-builder/builder-shell.tsx` (state + prop + mount, pattern at :22-25/:72-87)
- Modify: `apps/dashboard/src/i18n/locales/en.json` (every `paywalls.builder.experiment.*` key Task 4 introduced + the TopBar tooltip — grep-audit `t("paywalls.builder.experiment` across the two components and add ALL of them with defaults verbatim; remember template-literal keys are invisible to the grep — Task 4 must not use template-literal keys)
- Test: append to the TopBar's existing test file if one exists (grep `top-bar` under `__tests__`/`*.test.tsx`; else create `top-bar.experiment.test.tsx` with the binding-tab mounting idiom)

**Interfaces:**
- Consumes: Task 4's `ExperimentPopover`; `FlaskConical` from lucide-react; `vm.paywall?.publishedVersionId`.
- Produces: `onOpenExperiment: () => void` prop on TopBar.

- [ ] **Step 1: Failing tests:** (a) TopBar renders a flask button that calls `onOpenExperiment`; (b) button disabled with tooltip while `publishedVersionId === null`; (c) builder-shell mounts ExperimentPopover when opened and unmounts on close (if builder-shell has no test file, cover via the TopBar test's scope and note it).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (`const [showExperiment, setShowExperiment] = useState(false)` + `onOpenExperiment={() => setShowExperiment(true)}` + `{showExperiment && <ExperimentPopover onClose={() => setShowExperiment(false)} />}` — the exact sibling pattern).
- [ ] **Step 4: i18n audit:** extract every `t("paywalls.builder.experiment` key from experiment-popover.tsx + top-bar.tsx, add each to en.json with the inline English default VERBATIM; show the audit in the report.
- [ ] **Step 5: Run** full `src/components/paywall-builder` + dashboard tsc — PASS at baseline.
- [ ] **Step 6: Commit:** `feat(dashboard): launch A/B from the builder top bar`

---

## Final verification (controller)

- [ ] `pnpm --filter @rovenue/api exec vitest run src/services/experiment-create.test.ts src/routes/dashboard/paywalls.experiments.test.ts src/routes/dashboard/experiments.stop-repoint.test.ts` + any pre-existing experiments tests · dashboard `src/components/paywall-builder` suite · tsc on api/db/dashboard.
- [ ] Whole-feature review (skip the second code-quality pass per standing preference), pointing the reviewer at spec §3.1 atomicity, §3.3, and the popover's payload contract.
