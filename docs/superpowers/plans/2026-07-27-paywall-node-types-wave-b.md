# Paywall Node Types Wave B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `featureList`, `socialProof` and `timeline` — the three node types that carry repeated localized rows — across the shared schema, the builder, and all three renderers.

**Architecture:** The three follow the nine existing node types, with one new thing: `rows` arrays whose entries carry their own localization keys. Wave A's `LOCALIZED_KEYS` mapped type already accepts a function per node type, so these three simply return arrays. Row icons resolve through wave A's twelve-name registry; no new icon source appears.

**Tech Stack:** TypeScript + Zod, React (`packages/paywall-renderer`, `apps/dashboard`), SwiftUI, Android Views, Vitest, `swift test`, `testDebugUnitTest`.

**Spec:** `docs/superpowers/specs/2026-07-27-paywall-node-types-wave-b-design.md`

## Global Constraints

- **No magic values.** Every default is a named constant in `packages/shared/src/paywall/schema.ts` — never invented per renderer. See the defaults table below.
- **Never create or switch branches, and never use a worktree.** Commit on whatever HEAD is checked out.
- **`git add` only the files your task touches.** Never `git add -A`, never `git commit -a` — other work is in flight. After committing, run `git show --stat <sha>` and confirm it holds exactly your files. Report the SHA you verified.
- **No `default` branch in any TypeScript per-type dispatcher.** Where a lookup must be total, use an exhaustiveness check that fails to compile when a type is missing. In wave A a `default: return null` let a whole node type reach users with an empty control; the Swift and Kotlin compilers caught the same class of omission in seconds.
- **A node type's obligations are discharged together.** Adding one owes entries to `OVERRIDABLE_PROP_KEYS`, `LOCALIZED_KEYS`, every per-type dispatcher, and the inspector fields those override keys imply. No task here declares a capability that a different task is expected to honour.
- **Row icons are registry names**, resolved exactly as `icon` nodes resolve them, failing open on an unrecognised name. Do not add a second icon mechanism.
- Every task has a real local gate and must run it. Report before and after counts.
- **`apps/dashboard` has 10 pre-existing failures** unrelated to this work. Record the count before you start and confirm it is unchanged. Do not fix them; if the count moves, the difference is yours.

### Baselines at the start of this plan

`packages/shared` 552 · `packages/paywall-renderer` 59 · `packages/sdk-swift` 191 · `packages/sdk-kotlin` 233 · `apps/dashboard` 618 passing / 10 failing.

### The defaults table — declared once, in shared

| Constant | Value | Applies to |
|---|---|---|
| `FEATURE_ROW_DEFAULT_ICON` | `"check"` | a feature row with no `icon` and `included` not false |
| `FEATURE_ROW_EXCLUDED_ICON` | `"x"` | a feature row with `included: false` and no `icon` |
| `FEATURE_ROW_DEFAULT_INCLUDED` | `true` | a feature row with no `included` |
| `TIMELINE_ROW_DEFAULT_ICON` | `"clock"` | a timeline row with no `icon` |
| `TIMELINE_CONNECTOR_DEFAULT_COLOR` | `DIVIDER_DEFAULT_COLOR` | a timeline with no `connectorColor` |
| `SOCIAL_PROOF_STAR_DEFAULT_COLOR` | `{ light: "#F59E0B", dark: "#FBBF24" }` | stars with no `starColor` |
| `SOCIAL_PROOF_MAX_RATING` | `5` | the star scale |
| `FEATURE_LIST_SOFT_MAX` | `6` | the row-count warning threshold |

**An absent text or icon colour means *inherit*, not a constant.** A mark beside a label takes
that label's colour. Express that as the absence of a colour instruction — omit the CSS
property, pass `nil` to `.foregroundColor`, do not call `imageTintList` — never by substituting
a value. Wave A's most expensive defect was three renderers each inventing a colour.

---

## File Structure

**Created:** `apps/dashboard/src/components/paywall-builder/inspector/row-list-editor.tsx` (a reusable add/remove/reorder editor — no such control exists today; `binding-tab.tsx` only toggles a fixed set of package ids) and its test.

**Modified:** `packages/shared/src/paywall/{schema.ts,validate.ts}` and their tests; `apps/dashboard/src/components/paywall-builder/{node-meta.ts,tree-ops.ts,inspector/content-tab.tsx,inspector/style-tab.tsx,inspector/overrides.tsx,inspector/tabs.ts}` and tests, plus `apps/dashboard/src/i18n/locales/en.json`; `packages/paywall-renderer/src/nodes.tsx`; `packages/sdk-swift/Sources/Rovenue/PaywallUI/{BuilderConfigModel.swift,RovenuePaywallView.swift,PaywallOverrides.swift}`; `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/{BuilderConfigModel.kt,NodeViewFactory.kt,PaywallOverrides.kt}`.

Tasks 1–3 are ordered. Tasks 4–6 each consume them and are independent of one another; they are reviewed **together**, in one review, because every blocking finding in wave A came from reading the platforms against each other.

---

### Task 1: The three types in the shared schema, with all shared obligations

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`, `packages/shared/src/paywall/validate.ts`
- Test: `packages/shared/src/paywall/schema.test.ts`, `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Produces: `FeatureRow`, `FeatureListNode`, `TimelineRow`, `TimelineNode`, `SocialProofNode`; the eight constants in the defaults table; `OVERRIDABLE_PROP_KEYS` rows; `LOCALIZED_KEYS` rows; the issue codes `FEATURE_LIST_TOO_LONG` and `EMPTY_ROWS`.

This task discharges everything `packages/shared` owes for all three types. It is one task on purpose: in wave A the override keys were declared in one task and the UI that honours them was written in another, and a labelled override control shipped with no inputs inside it.

- [ ] **Step 1: Write the failing schema tests**

Add to `schema.test.ts`:

```ts
describe("wave B row-carrying node types", () => {
  const wrap = (node: unknown) => ({
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: {} },
    root: { type: "stack", id: "root", axis: "v", children: [node] },
  });

  it("accepts a featureList with rows", () => {
    const r = builderConfigSchema.safeParse(
      wrap({
        type: "featureList",
        id: "f1",
        rows: [{ labelKey: "f_a" }, { labelKey: "f_b", included: false }, { labelKey: "f_c", icon: "star" }],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts a timeline with captions", () => {
    const r = builderConfigSchema.safeParse(
      wrap({
        type: "timeline",
        id: "t1",
        rows: [{ labelKey: "t_a", captionKey: "t_a_cap" }, { labelKey: "t_b", icon: "gift" }],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts socialProof with and without a rating", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "socialProof", id: "s1", labelKey: "s" })).success).toBe(true);
    expect(
      builderConfigSchema.safeParse(wrap({ type: "socialProof", id: "s1", labelKey: "s", rating: 4.5 })).success,
    ).toBe(true);
  });

  it("rejects a row with no labelKey", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "featureList", id: "f1", rows: [{}] })).success).toBe(false);
  });

  // Empty rows parse — an unfinished node must still SAVE. It is a warning,
  // not a schema error; see the EMPTY_ROWS test below.
  it("accepts an empty rows array", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "featureList", id: "f1", rows: [] })).success).toBe(true);
  });

  it("rejects a rating outside the scale", () => {
    expect(
      builderConfigSchema.safeParse(wrap({ type: "socialProof", id: "s1", labelKey: "s", rating: 6 })).success,
    ).toBe(false);
  });

  it("gives all three an OVERRIDABLE_PROP_KEYS row", () => {
    expect(OVERRIDABLE_PROP_KEYS.featureList).toEqual(["iconColor"]);
    expect(OVERRIDABLE_PROP_KEYS.timeline).toEqual(["connectorColor"]);
    expect(OVERRIDABLE_PROP_KEYS.socialProof).toEqual(["rating", "starColor"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/paywall/schema.test.ts`
Expected: FAIL — the three types are not in the union.

- [ ] **Step 3: Add the constants and types**

In `schema.ts`, beside `DIVIDER_DEFAULT_COLOR`:

```ts
/** A feature row with no icon, when it is included. */
export const FEATURE_ROW_DEFAULT_ICON = "check";
/** A feature row with no icon, when `included` is false. */
export const FEATURE_ROW_EXCLUDED_ICON = "x";
export const FEATURE_ROW_DEFAULT_INCLUDED = true;
/** Beyond this many rows a feature list stops converting well — a warning,
 *  never a block. */
export const FEATURE_LIST_SOFT_MAX = 6;
export const TIMELINE_ROW_DEFAULT_ICON = "clock";
/** The connector between timeline steps is the same hairline as a divider. */
export const TIMELINE_CONNECTOR_DEFAULT_COLOR = DIVIDER_DEFAULT_COLOR;
export const SOCIAL_PROOF_STAR_DEFAULT_COLOR = { light: "#F59E0B", dark: "#FBBF24" } as const;
export const SOCIAL_PROOF_MAX_RATING = 5;

export type FeatureRow = {
  labelKey: string;
  /** Registry icon name; unknown names fail open like any icon. */
  icon?: string;
  /** Defaults to FEATURE_ROW_DEFAULT_INCLUDED. */
  included?: boolean;
};

export type FeatureListNode = {
  type: "featureList";
  id: string;
  rows: FeatureRow[];
  /** Applied to each row's icon that does not carry its own. Absent = inherit. */
  iconColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type TimelineRow = {
  labelKey: string;
  captionKey?: string;
  icon?: string;
};

export type TimelineNode = {
  type: "timeline";
  id: string;
  rows: TimelineRow[];
  /** Absent = TIMELINE_CONNECTOR_DEFAULT_COLOR. */
  connectorColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type SocialProofNode = {
  type: "socialProof";
  id: string;
  /** 0…SOCIAL_PROOF_MAX_RATING. Absent renders no stars at all. */
  rating?: number;
  labelKey: string;
  /** Absent = SOCIAL_PROOF_STAR_DEFAULT_COLOR. */
  starColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Add all three to the `PaywallNode` union.

- [ ] **Step 4: Add the schemas and the override rows**

```ts
const featureRowSchema: z.ZodType<FeatureRow> = z.object({
  labelKey: z.string().min(1),
  icon: z.string().min(1).optional(),
  included: z.boolean().optional(),
});

const featureListNodeSchema: z.ZodType<FeatureListNode> = z.object({
  type: z.literal("featureList"),
  id: z.string().min(1),
  rows: z.array(featureRowSchema),
  iconColor: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.featureList).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const timelineRowSchema: z.ZodType<TimelineRow> = z.object({
  labelKey: z.string().min(1),
  captionKey: z.string().min(1).optional(),
  icon: z.string().min(1).optional(),
});

const timelineNodeSchema: z.ZodType<TimelineNode> = z.object({
  type: z.literal("timeline"),
  id: z.string().min(1),
  rows: z.array(timelineRowSchema),
  connectorColor: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.timeline).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const socialProofNodeSchema: z.ZodType<SocialProofNode> = z.object({
  type: z.literal("socialProof"),
  id: z.string().min(1),
  rating: z.number().min(0).max(SOCIAL_PROOF_MAX_RATING).optional(),
  labelKey: z.string().min(1),
  starColor: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.socialProof).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});
```

Add all three to the `paywallNodeSchema` union, and these rows to `OVERRIDABLE_PROP_KEYS`:

```ts
  featureList: ["iconColor"],
  timeline: ["connectorColor"],
  socialProof: ["rating", "starColor"],
```

- [ ] **Step 5: Extend `LOCALIZED_KEYS` — the reason wave A built it**

In `validate.ts`, add three rows. The table is a mapped type over the discriminant, so each
parameter is already narrowed — **no casts**:

```ts
  featureList: (n) => n.rows.map((r) => r.labelKey),
  timeline: (n) => n.rows.flatMap((r) => (r.captionKey ? [r.labelKey, r.captionKey] : [r.labelKey])),
  socialProof: (n) => [n.labelKey],
```

These are the first rows to return more than one key, which makes two neighbouring comments
untrue. Fix them in this task rather than letting them drift:

- the comment above `collectLocalizationUsages` still enumerates "text/button/purchaseButton" — make it describe the table instead.
- `localizedKeysOf`'s "in declaration order" is now loose — the order is whatever the row function returns. Say that.

- [ ] **Step 6: Add the two warnings**

Add `"FEATURE_LIST_TOO_LONG"` and `"EMPTY_ROWS"` to `BuilderIssue["code"]`, and to `ISSUE_SEVERITY`:

```ts
  // Authoring guidance from the conversion research, not a broken config.
  FEATURE_LIST_TOO_LONG: "warning",
  // An unfinished node, almost never an intent — but it must still save.
  EMPTY_ROWS: "warning",
```

Emit them inside the existing node walk:

```ts
    if (node.type === "featureList" && node.rows.length > FEATURE_LIST_SOFT_MAX) {
      issues.push({
        code: "FEATURE_LIST_TOO_LONG",
        nodeId: node.id,
        message: `Feature list "${node.id}" has ${node.rows.length} rows; ${FEATURE_LIST_SOFT_MAX} or fewer converts better.`,
      });
    }
    if ((node.type === "featureList" || node.type === "timeline") && node.rows.length === 0) {
      issues.push({
        code: "EMPTY_ROWS",
        nodeId: node.id,
        message: `"${node.id}" has no rows and will render nothing.`,
      });
    }
```

Add tests asserting both fire, that neither `isBlockingIssue` nor `isPublishBlockingIssue`
returns true for either, and that a seven-row list warns while a six-row list does not.

- [ ] **Step 7: Run, and mutation-check the table**

Run: `cd packages/shared && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, clean. Baseline was 552.

Then temporarily change the `featureList` row to `() => []` and re-run. The localization tests
must FAIL — a feature list's row labels stop being seen as used keys. Restore, confirm green,
and report both. A table row that can be emptied without any test noticing is pinned by nothing.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/paywall/schema.ts packages/shared/src/paywall/validate.ts packages/shared/src/paywall/schema.test.ts packages/shared/src/paywall/validate.test.ts
git commit -m "feat(shared): add the featureList, socialProof and timeline node types"
```

---

### Task 2: A reusable row-list editor

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/inspector/row-list-editor.tsx`
- Test: `apps/dashboard/src/components/paywall-builder/inspector/row-list-editor.test.tsx`

**Interfaces:**
- Produces: `RowListEditor<T>` — a controlled add/remove/reorder list. Task 3 renders per-row fields inside it for each of the three types.

Nothing like this exists today. `binding-tab.tsx` toggles membership of a fixed set of package
ids; these rows are authored, ordered and removable. Building it once keeps three inspector
sections from each growing their own.

- [ ] **Step 1: Write the failing test**

```tsx
type Row = { labelKey: string };

function harness(initial: Row[]) {
  const onChange = vi.fn();
  render(
    <RowListEditor<Row>
      rows={initial}
      onChange={onChange}
      newRow={() => ({ labelKey: "" })}
      addLabel="Add row"
      renderRow={(row, i, patch) => (
        <input aria-label={`label-${i}`} value={row.labelKey} onChange={(e) => patch({ labelKey: e.target.value })} />
      )}
    />,
  );
  return onChange;
}

it("adds a row using newRow", () => {
  const onChange = harness([{ labelKey: "a" }]);
  fireEvent.click(screen.getByRole("button", { name: "Add row" }));
  expect(onChange).toHaveBeenCalledWith([{ labelKey: "a" }, { labelKey: "" }]);
});

it("removes the row at an index", () => {
  const onChange = harness([{ labelKey: "a" }, { labelKey: "b" }]);
  fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0]!);
  expect(onChange).toHaveBeenCalledWith([{ labelKey: "b" }]);
});

it("moves a row up, and cannot move the first row up", () => {
  const onChange = harness([{ labelKey: "a" }, { labelKey: "b" }]);
  fireEvent.click(screen.getAllByRole("button", { name: /move up/i })[1]!);
  expect(onChange).toHaveBeenCalledWith([{ labelKey: "b" }, { labelKey: "a" }]);
  expect(screen.getAllByRole("button", { name: /move up/i })[0]).toBeDisabled();
});

it("patches one row without disturbing its siblings", () => {
  const onChange = harness([{ labelKey: "a" }, { labelKey: "b" }]);
  fireEvent.change(screen.getByLabelText("label-1"), { target: { value: "bb" } });
  expect(onChange).toHaveBeenCalledWith([{ labelKey: "a" }, { labelKey: "bb" }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder/inspector/row-list-editor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
type RowListEditorProps<T> = {
  rows: readonly T[];
  onChange: (rows: T[]) => void;
  /** Builds the row appended by the add button. */
  newRow: () => T;
  addLabel: string;
  renderRow: (row: T, index: number, patch: (fields: Partial<T>) => void) => ReactNode;
};

export function RowListEditor<T>({ rows, onChange, newRow, addLabel, renderRow }: RowListEditorProps<T>) {
  const replace = (index: number, row: T) => onChange(rows.map((r, i) => (i === index ? row : r)));
  const move = (index: number, delta: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + delta, 0, row!);
    onChange(next);
  };
  return (
    <div>
      {rows.map((row, index) => (
        <div key={index}>
          {renderRow(row, index, (fields) => replace(index, { ...row, ...fields }))}
          <button type="button" aria-label={`Move up row ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" aria-label={`Move down row ${index + 1}`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>↓</button>
          <button type="button" aria-label={`Remove row ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, newRow()])}>{addLabel}</button>
    </div>
  );
}
```

Style it with the classes the neighbouring inspector components use — read `fields.tsx` and
match, rather than inventing new ones. `key={index}` is correct here: rows have no stable id and
reordering is explicit, so index identity is what the user manipulates.

- [ ] **Step 4: Run**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder/inspector/row-list-editor.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/inspector/row-list-editor.tsx apps/dashboard/src/components/paywall-builder/inspector/row-list-editor.test.tsx
git commit -m "feat(dashboard): add a reusable row-list editor for the inspector"
```

---

### Task 3: Author all three types in the builder

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/node-meta.ts`, `tree-ops.ts`, `inspector/content-tab.tsx`, `inspector/style-tab.tsx`, `inspector/overrides.tsx`, `inspector/tabs.ts`, `apps/dashboard/src/i18n/locales/en.json`
- Test: the matching `__tests__` and `inspector/*.test.*` files

**Interfaces:**
- Consumes: Task 1's types, constants and `OVERRIDABLE_PROP_KEYS` rows; Task 2's `RowListEditor`; wave A's `ICON_NAMES`.

**This task discharges every dashboard obligation for all three types at once, including the
override fields.** In wave A the override keys were declared in the schema task and no UI task
was told to honour them, so `OverridePropField` fell through to `default: return null` and an
author could open an override and find a labelled row containing no inputs. Do not leave any of
the three override keys unwired.

- [ ] **Step 1: Write the failing tests**

In `__tests__/node-meta.test.ts` extend the existing "every node type has an icon and a label"
test — it already iterates `NODE_TYPES`, so it will fail as soon as the three are added there
without metadata.

In `__tests__/tree-ops.test.ts`:

```ts
it("creates a featureList with one starter row", () => {
  const node = newNode("featureList", idGen);
  expect(node).toEqual({
    type: "featureList",
    id: node.id,
    rows: [{ labelKey: `featureList_${node.id}_1` }],
  });
});

it("creates a timeline with one starter row", () => {
  const node = newNode("timeline", idGen);
  expect(node).toEqual({
    type: "timeline",
    id: node.id,
    rows: [{ labelKey: `timeline_${node.id}_1` }],
  });
});

it("creates socialProof with a label key", () => {
  const node = newNode("socialProof", idGen);
  expect(node).toEqual({ type: "socialProof", id: node.id, labelKey: `socialProof_${node.id}` });
});
```

The function is `newNode(type, idGen: () => string)` — it takes an id GENERATOR, not an id, and
the existing tests in this file already have an `idGen` in scope. The key naming follows the
`text_${id}` / `button_${id}` convention already in `newNode`; rows append a 1-based index
because a list has several.

In `inspector/tabs.test.ts` the existing "every node type gets at least one tab" test iterates
the type union and will fail until the three are added to the right `appliesTo` sets.

In `inspector/overrides.test.tsx`, add a case per new override key asserting a real input
renders — `featureList.iconColor`, `timeline.connectorColor`, `socialProof.rating`,
`socialProof.starColor`. These are the regression guard for wave A's empty-control bug, so after
implementing, **verify they fail against the pre-change `overrides.tsx`** and report that.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder`
Expected: FAIL across the four files above.

- [ ] **Step 3: Metadata and creation**

In `node-meta.ts` add the three to `NODE_TYPES`, `NODE_ICON` (import `ListChecks`, `Star` and
`GitCommitVertical` from `lucide-react`) and `NODE_TYPE_LABEL` (`"Feature list"`,
`"Social proof"`, `"Timeline"`).

In `tree-ops.ts` add the three `case` arms inside `newNode`'s switch, before the exhaustiveness branch, using the `id` that `idGen()` already produced at the top of the function. A
new list starts with exactly one row: an empty list would immediately raise `EMPTY_ROWS`.

- [ ] **Step 4: Inspector fields**

In `content-tab.tsx`, add a section per type built on `RowListEditor`:

- `featureList` — each row gets a localization-key field, an icon picker over `ICON_NAMES`, and an "Included" checkbox. `newRow` returns `{ labelKey: "" }`.
- `timeline` — each row gets a label key, an optional caption key, and an icon picker.
- `socialProof` — no rows: a label-key field and a rating number field bounded 0…`SOCIAL_PROOF_MAX_RATING`.

In `style-tab.tsx`, add the colour fields — `featureList.iconColor`, `timeline.connectorColor`,
`socialProof.starColor` — using the same colour control `text` and `divider` already use.

In `tabs.ts`, add all three to `content` and `visibility`, and all three to `style`.

- [ ] **Step 5: Override fields — the wave A regression**

In `overrides.tsx`, add a case for each of the four override keys from Task 1's
`OVERRIDABLE_PROP_KEYS` rows: `featureList.iconColor`, `timeline.connectorColor`,
`socialProof.rating`, `socialProof.starColor`. Reuse the same controls as the main inspector
fields. Every key declared in the schema must render an input here.

- [ ] **Step 6: i18n**

Add labels for the three node types under `paywalls.builder.nodeTypes.*`, and for the new fields
under `paywalls.builder.properties.*`, matching the paths the existing types use.

- [ ] **Step 7: Run, and prove the override guard**

Run: `cd apps/dashboard && npx vitest run`
Expected: the new tests pass; failures still exactly 10.

Then `git stash` only `overrides.tsx`, re-run `inspector/overrides.test.tsx`, and confirm the
four new cases FAIL. Restore and confirm green. Report both.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): author featureList, socialProof and timeline nodes"
```

---

### Task 4: The web renderer

**Files:**
- Modify: `packages/paywall-renderer/src/nodes.tsx`
- Test: `packages/paywall-renderer/src/renderer.test.tsx`

**Interfaces:**
- Consumes: Task 1's types and constants; wave A's `ICON_COMPONENT` lookup and `iconRegistry`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("renders one element per feature row", () => {
  const { container } = render(<PaywallRenderer config={cfg({
    type: "featureList", id: "f1",
    rows: [{ labelKey: "f_a" }, { labelKey: "f_b" }, { labelKey: "f_c" }],
  })} {...base} />);
  expect(container.querySelectorAll('[data-rov-row]')).toHaveLength(3);
});

// Assert WHICH mark, not that a mark exists: `check` and `x` are both real
// registry icons and both render an <svg>, so querying for one proves
// nothing. Each row's mark carries the resolved name.
it("uses the excluded mark for a row with included false", () => {
  const { container } = render(<PaywallRenderer config={cfg({
    type: "featureList", id: "f1", rows: [{ labelKey: "f_a" }, { labelKey: "f_b", included: false }],
  })} {...base} />);
  const marks = [...container.querySelectorAll('[data-rov-icon]')].map((e) => e.getAttribute("data-rov-icon"));
  expect(marks).toEqual([FEATURE_ROW_DEFAULT_ICON, FEATURE_ROW_EXCLUDED_ICON]);
});

it("renders a timeline caption when present and omits it otherwise", () => {
  const { container } = render(<PaywallRenderer config={cfg({
    type: "timeline", id: "t1",
    rows: [{ labelKey: "t_a", captionKey: "t_a_cap" }, { labelKey: "t_b" }],
  })} {...base} />);
  expect(container.querySelectorAll('[data-rov-caption]')).toHaveLength(1);
});

it("renders the rating as stars, and none when rating is absent", () => {
  const withRating = render(<PaywallRenderer config={cfg({
    type: "socialProof", id: "s1", labelKey: "s", rating: 4,
  })} {...base} />);
  expect(withRating.container.querySelectorAll('[data-rov-star]').length).toBe(SOCIAL_PROOF_MAX_RATING);
  const without = render(<PaywallRenderer config={cfg({ type: "socialProof", id: "s2", labelKey: "s" })} {...base} />);
  expect(without.container.querySelectorAll('[data-rov-star]')).toHaveLength(0);
});

// Fail open, exactly as an icon node does.
it("renders a row with an unknown icon without throwing", () => {
  const { container } = render(<PaywallRenderer config={cfg({
    type: "featureList", id: "f1", rows: [{ labelKey: "f_a", icon: "nope" }],
  })} {...base} />);
  expect(container.querySelector('[data-rov-row]')).not.toBeNull();
});

it("renders nothing for an empty rows array", () => {
  const { container } = render(<PaywallRenderer config={cfg({ type: "featureList", id: "f1", rows: [] })} {...base} />);
  expect(container.querySelectorAll('[data-rov-row]')).toHaveLength(0);
});
```

Use the file's existing `cfg`/`base` helpers, and add `data-rov-row`, `data-rov-caption`,
`data-rov-star` and `data-rov-icon` attributes in the implementation so these queries have
something to bind to. `data-rov-icon` carries the **resolved** icon name — it is the only way
from outside to tell which mark was chosen, and asserting on it is what makes the excluded-mark
test able to fail at all.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/paywall-renderer && npx vitest run`
Expected: FAIL — the three types fall through to the fallback branch.

- [ ] **Step 3: Implement**

Add `renderFeatureList`, `renderTimeline` and `renderSocialProof`, and their `case` arms in the
dispatcher beside `case "icon":`. Resolve each row's icon through the existing `ICON_COMPONENT`
lookup, choosing `FEATURE_ROW_EXCLUDED_ICON` when `included === false` and no icon is given, and
`FEATURE_ROW_DEFAULT_ICON` otherwise. Resolve labels with the same `resolveLabel(ctx, key)` the
text renderer uses.

For colours: `iconColor`, `starColor` and `connectorColor` resolve through `resolveTextColor`
when present. When `iconColor` is **absent, emit no colour at all** so the mark inherits the
row's text colour. `connectorColor` absent uses `TIMELINE_CONNECTOR_DEFAULT_COLOR`; `starColor`
absent uses `SOCIAL_PROOF_STAR_DEFAULT_COLOR`.

- [ ] **Step 4: Run and mutation-check**

Run: `cd packages/paywall-renderer && npx vitest run`
Expected: PASS. Baseline 59.

Then make the excluded-mark branch always use `FEATURE_ROW_DEFAULT_ICON` and re-run: the
excluded-mark test must FAIL. Restore, confirm green, report both.

- [ ] **Step 5: Commit**

```bash
git add packages/paywall-renderer/src/nodes.tsx packages/paywall-renderer/src/renderer.test.tsx
git commit -m "feat(paywall-renderer): render featureList, socialProof and timeline"
```

---

### Task 5: The SwiftUI renderer

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift`, `RovenuePaywallView.swift`, `PaywallOverrides.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift`

**Interfaces:**
- Consumes: the wire shape from Task 1; wave A's `sfSymbolName(for:)`.

`PaywallOverrides.swift` is in the file list deliberately: its `BuilderNode` dispatch is an
exhaustive `switch` with no `default`, so the three new cases are required for the package to
compile. Wave A's brief omitted it and the compiler caught it — expect the same here.

The colour chain has no single-call helper. `themeValue(pair, dark: ctx.dark)` yields a hex
string, `parseHexColor` yields an optional `RGBAColor`, and `color(_:)` yields the `Color`. The
colour prop type is `ThemePair?`. Do not invent a shorter helper.

- [ ] **Step 1: Write the failing tests**

```swift
func test_decodesFeatureListRows() throws {
    let node = try firstChild(#"{"type":"featureList","id":"f1","rows":[{"labelKey":"a"},{"labelKey":"b","included":false}]}"#)
    guard case .featureList(let p) = node else { XCTFail("not a featureList"); return }
    XCTAssertEqual(p.rows.count, 2)
    XCTAssertEqual(p.rows[1].included, false)
}

func test_decodesTimelineCaptions() throws {
    let node = try firstChild(#"{"type":"timeline","id":"t1","rows":[{"labelKey":"a","captionKey":"ac"},{"labelKey":"b"}]}"#)
    guard case .timeline(let p) = node else { XCTFail("not a timeline"); return }
    XCTAssertEqual(p.rows[0].captionKey, "ac")
    XCTAssertNil(p.rows[1].captionKey)
}

func test_decodesSocialProofRating() throws {
    let node = try firstChild(#"{"type":"socialProof","id":"s1","labelKey":"s","rating":4.5}"#)
    guard case .socialProof(let p) = node else { XCTFail("not socialProof"); return }
    XCTAssertEqual(p.rating, 4.5)
}

func test_decodesEmptyRows() throws {
    let node = try firstChild(#"{"type":"featureList","id":"f1","rows":[]}"#)
    guard case .featureList(let p) = node else { XCTFail("not a featureList"); return }
    XCTAssertTrue(p.rows.isEmpty)
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sdk-swift && swift test`
Expected: FAIL to compile — the three cases do not exist.

- [ ] **Step 3: Model, override and render**

Add `FeatureRowProps`, `FeatureListProps`, `TimelineRowProps`, `TimelineProps` and
`SocialProofProps` beside the wave A props structs, with the same `visibility`/`overrides`/
`fallback` members; add the three enum cases and their type-switch arms; add matching
`applyOverrides` overloads in `PaywallOverrides.swift`.

Render each as a `VStack` of rows. A feature row is the resolved SF Symbol beside the resolved
label. Add a test asserting WHICH symbol an excluded row resolves to, not merely that a symbol
rendered — on web the equivalent test was initially vacuous, because both `check` and `x` are
real icons that draw. Expose the resolved name from `sfSymbolName(for:)` and assert on it; a timeline row is the symbol, a `Rectangle` connector below it for every row but the
last, the label and the optional caption; social proof is `SOCIAL_PROOF_MAX_RATING` stars with
the first `floor(rating)` filled, then the label. Declare the defaults as file-private
lowerCamelCase constants mirroring the shared values.

An absent `iconColor` must pass **`nil`** to `.foregroundColor` so the mark inherits — do not
substitute a value.

- [ ] **Step 4: Run**

Run: `cd packages/sdk-swift && swift test`
Expected: PASS. Baseline 191.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/PaywallUI packages/sdk-swift/Tests/RovenueTests
git commit -m "feat(sdk-swift): render featureList, socialProof and timeline"
```

---

### Task 6: The Android renderer

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModel.kt`, `NodeViewFactory.kt`, `PaywallOverrides.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModelTest.kt`, `NodeViewFactoryTest.kt`

**Interfaces:**
- Consumes: the wire shape from Task 1; wave A's static `R.drawable` icon map.

`PaywallOverrides.kt` is in the list for the same reason as its Swift sibling — its `when` over
`BuilderNode` is exhaustive with no `else`.

Row icons resolve through wave A's **static `R.drawable` map**, not `getIdentifier`. That map
exists because `getIdentifier` left the twelve drawables unreferenced, so a consuming app with
`shrinkResources true` could strip them all. Do not reintroduce a runtime name lookup.

- [ ] **Step 1: Write the failing decode tests**

```kotlin
@Test
fun decodesFeatureListRows() {
    val node = firstChild(rootWith("""{"type":"featureList","id":"f1","rows":[{"labelKey":"a"},{"labelKey":"b","included":false}]}"""))
    assertTrue(node is BuilderNode.FeatureList)
    val p = node as BuilderNode.FeatureList
    assertEquals(2, p.rows.size)
    assertEquals(false, p.rows[1].included)
}

@Test
fun decodesTimelineCaptions() {
    val node = firstChild(rootWith("""{"type":"timeline","id":"t1","rows":[{"labelKey":"a","captionKey":"ac"},{"labelKey":"b"}]}"""))
    val p = node as BuilderNode.Timeline
    assertEquals("ac", p.rows[0].captionKey)
    assertNull(p.rows[1].captionKey)
}

@Test
fun decodesSocialProofRating() {
    val node = firstChild(rootWith("""{"type":"socialProof","id":"s1","labelKey":"s","rating":4.5}"""))
    assertEquals(4.5, (node as BuilderNode.SocialProof).rating)
}
```

Add a `childLayoutFor` case per type in `NodeViewFactoryTest.kt` — that file already holds about
ten such cases, and in wave A it was where a dropped override would have surfaced.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: FAIL to compile.

- [ ] **Step 3: Model, override and render**

Add `FeatureRow`, `TimelineRow` data classes and `BuilderNode.FeatureList`, `.Timeline`,
`.SocialProof` beside the wave A entries, with their override-props objects and parser arms; add
the three `when` arms in `PaywallOverrides.kt`.

Build each as a vertical `LinearLayout`. A feature row is an `ImageView` plus a `TextView`. Add a test asserting WHICH drawable an
excluded row resolves to, not merely that one resolved — on web the equivalent test was
initially vacuous, because both `check` and `x` are real icons that draw. Assert on
`drawableNameFor`'s result for the row; a
timeline row adds a thin connector `View` between steps; social proof is
`SOCIAL_PROOF_MAX_RATING` star `ImageView`s followed by the label.

**When `iconColor` is absent, do not call `imageTintList` at all** — the mark inherits. Setting
a grey there is exactly the wave A defect this rule exists to prevent.

Pass the **resolved** child to `childLayoutFor`, not the raw node. In wave A the raw node was
passed and an active `thickness` override was silently dropped.

- [ ] **Step 4: Run**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL. Baseline 233, counted from `build/test-results/testDebugUnitTest/*.xml`.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui
git commit -m "feat(sdk-kotlin): render featureList, socialProof and timeline"
```

---

## Notes for the executor

- Tasks 1–3 are ordered. Tasks 4–6 are independent of one another.
- **Review tasks 4–6 together, in one review, not three.** Every blocking finding in wave A came from reading the three platforms against each other; three task-scoped reviews are three reviews that never make that comparison. The review's first question should be whether the three draw the same thing for the same node with every optional prop absent.
- Four tasks carry a mutation check (1, 3, 4, and the override guard inside 3). They are the point: a coverage or regression test that cannot fail guards nothing.
- Whether star half-fill, connector alignment and row spacing hold at accessibility text sizes is a device question and belongs in the next smoke session, not in any task's report.
