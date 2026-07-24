# Paywall Save — Two Loose Ends Design

**Date:** 2026-07-24
**Status:** Proposed. Feeds a writing-plans implementation plan.
**Trigger:** The save-gate phase's final review (`Ready to merge`) left two Minors deferred. One is a data-loss path that phase *introduced*; the other is the last surviving instance of the failure class that phase set out to eliminate.

---

## 1. The reopen race — introduced by the unmount flush

The builder now flushes pending edits when it unmounts:

```tsx
useEffect(() => () => { if (vm.isDirty) void vm.saveNow(); }, [vm]);
```

Nothing waits for that PATCH. The route is keyed on `${projectId}/${paywallId}`, so React tears down the old provider and mounts a new one in the same commit, and the new view model's `@onMount load()` issues its GET immediately. If the author closes paywall A's builder and reopens **A** within one round trip, the GET can resolve against the pre-flush row.

`applyServer` then seeds `lastSavedSnapshot` from that stale config, so the builder shows stale content, reads as **clean**, and the next save writes the stale tree over the edits that were just flushed.

**This is strictly better than before** — the pre-change builder lost those edits every single time, not just inside a one-round-trip window. But it is a new way to lose work, and we added it.

### Fix: a flush barrier

A module-scoped promise of the most recent in-flight flush. `load()` awaits it before its GET.

```ts
// paywall-builder.vm.ts, module scope
let pendingFlush: Promise<unknown> | null = null;
```

`saveNow()` publishes its own promise there when called as a flush; `load()` does `await pendingFlush` (swallowing rejection — a failed flush must not block the reopen) before `api.get`.

Module scope is correct here, not a shared service: the race is between two view-model *instances* that never coexist in a container, so there is nowhere instance-scoped to put it. It is one variable, and the barrier is a no-op in every case except the one it exists for.

**Not a general concurrency fix.** Two browser tabs editing the same paywall still last-write-wins. That is a separate, larger problem (optimistic concurrency on `updatedAt`) and is explicitly out of scope.

---

## 2. The node and depth caps — the last permanent-400

`apps/api/src/routes/dashboard/paywalls.ts` rejects a builderConfig over `MAX_BUILDER_NODES = 500` or `MAX_BUILDER_DEPTH = 32` with `SCHEMA_INVALID`. That is a **save**-tier rejection, correctly so — the payload is genuinely out of bounds.

But nothing client-side counts nodes or depth. `addNode` inserts unconditionally:

```ts
addNode(type, parentId, index?) {
  const node = treeOps.newNode(type, () => createId().slice(0, 8));
  this.config = { ...this.config, root: treeOps.insertNode(this.config.root, parentId, node, index) };
  ...
}
```

So an author can click past the cap and every autosave 400s permanently from then on — exactly the failure mode the save-gate phase existed to remove. The final review estimated ~500 clicks and rated it low priority. **Depth is the cheaper path: 32 nested stacks, not 500 nodes.** Still unlikely by accident, but the class is not actually closed while this exists.

### Fix: the builder cannot produce a config the server will reject

- Move `MAX_BUILDER_NODES` / `MAX_BUILDER_DEPTH` into `@rovenue/shared/paywall` so the API and the dashboard read **one** definition. Two hand-synced copies of a limit is how they drift.
- `addNode` refuses when the insert would cross either cap, and returns `null` instead of an id.
- The add-node affordance is disabled at the cap, with a title explaining why.

Refusing silently would be its own bug, which is why the disabled affordance and its explanation are part of the fix, not a nicety.

**Raising the caps is not the fix.** They exist to bound the payload the four renderers decode; a bigger number just moves the cliff.

---

## 3. Scope

**In scope:** the flush barrier and its test; hoisting the two caps into shared; the `addNode` refusal; the disabled add affordance with its reason.

**Out of scope:**
- Cross-tab optimistic concurrency (`updatedAt` / If-Match). Different problem, much larger.
- Pruning orphaned localization keys; M5/M6 from the P2 review.
- Any change to the caps' values.
- No DB change, no migration, no SDK/wire change.

**Success criteria**
1. Editing a paywall, closing the builder and immediately reopening the same paywall shows the flushed edits, not the pre-flush state.
2. A failed flush does not prevent the reopen from loading.
3. At the node cap the add-node affordance is disabled and says why; `addNode` returns `null`.
4. At the depth cap, adding into the deepest container is refused the same way.
5. The API and the dashboard read the same two constants.

---

## 4. Testing

- **The barrier** — a view-model test where the flush's PATCH is still pending when `load()` is called: assert the GET happens after the PATCH resolves. This must fail without the barrier, so write it against a controllable deferred promise rather than a timer.
- **A rejected flush** — `load()` still completes. Without this the barrier turns a save failure into a builder that never opens.
- **The caps** — `addNode` returns `null` and leaves the tree unchanged at the node cap and at the depth cap; returns an id one below each.
- **One definition** — a test asserting the API's bound check and the dashboard's guard read the same exported constants, so a future edit to one cannot silently diverge.

---

## 5. Global constraints

- TypeScript strict.
- Spans `packages/shared/`, `apps/api/` and `apps/dashboard/`.
- **No magic values** — the caps become named exports; nothing re-declares `500` or `32`.
- Every user-facing string via `t(key, "English fallback")`, with the key added to `apps/dashboard/src/i18n/locales/en.json` in the same commit.
- No DB change, no migration, no SDK/wire change.
- Conventional commits; work committed on the current branch (`main`), no new branches.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script).

---

## 6. Follow-ons (deferred)

- Cross-tab optimistic concurrency on the builderConfig PATCH.
- A node-count/depth readout in the builder UI before the cap is reached, rather than only at it.
