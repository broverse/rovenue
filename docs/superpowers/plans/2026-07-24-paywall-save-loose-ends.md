# Paywall Save — Two Loose Ends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reopen race the unmount flush introduced, and stop the builder from producing a config the server's size caps will reject.

**Architecture:** A module-scoped promise makes a newly mounted builder wait for any in-flight unmount flush before its GET. The node/depth caps and the traversal that measures them move into `@rovenue/shared/paywall`, so the API's bound check and a new client-side `addNode` guard read one definition.

**Tech Stack:** TypeScript (strict), Vitest, Hono (API), React + `impair` DI (dashboard), `react-i18next`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-paywall-save-loose-ends-design.md`.
- TypeScript strict.
- **No magic values** — the caps become named exports; nothing may re-declare `500` or `32`.
- Every user-facing string via `t(key, "English fallback")`, with the key added to `apps/dashboard/src/i18n/locales/en.json` in the same commit.
- **The API's bound check must not weaken.** It runs on UNVALIDATED input specifically because `builderConfigSchema` recurses per node, so a deeply-nested hostile tree overflows the call stack inside `safeParse` — a `RangeError` that `safeParse` does not contain, turning a 400 into a 500. Task 2 moves that function; its behaviour must stay byte-identical and it must keep running BEFORE the Zod parse.
- No DB change, no migration, no SDK/wire change.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script). Typecheck: `pnpm --filter <pkg> exec tsc --noEmit`.
- Conventional commits; commit per task.

---

## File Structure

**Modify:**
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` — the flush barrier; the `addNode` cap guard.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts` — tests for both.
- `apps/dashboard/src/components/paywall-builder/layer-tree.tsx` — disable the add affordance at the cap.
- `apps/dashboard/src/i18n/locales/en.json` — the disabled-affordance string.
- `packages/shared/src/paywall/schema.ts` — the caps and `measureNodeTree`.
- `packages/shared/src/paywall/schema.test.ts` — a test that the moved function still measures what it did.
- `apps/api/src/routes/dashboard/paywalls.ts` — import them instead of declaring them.

---

### Task 1: The flush barrier

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no public API change. A module-scoped `pendingFlush` promise that `load()` awaits.

- [ ] **Step 1: Write the failing tests**

Add to `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`:

```ts
describe("reopen after an unmount flush", () => {
  /** A promise plus the handles to settle it, so the test controls ordering
   * instead of racing a timer. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("waits for an in-flight flush before loading, so the GET cannot read the pre-flush row", async () => {
    const order: string[] = [];

    const flushGate = deferred<PaywallBuilderDetailDto>();
    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn().mockImplementation(() => {
        order.push("patch:start");
        return flushGate.promise;
      }),
    });
    await oldVm.load(() => {});
    oldVm.setLocaleText("t1_key", "en", "flushed");

    // The unmount flush — deliberately not awaited, exactly as BuilderShell does it.
    void oldVm.saveNow();

    const newVm = makeVm({
      get: vi.fn().mockImplementation(async () => {
        order.push("get");
        return fakeDetail();
      }),
      patchBuilderConfig: vi.fn(),
    });
    const loading = newVm.load(() => {});

    // The GET must not have fired yet — the flush is still open.
    expect(order).toEqual(["patch:start"]);

    flushGate.resolve(fakeDetail());
    await loading;

    expect(order).toEqual(["patch:start", "get"]);
  });

  it("does not wedge the reopen when the flush fails", async () => {
    const flushGate = deferred<PaywallBuilderDetailDto>();
    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn().mockImplementation(() => flushGate.promise),
    });
    await oldVm.load(() => {});
    oldVm.setLocaleText("t1_key", "en", "flushed");
    void oldVm.saveNow();

    flushGate.reject(new Error("boom"));

    const newVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
    });
    await newVm.load(() => {});

    expect(newVm.isLoading).toBe(false);
    expect(newVm.error).toBeNull();
  });
});
```

Note the second test is the one that matters most: a barrier that propagates a rejection turns a failed save into a builder that never opens, which is worse than the race it fixes.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
Expected: the first test FAILS — `order` is `["patch:start", "get"]` at the point the test asserts `["patch:start"]`, because nothing serialises them today. The second test may already pass; that is fine, it is the guard for the fix you are about to write.

- [ ] **Step 3: Add the barrier**

In `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`, at module scope above the class:

```ts
/**
 * The most recent unmount flush, if one is still in flight.
 *
 * BuilderShell flushes pending edits in an unmount cleanup, which cannot
 * await. The route is keyed per paywall, so React tears the old provider
 * down and mounts the new one in the same commit — closing a builder and
 * reopening the SAME paywall inside one round trip would otherwise let the
 * new view model's GET read the pre-flush row, seed `lastSavedSnapshot`
 * from it, and then write that stale tree back over the flushed edits.
 *
 * Module scope rather than a service: the two view-model instances never
 * coexist in a container, so there is nowhere instance-scoped to put it.
 */
let pendingFlush: Promise<unknown> | null = null;
```

In `saveNow()`, publish the in-flight request. Wrap the existing body so the promise is registered for the whole call and cleared when it settles — and make sure a rejection here is not left as an unhandled promise, since nothing awaits `saveNow` on the flush path:

```ts
  async saveNow() {
    const run = this.saveNowInner();
    pendingFlush = run.catch(() => {});
    void run.finally(() => {
      if (pendingFlush !== null) pendingFlush = null;
    });
    return run;
  }
```

Rename the existing `saveNow` body to `private async saveNowInner()`, unchanged otherwise.

In `load()`, await the barrier before the GET:

```ts
      // A previous builder's unmount flush may still be in flight; reading
      // before it lands would hand us the pre-flush row. Never let its
      // failure block the open — that would turn a failed save into a
      // builder that will not load.
      if (pendingFlush) await pendingFlush;
      const detail = await this.api.get(this.props.projectId, this.props.paywallId);
```

`pendingFlush` is assigned the already-swallowed `run.catch(() => {})`, so the `await` cannot throw.

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`
Expected: PASS, including the pre-existing autosave and flush tests. If a pre-existing test that asserts `patchBuilderConfig` call counts now fails, read it before changing it — the wrapper must not have altered how many times the PATCH fires.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts
git commit -m "fix(dashboard): make a builder reopen wait for the previous unmount flush"
```

---

### Task 2: One definition of the size caps, enforced on both sides

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`
- Modify: `packages/shared/src/paywall/schema.test.ts`
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/layer-tree.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Produces:
  - `export const MAX_BUILDER_NODES = 500` and `export const MAX_BUILDER_DEPTH = 32` from `@rovenue/shared/paywall`.
  - `export function measureNodeTree(raw: unknown): { depth: number; nodes: number }` — moved verbatim from the API.
  - `PaywallBuilderViewModel.addNode(...)` returns `string | null` — `null` when the insert would cross a cap.
  - `PaywallBuilderViewModel.atNodeCapacity: boolean` (a `@derived`) — true when another node cannot be added.

- [ ] **Step 1: Move the caps and the measurement into shared**

Cut `MAX_BUILDER_DEPTH`, `MAX_BUILDER_NODES` and the whole `measureNodeTree` function out of `apps/api/src/routes/dashboard/paywalls.ts` and paste them into `packages/shared/src/paywall/schema.ts`, adding `export` to all three. **Do not alter the function body or the comment above it** — it runs on unvalidated input by design.

In `apps/api/src/routes/dashboard/paywalls.ts`, add them to the existing `@rovenue/shared/paywall` import:

```ts
import {
  MAX_BUILDER_DEPTH,
  MAX_BUILDER_NODES,
  builderConfigSchema,
  diffBuilderConfigs,
  isBlockingIssue,
  isPublishBlockingIssue,
  measureNodeTree,
  validateBuilderConfig,
} from "@rovenue/shared/paywall";
```

The call site in `prepareBuilderConfigPatch` is unchanged, and the bound check must still run BEFORE the Zod parse.

- [ ] **Step 2: Verify the move changed nothing**

Add to `packages/shared/src/paywall/schema.test.ts`:

```ts
describe("measureNodeTree", () => {
  it("counts nodes and depth through children and fallback", () => {
    const raw = {
      root: {
        type: "stack",
        children: [
          { type: "spacer" },
          { type: "image", fallback: { type: "spacer" } },
        ],
      },
    };
    expect(measureNodeTree(raw)).toEqual({ depth: 3, nodes: 4 });
  });

  it("returns zeroes when there is no root object", () => {
    expect(measureNodeTree(null)).toEqual({ depth: 0, nodes: 0 });
    expect(measureNodeTree({})).toEqual({ depth: 0, nodes: 0 });
  });

  it("stops early instead of walking an unbounded tree", () => {
    let deep: unknown = { type: "stack", children: [] };
    for (let i = 0; i < MAX_BUILDER_DEPTH + 50; i++) deep = { type: "stack", children: [deep] };
    const measured = measureNodeTree({ root: deep });
    expect(measured.depth).toBeGreaterThan(MAX_BUILDER_DEPTH);
  });
});
```

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/schema.test.ts`
Expected: PASS. Then run the API's paywall suites to confirm the move is transparent:
`pnpm --filter @rovenue/api exec vitest run tests/dashboard-paywalls.integration.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 3: Write the failing view-model tests**

Add to `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`:

```ts
describe("size caps", () => {
  it("refuses to add a node past the node cap and leaves the tree unchanged", async () => {
    const config = fakeConfig();
    // One under the cap counting the root itself.
    while (measureNodeTree(config).nodes < MAX_BUILDER_NODES) {
      config.root.children.push({ type: "spacer", id: `s${config.root.children.length}`, size: 4 });
    }
    const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: config }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    const before = vm.config.root.children.length;
    expect(vm.addNode("spacer", "root")).toBeNull();
    expect(vm.config.root.children.length).toBe(before);
    expect(vm.atNodeCapacity).toBe(true);
  });

  it("refuses to add past the depth cap", async () => {
    const config = fakeConfig();
    // Nest stacks until the tree is exactly at the depth cap, keeping a
    // handle on the deepest one. Typed as StackNode so `.children` stays
    // addressable — `config.root.children` is a PaywallNode[].
    let cursor: StackNode = config.root;
    let n = 0;
    while (measureNodeTree(config).depth < MAX_BUILDER_DEPTH) {
      const child: StackNode = { type: "stack", id: `st${n++}`, axis: "v", children: [] };
      cursor.children.push(child);
      cursor = child;
    }
    const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: config }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.addNode("spacer", cursor.id)).toBeNull();
  });

  it("still adds when there is room", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.addNode("spacer", "root")).toEqual(expect.any(String));
    expect(vm.atNodeCapacity).toBe(false);
  });
});
```

Import `MAX_BUILDER_NODES`, `MAX_BUILDER_DEPTH`, `measureNodeTree` and the `StackNode` type from `@rovenue/shared/paywall` in the test file (`StackNode` is already imported there for other tests — check before adding a duplicate).

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
Expected: FAIL — `addNode` returns an id and grows the tree, and `atNodeCapacity` does not exist.

- [ ] **Step 4: Guard `addNode`**

In `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`, import the three names from `@rovenue/shared/paywall`, then:

```ts
  /** True when the tree is at the size the API will reject a save for. */
  @derived get atNodeCapacity(): boolean {
    return measureNodeTree(this.config).nodes >= MAX_BUILDER_NODES;
  }

  /**
   * Returns the new node's id, or `null` when the insert would cross a cap
   * the API enforces. Producing an over-cap config would make every autosave
   * 400 permanently — the failure mode the save-gate phase existed to remove.
   */
  addNode(type: PaywallNode["type"], parentId: string, index?: number): string | null {
    const node = treeOps.newNode(type, () => createId().slice(0, 8));
    const nextRoot = treeOps.insertNode(this.config.root, parentId, node, index);
    const bounds = measureNodeTree({ root: nextRoot });
    if (bounds.nodes > MAX_BUILDER_NODES || bounds.depth > MAX_BUILDER_DEPTH) return null;
    this.config = { ...this.config, root: nextRoot };
    this.registerFreshLocKeys(node);
    this.selectedNodeId = node.id;
    return node.id;
  }
```

Measuring the *candidate* tree rather than the current one is what makes the depth case work: only the insert reveals the new depth.

- [ ] **Step 5: Disable the affordance and say why**

In `apps/dashboard/src/components/paywall-builder/layer-tree.tsx`, the add button inside the `node.type === "stack"` branch gains a disabled state:

```tsx
            <button
              type="button"
              disabled={vm.atNodeCapacity}
              title={
                vm.atNodeCapacity
                  ? t(
                      "paywalls.builder.layers.addAtCapacity",
                      "This paywall has reached the maximum number of elements.",
                    )
                  : t("paywalls.builder.layers.add", "Add node")
              }
              onClick={() => setAddOpen((o) => !o)}
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
```

There is exactly one caller of `addNode` in the whole dashboard — this one — and it already discards the return value, so widening the return type to `string | null` breaks nothing. (Verified by grep before writing this plan; if you find another, fix the caller rather than narrowing the type.)

`atNodeCapacity` covers the node cap only; the depth cap is refused by `addNode` returning `null`, which the popover's `onPick` already discards. That asymmetry is deliberate — a per-node depth check would need the target's depth, and depth is reachable only by deliberate nesting, whereas the node cap is a whole-tree property worth showing.

- [ ] **Step 6: Add the string to `en.json`**

Add `addAtCapacity` under the existing `paywalls.builder.layers` object. Match the file's indentation; do not reorder or reformat anything else.

- [ ] **Step 7: Verify**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8')); console.log('valid json')"
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/shared exec vitest run src/paywall
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
pnpm --filter @rovenue/dashboard build
```
Expected: all clean/green. `addNode`'s return type widened to `string | null`; if a caller now fails to typecheck, fix the caller rather than narrowing it back.

The spec's testing section asks for "a test asserting the API and the dashboard read the same constants". Deliberately not written: once Step 1 deletes the API's local declarations, both sides import the same binding, so a same-value assertion is tautological — the compile-time single definition is the stronger guarantee. Say so in your report rather than adding a test that cannot fail.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/paywall/schema.ts packages/shared/src/paywall/schema.test.ts \
  apps/api/src/routes/dashboard/paywalls.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts \
  apps/dashboard/src/components/paywall-builder/layer-tree.tsx \
  apps/dashboard/src/i18n/locales/en.json
git commit -m "fix(paywall): one definition of the builder size caps, enforced client-side too"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/shared exec vitest run src/paywall` — green.
2. `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — green.
3. `pnpm --filter @rovenue/api exec vitest run tests/dashboard-paywalls.integration.test.ts` and `tests/paywall-save-gate.integration.test.ts` — green.
4. `tsc --noEmit` on all three packages; `pnpm --filter @rovenue/dashboard build`.
5. Manual: edit a paywall, close the builder with the X, immediately reopen the same paywall. The edit must be present.

## Out of scope (deferred)

- Cross-tab optimistic concurrency on the builderConfig PATCH.
- A node-count readout before the cap is reached.
- Pruning orphaned localization keys; M5/M6 from the P2 review.
