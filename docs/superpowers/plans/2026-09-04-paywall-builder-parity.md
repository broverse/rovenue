# Paywall Builder Parity Implementation Plan (ROADMAP §3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four open ROADMAP §3 lines — element-level experiments (already shipped; one UI dead end to fix), a footer link group node at RC Paywalls v2 parity, a 15–20 entry paywall template gallery, and an in-builder localization workflow with Rovi auto-translate.

**Architecture:** The footer link group becomes the 18th member of the shared node union and is decoded by all three renderers, with `render-fixtures.json` edited last. Templates stay code — pure `(defaultLocale) => BuilderConfig` functions composed from a small kit of section factories, carrying no asset URLs and no package ids so any template validates against any offering. Auto-translate is a Rovi endpoint that returns translated entries the builder applies client-side through the existing `setLocalizations` tree-op, guarded by a `{{variable}}`-preservation check, and `resolveText` gains a base-language fallback so the locales authors create are actually found by the SDK.

**Tech Stack:** TypeScript (strict), Zod, React + Vite (dashboard), Hono (api), Vercel AI SDK (`generateObject`), Vitest, SwiftUI (`swift test`), Kotlin/Android Views (`testDebugUnitTest`).

**Spec:** `docs/superpowers/specs/2026-09-04-paywall-builder-parity-design.md`

## Global Constraints

- **Stay on the current branch.** Do not create, switch, or delete branches; do not create worktrees. The user manages branching.
- **Do not touch the in-flight §2 work.** The working tree holds another task's uncommitted changes to `apps/api/src/services/subscription-state.ts`, `packages/shared/src/subscription-status.ts`, `packages/db/src/drizzle/schema.ts`, `packages/db/seed.ts`, `packages/db/drizzle/migrations/**` (including `0115`). No task in this plan needs any of them. **This plan adds no migration and touches no database schema.** If a task appears to need one, stop and report instead.
- **No magic values.** Every threshold, limit, default and list is a named exported constant with a comment saying where it comes from. Structured data tables (the template catalogue, the store-locale list, `OVERRIDABLE_PROP_KEYS`-shaped tables) are not magic values — they are the point.
- **Throttle test runs.** Full suites strain this machine. Use `nice -n 19 npx vitest run --maxWorkers=2` from the package directory; never run two suites concurrently. Builds: `pnpm build --concurrency=2`.
- **No self-confirming tests.** Never assert a hand-built expectation against itself. The auto-translate tests use a **stubbed model client returning deliberately corrupted output** to prove the guards reject it — no test asserts that a real model translates well.
- **Fixtures are edited LAST.** `render-fixtures.json` gains a node's entries only after all three renderers can decode that node (2026-07-29 lesson). A fixture must never describe something no renderer draws.
- **Verify Kotlin with `testDebugUnitTest`**, never `compileReleaseKotlin` — the latter does not run tests.
- TypeScript strict everywhere; Zod for API input; API responses are `{ data: T }` or `{ error: { code, message } }`.
- Conventional commits. Commit at the end of every task.

---

## File Structure

**Created:**
- `apps/dashboard/src/components/paywall-builder/template-kit.ts` — section factories (hero, feature list, comparison, timeline, carousel, video, social proof, countdown, footer). One responsibility: "produce a well-formed subtree plus its copy".
- `apps/dashboard/src/components/paywall-builder/template-kit.test.ts`
- `apps/dashboard/src/components/paywall-builder/templates.ts` — the catalogue: 18 entries composed from the kit, replacing `presets.ts`'s two hand-written builders.
- `apps/dashboard/src/components/paywall-builder/templates.test.ts` — the one test that runs over **every** catalogue entry.
- `apps/dashboard/src/components/paywall-builder/template-preview.tsx` — a catalogue card's real (scaled) `PaywallRenderer` preview against a synthetic offering.
- `packages/shared/src/i18n/store-locales.ts` — the curated store-supported locale table + `localeLabel`.
- `packages/shared/src/i18n/store-locales.test.ts`
- `apps/api/src/services/paywall-ai/translate.ts` — the auto-translate service.
- `apps/api/src/services/paywall-ai/translate.test.ts`
- `apps/dashboard/src/lib/hooks/usePaywallTranslate.ts` — the mutation hook.

**Modified:**
- `apps/dashboard/src/components/paywall-builder/experiment-popover.tsx` — `border` probe + editor (Task 1).
- `packages/shared/src/paywall/schema.ts` — `FooterLinksNode`, its Zod schema, union members, `OVERRIDABLE_PROP_KEYS` row (Task 2).
- `packages/shared/src/paywall/validate.ts` — `LOCALIZED_KEYS.footerLinks` (Task 2) and `resolveText`'s base-language fallback (Task 11).
- `packages/shared/src/paywall/collect-urls.ts` — the exhaustive switch (Task 2).
- `packages/paywall-renderer/src/nodes.tsx`, `styles.ts` (Task 3).
- `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift`, `RovenuePaywallView.swift`, `PaywallViewModelHelpers.swift` (Tasks 4, 11).
- `packages/sdk-kotlin/.../paywallui/BuilderConfigModel.kt`, `NodeViewFactory.kt`, `PaywallHelpers.kt` (Tasks 5, 11).
- `packages/shared/src/paywall/render-fixtures.json` (Tasks 6, 11).
- `apps/dashboard/src/components/paywall-builder/node-meta.ts`, `tree-ops.ts`, `inspector/content-tab.tsx`, `inspector/style-tab.tsx`, `inspector/tabs.ts`, `inspector/overrides.tsx`, `i18n/locales/en.json` (Task 7).
- `apps/dashboard/src/components/paywall-builder/start-modal.tsx`, `start-model.ts`, `vm/paywall-builder.vm.ts` (Tasks 9, 10, 12, 14).
- `apps/api/src/routes/dashboard/paywalls.ts` — the translate route (Task 13).
- `apps/dashboard/src/components/paywall-builder/localization-modal.tsx` (Task 14).
- `ROADMAP.md` (Task 15).

---

### Task 1: Close the element-experiment `border` dead end

The experiment popover derives its per-prop editor by **probing the schema**
(`detectPropEditor` at `experiment-popover.tsx:79`): it tries a number, then a
`ThemeColor`, and falls back to a free-text box. `border` is a `NodeBorder`
(`{ width, color }`), which no text can express, so picking `stack.border` or
`button.border` leaves the form permanently invalid. The inspector already has
a working `NodeBorder` editor — `BorderField` in `inspector/fields.tsx:231` —
so this adds a fourth probe and reuses that component rather than writing a
second border editor.

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/experiment-popover.tsx:62-100` (probe + editor type + value encoding) and its editor-rendering JSX
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/experiment-popover-editors.test.ts` (create)

**Interfaces:**
- Consumes: `OVERRIDABLE_PROP_KEYS`, `paywallNodeSchema` from `@rovenue/shared/paywall`; `BorderField`, `DEFAULT_BORDER_WIDTH`, `DEFAULT_BORDER_COLOR_HEX` from `./inspector/fields`.
- Produces: `ElementPropEditor` gains the `"border"` member; `detectPropEditor(node, prop): ElementPropEditor` is exported so the guard test can call it.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/paywall-builder/__tests__/experiment-popover-editors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OVERRIDABLE_PROP_KEYS, type PaywallNode } from "@rovenue/shared/paywall";
import { detectPropEditor } from "../experiment-popover";

/**
 * One representative node per type, in the shape `newNode()` produces, so a
 * probe runs against a node the schema actually accepts. Keyed by node type
 * so a new node type without a sample fails this file by name.
 */
const SAMPLE_NODES: Record<PaywallNode["type"], PaywallNode> = {
  stack: { type: "stack", id: "n", axis: "v", children: [] },
  text: { type: "text", id: "n", key: "k", role: "body" },
  image: { type: "image", id: "n", url: { light: "" } },
  button: { type: "button", id: "n", labelKey: "k", style: "plain", action: { kind: "close" } },
  packageList: { type: "packageList", id: "n", packageIds: [], cellLayout: "column" },
  purchaseButton: { type: "purchaseButton", id: "n", labelKey: "k" },
  spacer: { type: "spacer", id: "n", size: 16 },
  divider: { type: "divider", id: "n", thickness: 1, inset: 0 },
  icon: { type: "icon", id: "n", name: "star", size: 20 },
  featureList: { type: "featureList", id: "n", rows: [{ labelKey: "k" }] },
  timeline: { type: "timeline", id: "n", rows: [{ labelKey: "k" }] },
  socialProof: { type: "socialProof", id: "n", labelKey: "k" },
  stickyFooter: { type: "stickyFooter", id: "n", children: [] },
  countdown: { type: "countdown", id: "n", durationSeconds: 600 },
  carousel: { type: "carousel", id: "n", children: [] },
  video: { type: "video", id: "n", url: { light: "" } },
  lottie: { type: "lottie", id: "n", url: { light: "" } },
};

describe("element-experiment prop editors", () => {
  it("resolves a usable editor for every overridable prop — no prop is a dead end", () => {
    const deadEnds: string[] = [];
    for (const [type, props] of Object.entries(OVERRIDABLE_PROP_KEYS)) {
      const node = SAMPLE_NODES[type as PaywallNode["type"]];
      for (const prop of props) {
        const editor = detectPropEditor(node, prop);
        // A `text` editor is only honest for props a typed string can express.
        // An object-valued prop landing on `text` can never validate.
        if (editor === "text" && prop === "border") deadEnds.push(`${type}.${prop}`);
      }
    }
    expect(deadEnds).toEqual([]);
  });

  it("detects the border editor for every border prop", () => {
    expect(detectPropEditor(SAMPLE_NODES.button, "border")).toBe("border");
    expect(detectPropEditor(SAMPLE_NODES.stack, "border")).toBe("border");
    expect(detectPropEditor(SAMPLE_NODES.image, "border")).toBe("border");
  });

  it("still detects number and color props, unchanged by the new probe", () => {
    expect(detectPropEditor(SAMPLE_NODES.stack, "spacing")).toBe("number");
    expect(detectPropEditor(SAMPLE_NODES.divider, "thickness")).toBe("number");
    expect(detectPropEditor(SAMPLE_NODES.text, "color")).toBe("color");
    expect(detectPropEditor(SAMPLE_NODES.stack, "background")).toBe("color");
  });

  it("leaves enum and plain-string props on the text editor", () => {
    expect(detectPropEditor(SAMPLE_NODES.button, "style")).toBe("text");
    expect(detectPropEditor(SAMPLE_NODES.text, "key")).toBe("text");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder/__tests__/experiment-popover-editors.test.ts --maxWorkers=2`

Expected: FAIL — `detectPropEditor` is not exported (import error), and once exported, `border` resolves to `"text"`.

- [ ] **Step 3: Add the probe and the editor**

In `experiment-popover.tsx`, extend the editor union and probes:

```ts
export type ElementPropEditor = "text" | "number" | "color" | "border";

const PROBE_NUMBER = 1;
const PROBE_THEME_COLOR = { light: "#000000" } as const;
/** A `NodeBorder` requires BOTH fields, so no ThemeColor prop accepts it and
 *  no border prop accepts a bare ThemeColor — the two probes cannot collide. */
const PROBE_BORDER = { width: 1, color: { light: "#000000" } } as const;

export function detectPropEditor(node: PaywallNode, prop: string): ElementPropEditor {
  if (nodeAccepts(node, prop, PROBE_NUMBER)) return "number";
  if (nodeAccepts(node, prop, PROBE_THEME_COLOR)) return "color";
  if (nodeAccepts(node, prop, PROBE_BORDER)) return "border";
  return "text";
}
```

The border editor holds a real `NodeBorder | undefined` rather than the
`light`/`dark` string pair the other editors share, so give the popover a
dedicated piece of state next to the existing ones:

```ts
const [variantBorder, setVariantBorder] = useState<NodeBorder | undefined>(undefined);
```

and return it from value encoding:

```ts
function encodeElementValue(
  editor: ElementPropEditor,
  light: string,
  dark: string,
  border: NodeBorder | undefined,
): unknown {
  if (editor === "border") return border;
  const value = light.trim();
  if (value.length === 0) return undefined;
  if (editor === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (editor === "color") {
    const darkValue = dark.trim();
    return darkValue.length > 0 ? { light: value, dark: darkValue } : { light: value };
  }
  return value;
}
```

Update every `encodeElementValue(...)` call site to pass `variantBorder`, and
render the editor where the existing per-editor JSX branches live:

```tsx
{propEditor === "border" ? (
  <BorderField
    label={t("paywalls.builder.experiment.variantValue", "Variant B value")}
    value={variantBorder}
    onChange={setVariantBorder}
  />
) : (
  /* the existing text / number / color inputs, unchanged */
)}
```

Import `BorderField` from `./inspector/fields` and `NodeBorder` from
`@rovenue/shared/paywall`. Reset `variantBorder` to `undefined` wherever the
form already resets the light/dark inputs (on prop change and on close), so a
border value cannot leak across prop selections.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder/__tests__/experiment-popover-editors.test.ts --maxWorkers=2`

Expected: PASS (4 tests).

- [ ] **Step 5: Run the popover's existing tests for regressions**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2`

Expected: PASS — no existing assertion changes.

- [ ] **Step 6: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/experiment-popover.tsx \
        apps/dashboard/src/components/paywall-builder/__tests__/experiment-popover-editors.test.ts
git commit -m "fix(paywall-builder): give element experiments a border editor

`border` was offered in the element-experiment prop picker but no probe
matched it, so it fell to the free-text editor, where a NodeBorder can
never be typed and Create stayed disabled forever. Adds the probe and
reuses the inspector's existing BorderField, plus a test that walks every
OVERRIDABLE_PROP_KEYS entry and fails by name on a prop with no usable
editor."
```

---

### Task 2: `footerLinks` in the shared schema

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts` (type, constants, Zod schema, `PaywallNode` union, `paywallNodeSchema` union, `OVERRIDABLE_PROP_KEYS`)
- Modify: `packages/shared/src/paywall/validate.ts:61-83` (`LOCALIZED_KEYS`)
- Modify: `packages/shared/src/paywall/collect-urls.ts:64-99` (exhaustive switch)
- Test: `packages/shared/src/paywall/schema.test.ts`, `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Produces: `FooterLinksNode`, `FooterLink`, `FOOTER_LINKS_MAX`, `FOOTER_LINKS_DEFAULT_SEPARATOR`, `FOOTER_LINKS_DEFAULT_ALIGN` — all exported from `@rovenue/shared/paywall`. `OVERRIDABLE_PROP_KEYS.footerLinks` is `["color", "separator", "align"]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/paywall/schema.test.ts`:

```ts
describe("footerLinks node", () => {
  const link = { labelKey: "f_terms", action: { kind: "url" as const, url: "https://x.dev/terms" } };

  it("accepts a minimal footerLinks node", () => {
    const node = { type: "footerLinks", id: "f", links: [link] };
    expect(paywallNodeSchema.safeParse(node).success).toBe(true);
  });

  it("accepts every separator and align member", () => {
    for (const separator of ["dot", "pipe", "none"]) {
      for (const align of ["start", "center", "end"]) {
        const node = { type: "footerLinks", id: "f", links: [link], separator, align };
        expect(paywallNodeSchema.safeParse(node).success).toBe(true);
      }
    }
  });

  it("accepts all three action kinds, reusing the button action union", () => {
    const links = [
      { labelKey: "a", action: { kind: "restore" } },
      { labelKey: "b", action: { kind: "url", url: "https://x.dev/privacy" } },
      { labelKey: "c", action: { kind: "close" } },
    ];
    expect(paywallNodeSchema.safeParse({ type: "footerLinks", id: "f", links }).success).toBe(true);
  });

  it("rejects an empty links array", () => {
    expect(paywallNodeSchema.safeParse({ type: "footerLinks", id: "f", links: [] }).success).toBe(false);
  });

  it("rejects more than FOOTER_LINKS_MAX links", () => {
    const links = Array.from({ length: FOOTER_LINKS_MAX + 1 }, (_, i) => ({
      labelKey: `f_${i}`,
      action: { kind: "restore" as const },
    }));
    expect(paywallNodeSchema.safeParse({ type: "footerLinks", id: "f", links }).success).toBe(false);
  });

  it("rejects an unknown separator", () => {
    const node = { type: "footerLinks", id: "f", links: [link], separator: "slash" };
    expect(paywallNodeSchema.safeParse(node).success).toBe(false);
  });

  it("gives footerLinks an OVERRIDABLE_PROP_KEYS row", () => {
    expect(OVERRIDABLE_PROP_KEYS.footerLinks).toEqual(["color", "separator", "align"]);
  });
});
```

Append to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("footerLinks localization keys", () => {
  it("contributes every link's labelKey, in link order", () => {
    const node = {
      type: "footerLinks" as const,
      id: "f",
      links: [
        { labelKey: "f_restore", action: { kind: "restore" as const } },
        { labelKey: "f_terms", action: { kind: "url" as const, url: "https://x.dev/t" } },
      ],
    };
    expect(localizedKeysOf(node)).toEqual(["f_restore", "f_terms"]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/shared && nice -n 19 npx vitest run src/paywall/schema.test.ts src/paywall/validate.test.ts --maxWorkers=2`

Expected: FAIL — `footerLinks` is not a member of the union, `FOOTER_LINKS_MAX` is not exported.

- [ ] **Step 3: Add the type, constants and Zod schema**

In `schema.ts`, next to the other list-node types (after `TimelineNode`):

```ts
/** Upper bound on links in one footer row. Four already wraps on a 320pt
 *  device; beyond that the row stops reading as fine print. */
export const FOOTER_LINKS_MAX = 5;
/** Absent `separator` renders FOOTER_LINKS_DEFAULT_SEPARATOR on every platform. */
export const FOOTER_LINKS_DEFAULT_SEPARATOR = "dot" as const;
/** Absent `align` renders FOOTER_LINKS_DEFAULT_ALIGN on every platform. */
export const FOOTER_LINKS_DEFAULT_ALIGN = "center" as const;

/**
 * One tappable link in a footer row. `action` is the SAME union a button
 * carries — a footer link and a button do the same three things, and a
 * second action union would be a second thing to keep in sync across three
 * renderers.
 */
export type FooterLink = {
  labelKey: string;
  action: ButtonNode["action"];
};

/**
 * The row of small, low-emphasis legal/action links at the bottom of a
 * paywall: Restore Purchases · Terms · Privacy. A first-class node rather
 * than a horizontal stack of plain buttons because the separators, the wrap
 * behaviour and the shared type treatment are properties of the ROW, and a
 * stack can express none of the three.
 */
export type FooterLinksNode = {
  type: "footerLinks";
  id: string;
  links: FooterLink[];
  /** Absent = FOOTER_LINKS_DEFAULT_SEPARATOR. */
  separator?: "dot" | "pipe" | "none";
  /** Absent = FOOTER_LINKS_DEFAULT_ALIGN. */
  align?: "start" | "center" | "end";
  /** Applies to every link's label AND the separators. Absent = inherit. */
  color?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Add `| FooterLinksNode` to the `PaywallNode` union (`schema.ts:424-441`).

Add the row to `OVERRIDABLE_PROP_KEYS` (`schema.ts:463-481`), after `lottie`:

```ts
  footerLinks: ["color", "separator", "align"],
```

`links` is deliberately absent: it is structural, exactly like `children`,
`packageIds` and `action`, which the table's own comment already excludes.

Add the Zod schemas next to `timelineNodeSchema`:

```ts
const footerLinkSchema: z.ZodType<FooterLink> = z.object({
  labelKey: z.string().min(1),
  action: buttonActionSchema,
});

const footerLinksNodeSchema: z.ZodType<FooterLinksNode> = z.object({
  type: z.literal("footerLinks"),
  id: z.string().min(1),
  links: z.array(footerLinkSchema).min(1).max(FOOTER_LINKS_MAX),
  separator: z.enum(["dot", "pipe", "none"]).optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  color: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.footerLinks).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});
```

`footerLinkSchema` must be declared **after** `buttonActionSchema`
(`schema.ts:622`). Add `footerLinksNodeSchema` to the `paywallNodeSchema`
union list (`schema.ts:815-833`).

- [ ] **Step 4: Add the `LOCALIZED_KEYS` row**

In `validate.ts`, inside `LOCALIZED_KEYS`:

```ts
  footerLinks: (n) => n.links.map((l) => l.labelKey),
```

Without this the file does not compile — `LocalizedKeyFns` is a mapped type
over the discriminant.

- [ ] **Step 5: Add the `collect-urls` case**

In `collect-urls.ts`'s `walk` switch, add `footerLinks` to the group of node
types that carry no URL (next to `"timeline"` / `"socialProof"`):

```ts
    case "footerLinks":
```

A footer link's `{ kind: "url" }` action is an external destination the host
opens, **not** a media asset the publish-time asset-usage index should claim —
`collectMediaUrls` exists to track CDN assets. Leaving it out of the URL set is
the decision, and it needs the case anyway for the `never` guard to compile.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd packages/shared && nice -n 19 npx vitest run src/paywall --maxWorkers=2`

Expected: PASS for the new blocks. The `render-fixtures` node-type coverage
test WILL now fail with `node types missing from the fixture: footerLinks` —
that is correct and expected; Task 6 adds the fixture after all three
renderers can decode it. Note the failure and continue.

- [ ] **Step 7: Typecheck**

Run: `cd packages/shared && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/paywall/
git commit -m "feat(paywall): add the footerLinks node to the shared schema

The 18th node type: the Restore / Terms / Privacy row every shipping
paywall has. It reuses ButtonNode's action union verbatim rather than
inventing a second one, and `links` stays out of OVERRIDABLE_PROP_KEYS
because it is structural.

render-fixtures.json is deliberately NOT updated yet -- its coverage test
fails by name until all three renderers can decode the node (Task 6)."
```

---

### Task 3: Web renderer — `footerLinks`

**Files:**
- Modify: `packages/paywall-renderer/src/nodes.tsx` (render function + the `renderNode` switch at ~1366-1445)
- Modify: `packages/paywall-renderer/src/styles.ts` (row + separator styles)
- Test: `packages/paywall-renderer/src/renderer.test.tsx`

**Interfaces:**
- Consumes: `FooterLinksNode`, `FOOTER_LINKS_DEFAULT_SEPARATOR`, `FOOTER_LINKS_DEFAULT_ALIGN` from `@rovenue/shared/paywall`; the existing `resolveText` + `onAction` plumbing every button node already uses.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing test**

Append to `packages/paywall-renderer/src/renderer.test.tsx`, following the file's existing render-a-config helper:

```tsx
describe("footerLinks node", () => {
  const config = {
    formatVersion: 2 as const,
    defaultLocale: "en",
    localizations: { en: { f_restore: "Restore Purchases", f_terms: "Terms", f_privacy: "Privacy" } },
    root: {
      type: "stack" as const,
      id: "root",
      axis: "v" as const,
      children: [
        {
          type: "footerLinks" as const,
          id: "f",
          links: [
            { labelKey: "f_restore", action: { kind: "restore" as const } },
            { labelKey: "f_terms", action: { kind: "url" as const, url: "https://x.dev/terms" } },
            { labelKey: "f_privacy", action: { kind: "url" as const, url: "https://x.dev/privacy" } },
          ],
        },
      ],
    },
  };

  it("renders one tappable element per link, with the resolved label", () => {
    renderConfig(config);
    expect(screen.getByRole("button", { name: "Restore Purchases" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Privacy" })).toBeTruthy();
  });

  it("renders one fewer separator than links, and none for separator: none", () => {
    const { container, unmount } = renderConfig(config);
    expect(container.querySelectorAll("[data-rv-footer-separator]").length).toBe(2);
    unmount();

    const none = { ...config, root: { ...config.root, children: [{ ...config.root.children[0], separator: "none" as const }] } };
    const bare = renderConfig(none);
    expect(bare.container.querySelectorAll("[data-rv-footer-separator]").length).toBe(0);
  });

  it("fires the same action callbacks a button node fires", () => {
    const onRestore = vi.fn();
    const onOpenUrl = vi.fn();
    renderConfig(config, { onRestore, onOpenUrl });
    fireEvent.click(screen.getByRole("button", { name: "Restore Purchases" }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Terms" }));
    expect(onOpenUrl).toHaveBeenCalledWith("https://x.dev/terms");
  });

  it("falls back to the default locale for a link with no translation", () => {
    const withPt = { ...config, localizations: { ...config.localizations, pt: { f_terms: "Termos" } } };
    renderConfig(withPt, { locale: "pt" });
    expect(screen.getByRole("button", { name: "Termos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore Purchases" })).toBeTruthy();
  });
});
```

Match `renderConfig`'s real signature in that file — read it first and adapt
the option names (`onRestore`/`onOpenUrl`/`locale`) to the props
`PaywallRendererProps` actually declares.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/paywall-renderer && nice -n 19 npx vitest run src/renderer.test.tsx --maxWorkers=2`

Expected: FAIL — nothing renders for the unknown node type.

- [ ] **Step 3: Implement the node**

In `styles.ts`, add the row and separator styles next to the existing node
style helpers:

```ts
/** Fine print, one step below `caption` — the row must read as secondary. */
export const FOOTER_LINK_FONT_SIZE = 12;
/** Horizontal gap between a link and its separator. */
export const FOOTER_LINK_GAP = 6;
/** Minimum tappable height, so fine print is still a real hit target. */
export const FOOTER_LINK_MIN_TAP_HEIGHT = 32;

export const footerRowStyle = (align: "start" | "center" | "end"): CSSProperties => ({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: align === "start" ? "flex-start" : align === "end" ? "flex-end" : "center",
  columnGap: FOOTER_LINK_GAP,
  rowGap: FOOTER_LINK_GAP,
});
```

In `nodes.tsx`, add the render function and the `case "footerLinks":` to the
`renderNode` switch. The separator glyph comes from a named table, never an
inline literal:

```tsx
/** The glyph drawn between two links, per `separator`. Same table on all
 *  three platforms — see render-fixtures.json. */
const FOOTER_SEPARATOR_GLYPH: Record<"dot" | "pipe" | "none", string> = {
  dot: "·",
  pipe: "|",
  none: "",
};
```

Each link renders as a `<button type="button">` reusing the node dispatcher's
existing action handler, so restore/url/close behave exactly as they do on a
`button` node. Separators are non-interactive, carry
`data-rv-footer-separator`, and are `aria-hidden` so a screen reader reads
three links, not three links and two glyphs.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd packages/paywall-renderer && nice -n 19 npx vitest run src/renderer.test.tsx --maxWorkers=2`

Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/paywall-renderer && npx tsc --noEmit`

```bash
git add packages/paywall-renderer/src/
git commit -m "feat(paywall-renderer): render the footerLinks node

Links are real buttons reusing the existing action plumbing; separators
are aria-hidden so the row reads as N links, not N links and N-1 glyphs.
The separator glyph table is shared with the two native renderers."
```

---

### Task 4: SwiftUI — `footerLinks`

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift` (props struct, `PaywallNode` enum case, decoder branch, `id` accessor, `visibility` accessor)
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallView.swift` (the view + the render-dispatch switch at ~733)
- Test: `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift`

**Interfaces:**
- Consumes: the JSON shape defined in Task 2.
- Produces: `FooterLinksProps` (Swift), decoded from `"footerLinks"`.

- [ ] **Step 1: Write the failing test**

The fixture entry does not exist yet (Task 6), so this task's test decodes an
inline JSON literal — the same thing the Swift tests do for shapes not yet in
the contract file. Append to `BuilderConfigModelTests.swift`:

```swift
// MARK: - footerLinks

func testDecodesFooterLinksNode() throws {
    let json = """
    {"type":"footerLinks","id":"f","links":[
      {"labelKey":"f_restore","action":{"kind":"restore"}},
      {"labelKey":"f_terms","action":{"kind":"url","url":"https://x.dev/terms"}}
    ],"separator":"pipe","align":"start"}
    """
    let node = try decodeNode(fromJSON: json)
    guard case .footerLinks(let props) = node else {
        return XCTFail("expected a footerLinks node, got \\(node)")
    }
    XCTAssertEqual(props.id, "f")
    XCTAssertEqual(props.links.count, 2)
    XCTAssertEqual(props.links[0].labelKey, "f_restore")
    XCTAssertEqual(props.separator, "pipe")
    XCTAssertEqual(props.align, "start")
}

func testFooterLinksDefaultsAreAbsentNotFabricated() throws {
    let json = """
    {"type":"footerLinks","id":"f","links":[{"labelKey":"a","action":{"kind":"restore"}}]}
    """
    let node = try decodeNode(fromJSON: json)
    guard case .footerLinks(let props) = node else {
        return XCTFail("expected a footerLinks node, got \\(node)")
    }
    // The DECODER keeps absence; the VIEW applies the default. Fabricating it
    // here would hide a renderer that forgot to.
    XCTAssertNil(props.separator)
    XCTAssertNil(props.align)
}
```

If `decodeNode(fromJSON:)` does not exist in the test support file, add it
alongside the existing `decodeNode(named:)` — a thin `JSONDecoder().decode`
of one node. Do **not** change `decodeNode(named:)`; Task 6 uses it.

- [ ] **Step 2: Run and confirm it fails**

Run: `cd packages/sdk-swift && swift test --filter BuilderConfigModelTests`

Expected: FAIL — `footerLinks` is not a case of the node enum.

- [ ] **Step 3: Implement the decode**

In `BuilderConfigModel.swift`, mirroring `TimelineProps` (line ~1076):

```swift
struct FooterLinkModel: Decodable {
    let labelKey: String
    let action: ButtonAction
}

struct FooterLinksProps: Decodable {
    let id: String
    let links: [FooterLinkModel]
    let separator: String?
    let align: String?
    let color: ThemeColor?
    let overrides: [NodeOverride]?
    let fallback: PaywallNode?
    let visibility: NodeVisibility?
}
```

Reuse the existing `ButtonAction` type the button node already decodes — do
not declare a second one. Add `case footerLinks(FooterLinksProps)` to the
`PaywallNode` enum, a `case "footerLinks":` branch to the manual decoder
switch (~1447), and cases to the `id` (~1492) and `visibility` (~1520)
accessor switches.

- [ ] **Step 4: Implement the view**

In `RovenuePaywallView.swift`, add a `FooterLinksView` and wire
`case .footerLinks(let p): FooterLinksView(props: p, ctx: ctx)` into the
render-dispatch switch (~733). Requirements, matching the web renderer:

- Wrapping row (`WrappingHStack` if the file already has one, otherwise a
  `FlowLayout`-style `Layout` — do not force a single-line `HStack`, three
  links overflow at 320pt).
- Separator glyph from the same table as the web renderer:
  `["dot": "·", "pipe": "|", "none": ""]`, drawn between links, never before
  the first or after the last, and excluded from accessibility
  (`.accessibilityHidden(true)`).
- Defaults applied HERE, not in the decoder: absent `separator` → `dot`,
  absent `align` → `center`.
- Each link is a `Button` calling the same action handler the button node
  uses, so restore/url/close paths are shared.
- Border/stroke, if any is drawn, uses `.strokeBorder`, never `.stroke` —
  `.stroke` straddles the shape edge and renders half-width (2026-07-29).

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd packages/sdk-swift && swift test --filter BuilderConfigModelTests`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/
git commit -m "feat(sdk-swift): decode and render the footerLinks node

Reuses the existing ButtonAction rather than declaring a second action
type. The decoder keeps `separator`/`align` absent and the view applies
the defaults, so a renderer that forgets one is visible in a test instead
of being masked by a fabricated decoder default."
```

---

### Task 5: Android — `footerLinks`

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModel.kt` (sealed-class member + decoder branch at ~576)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/NodeViewFactory.kt` (the view builder + dispatch)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModelTest.kt`, `NodeViewFactoryTest.kt`

**Interfaces:**
- Consumes: the JSON shape from Task 2.
- Produces: `BuilderNode.FooterLinks`.

- [ ] **Step 1: Write the failing tests**

Append to `BuilderConfigModelTest.kt`:

```kotlin
@Test
fun `decodes a footerLinks node`() {
    val json = """
        {"type":"footerLinks","id":"f","links":[
          {"labelKey":"f_restore","action":{"kind":"restore"}},
          {"labelKey":"f_terms","action":{"kind":"url","url":"https://x.dev/terms"}}
        ],"separator":"pipe","align":"start"}
    """.trimIndent()
    val node = decodeNode(json)
    assertTrue(node is BuilderNode.FooterLinks)
    node as BuilderNode.FooterLinks
    assertEquals("f", node.id)
    assertEquals(2, node.links.size)
    assertEquals("f_restore", node.links[0].labelKey)
    assertEquals("pipe", node.separator)
}

@Test
fun `keeps footerLinks defaults absent in the decoder`() {
    val json = """{"type":"footerLinks","id":"f","links":[{"labelKey":"a","action":{"kind":"restore"}}]}"""
    val node = decodeNode(json) as BuilderNode.FooterLinks
    assertNull(node.separator)
    assertNull(node.align)
}
```

Append to `NodeViewFactoryTest.kt`, following its existing pure-helper test
style (`nextCarouselPage` at ~781):

```kotlin
@Test
fun `separator glyphs match the shared table`() {
    assertEquals("·", footerSeparatorGlyph("dot"))
    assertEquals("|", footerSeparatorGlyph("pipe"))
    assertEquals("", footerSeparatorGlyph("none"))
    // Absent separator falls to the documented default, not to empty.
    assertEquals("·", footerSeparatorGlyph(null))
    // An unknown value fails open to the default rather than crashing --
    // the decoders are lenient by contract.
    assertEquals("·", footerSeparatorGlyph("slash"))
}
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests '*BuilderConfigModelTest*' --tests '*NodeViewFactoryTest*'`

Expected: FAIL — `BuilderNode.FooterLinks` and `footerSeparatorGlyph` do not exist.

- [ ] **Step 3: Implement the decode**

In `BuilderConfigModel.kt`, mirroring `data class Timeline` (~377):

```kotlin
data class FooterLink(
    val labelKey: String,
    val action: ButtonAction,
)

data class FooterLinks(
    override val id: String,
    val links: List<FooterLink>,
    val separator: String? = null,
    val align: String? = null,
    val color: ThemeColor? = null,
    override val overrides: List<NodeOverride>? = null,
    override val fallback: BuilderNode? = null,
    override val visibility: NodeVisibility? = null,
) : BuilderNode()
```

Reuse the existing `ButtonAction`. Add a `"footerLinks" ->` branch to the
manual `when (type)` decoder (~576).

- [ ] **Step 4: Implement the view**

In `NodeViewFactory.kt`, add the builder function and its dispatch entry.
Extract the glyph lookup as a top-level pure function so the test above can
call it without an Android context:

```kotlin
/** Separator glyph per `separator`, shared verbatim with the web and SwiftUI
 *  renderers (see render-fixtures.json). Absent or unknown -> the default,
 *  because native decoders are lenient by contract. */
internal fun footerSeparatorGlyph(separator: String?): String = when (separator) {
    "pipe" -> "|"
    "none" -> ""
    else -> "·"
}
```

The row uses a wrapping layout (Android has no flow container in the View
system — use the same approach `NodeViewFactory` already takes for any
wrapping content, or a simple measured line-breaking `ViewGroup`), each link
is a clickable `TextView` with `minHeight` matching the web renderer's tap
target, and separators are `importantForAccessibility = NO`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`

Expected: PASS. (`testDebugUnitTest`, never `compileReleaseKotlin` — the
latter compiles without running a single test.)

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/
git commit -m "feat(sdk-kotlin): decode and render the footerLinks node

The separator glyph lookup is a top-level pure function so it is testable
without an Android context, and it fails open to the default for an
unknown value -- native decoders are lenient by contract."
```

---

### Task 6: The three-platform fixture contract

All three renderers can now decode `footerLinks`, so the contract file can
describe it. **This is the correct order — a fixture added earlier would have
described something no renderer drew.**

**Files:**
- Modify: `packages/shared/src/paywall/render-fixtures.json`
- Test: `packages/shared/src/paywall/render-fixtures.test.ts` (no edit needed — its coverage set is derived), `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift`, `packages/sdk-kotlin/src/test/.../BuilderConfigModelTest.kt`

- [ ] **Step 1: Add the fixture entries**

Read the file's existing `accept` entry shape first and match it exactly. Add,
with these **names** (the Swift tests select by name, never by index):

- `footer-links-bare` — one restore link, no `separator`, no `align`.
- `footer-links-full` — three links (restore + two urls), `separator: "pipe"`,
  `align: "start"`, a `color`.
- `footer-links-separator-none` — two links, `separator: "none"`.
- `footer-links-max` — exactly `FOOTER_LINKS_MAX` (5) links, the wrap case.

Add to `reject`:

- `footer-links-empty` — `links: []`.
- `footer-links-over-max` — six links.
- `footer-links-unknown-separator` — `separator: "slash"` (strict TS authoring
  schema rejects it; the natives fail open to the default, which is why this
  is a `reject` entry and not `acceptLenient`).

- [ ] **Step 2: Run the shared coverage test**

Run: `cd packages/shared && nice -n 19 npx vitest run src/paywall/render-fixtures.test.ts --maxWorkers=2`

Expected: PASS — including the node-type coverage test that failed by name at
the end of Task 2.

- [ ] **Step 3: Add the native fixture-backed assertions**

In `BuilderConfigModelTests.swift`, add assertions that decode
`decodeNode(named: "footer-links-full")` and `decodeNode(named:
"footer-links-bare")` and check the same fields as Task 4's inline test. In
Kotlin's `BuilderConfigModelTest.kt`, do the same through its fixture loader.
Select by NAME in both.

- [ ] **Step 4: Run all three decoders**

Run, one at a time (never concurrently):

```
cd packages/shared && nice -n 19 npx vitest run src/paywall --maxWorkers=2
cd packages/paywall-renderer && nice -n 19 npx vitest run --maxWorkers=2
cd packages/sdk-swift && swift test --filter BuilderConfigModelTests
cd packages/sdk-kotlin && ./gradlew testDebugUnitTest
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/paywall/render-fixtures.json \
        packages/sdk-swift/Tests packages/sdk-kotlin/src/test
git commit -m "test(paywall): footerLinks enters the three-platform contract

Fixtures land last, after web, SwiftUI and Android can all decode the
node -- so the contract never describes something no renderer draws.
Native assertions select fixtures by name, never by index."
```

---

### Task 7: `footerLinks` in the builder

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/node-meta.ts` (`NODE_TYPES`, `NODE_ICON`, `NODE_TYPE_LABEL`, the "17 node types" comment)
- Modify: `apps/dashboard/src/components/paywall-builder/tree-ops.ts:422-467` (`newNode`)
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/content-tab.tsx:57-87`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/style-tab.tsx:35-65`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts` (`appliesTo` sets)
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx` (three new combo cases)
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/node-meta.test.ts`, `__tests__/tree-ops.test.ts`, `inspector/tabs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/tree-ops.test.ts`:

```ts
describe("newNode: footerLinks", () => {
  it("seeds one restore link with a fresh localization key derived from the id", () => {
    const node = newNode("footerLinks", () => "abc123");
    expect(node).toEqual({
      type: "footerLinks",
      id: "abc123",
      links: [{ labelKey: "footerLinks_abc123_1", action: { kind: "restore" } }],
    });
  });

  it("produces a node the strict schema accepts", () => {
    expect(paywallNodeSchema.safeParse(newNode("footerLinks", () => "abc123")).success).toBe(true);
  });
});
```

Append to `__tests__/node-meta.test.ts`:

```ts
it("carries metadata for every node type in the schema union", () => {
  const schemaTypes = Object.keys(OVERRIDABLE_PROP_KEYS).sort();
  expect([...NODE_TYPES].sort()).toEqual(schemaTypes);
  for (const type of schemaTypes) {
    expect(NODE_ICON[type as PaywallNode["type"]]).toBeDefined();
    expect(NODE_TYPE_LABEL[type as PaywallNode["type"]]).toBeTruthy();
  }
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2`

Expected: FAIL — `newNode` throws `Unknown node type: footerLinks`, and
`NODE_TYPES` is missing the entry.

- [ ] **Step 3: Wire the metadata and the factory**

In `node-meta.ts`: append `"footerLinks"` to `NODE_TYPES` (after `"lottie"`),
add `footerLinks: Link2` to `NODE_ICON` (import `Link2` from `lucide-react`),
add `footerLinks: "Footer links"` to `NODE_TYPE_LABEL`, and update the header
comment from "17 paywall node types" to "18".

In `tree-ops.ts`'s `newNode`, before the `default:` guard:

```ts
    case "footerLinks":
      return {
        type: "footerLinks",
        id,
        links: [{ labelKey: `footerLinks_${id}_1`, action: { kind: "restore" } }],
      };
```

Restore is the seed link because it is the only footer link every store
requires and the only one that needs no URL from the author.

- [ ] **Step 4: Add the inspector editors AND close the silent-default hole**

Add `case "footerLinks": return <FooterLinksContent node={node} />;` to
`ContentTab` and `case "footerLinks": return <FooterLinksStyle node={node} />;`
to `StyleTab`.

`FooterLinksContent` edits the link list: add/remove/reorder (capped at
`FOOTER_LINKS_MAX`), and per link a `LocalizedTextField` for `labelKey` plus
an action picker (restore / close / url, with a URL input shown only for
`url`) — the same three-way action editor `ButtonContent` already renders;
extract and reuse it rather than writing a second one.

`FooterLinksStyle` edits `separator`, `align` and `color`.

Then replace **both** switches' `default: return null` with an exhaustive
guard. The types with no editor are intentional, so list them explicitly:

```tsx
    // Node types with no Content tab by design: they carry no authorable
    // content of their own (stack/stickyFooter/carousel hold children,
    // packageList binds to the offering, spacer has only a size).
    case "stack":
    case "stickyFooter":
    case "carousel":
    case "packageList":
    case "spacer":
      return null;
    default: {
      // A new node type with no decision recorded above fails the build here
      // instead of silently rendering an empty inspector.
      const exhaustive: never = node;
      void exhaustive;
      return null;
    }
```

Do the same in `style-tab.tsx`, keeping its existing comment about
`video`/`lottie` having no Style tab by design and listing them (plus
`packageList`, `spacer`, `footerLinks` if it has no style case — it does have
one, so it is not in that list).

Add `"footerLinks"` to the `style` and `content` tab `appliesTo` sets in
`tabs.ts`.

- [ ] **Step 5: Add the override editor cases**

In `overrides.tsx`, add to the existing `ThemeColorField` case group:

```ts
    case "footerLinks.color":
```

and add a new text-ish case for the two enum props, reusing whatever select
primitive the file already uses for enum props (e.g. `button.style`):

```ts
    case "footerLinks.separator":
    case "footerLinks.align":
```

Without all three, `const exhaustive: never = combo` (`overrides.tsx:356`)
fails the build and names the missing combo.

- [ ] **Step 6: Add the i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, next to the other node-type and
field keys:

```json
"paywalls.builder.nodeTypes.footerLinks": "Footer links",
"paywalls.builder.properties.footerLinksAddLink": "Add link",
"paywalls.builder.properties.footerLinksLabel": "Label",
"paywalls.builder.properties.footerLinksAction": "Action",
"paywalls.builder.properties.footerLinksUrl": "URL",
"paywalls.builder.properties.footerLinksSeparator": "Separator",
"paywalls.builder.properties.footerLinksAlign": "Alignment",
"paywalls.builder.properties.footerLinksColor": "Link color"
```

Match the file's actual nesting (it is a nested object, not flat dotted keys —
read the neighbouring `timeline*` keys and follow their placement).

- [ ] **Step 7: Run the dashboard suite**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2`

Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `cd apps/dashboard && npx tsc --noEmit`

```bash
git add apps/dashboard/src/components/paywall-builder/ apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(paywall-builder): author footerLinks nodes

Palette entry, node factory, content and style editors, override combos
and i18n keys for the 18th node type.

Also closes a hole next door: the Content and Style tab switches ended in
`default: return null`, so a node type with no editor shipped an empty
inspector silently. Both are now exhaustive with the intentional
no-editor types listed by name -- the same guard overrides.tsx already
had."
```

---

### Task 8: The template kit

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/template-kit.ts`
- Test: `apps/dashboard/src/components/paywall-builder/template-kit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Section = { nodes: PaywallNode[]; copy: Record<string, string> };
  export function heroImage(p: { id: string; height?: number }): Section;
  export function headline(p: { id: string; title: string; subtitle?: string }): Section;
  export function featureRows(p: { id: string; rows: string[] }): Section;
  export function trialTimeline(p: { id: string; steps: Array<{ label: string; caption?: string }> }): Section;
  export function packages(p: { id: string; layout: "row" | "column" }): Section;
  export function purchaseCta(p: { id: string; label: string; trialLabel?: string }): Section;
  export function socialProof(p: { id: string; label: string; rating?: number }): Section;
  export function countdownBanner(p: { id: string; label: string; seconds: number }): Section;
  export function screenshotCarousel(p: { id: string; slides: number }): Section;
  export function videoHero(p: { id: string }): Section;
  export function footer(p: { id: string; restore: string; terms: string; privacy: string }): Section;
  export function spacer(p: { id: string; size?: number }): Section;
  export function compose(defaultLocale: string, sections: Section[]): BuilderConfig;
  ```
- `compose` builds the root stack from every section's nodes in order and
  merges every section's `copy` into `localizations[defaultLocale]`.

- [ ] **Step 1: Write the failing test**

Create `template-kit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { builderConfigSchema, validateBuilderConfig } from "@rovenue/shared/paywall";
import { compose, footer, headline, packages, purchaseCta } from "./template-kit";

describe("template kit", () => {
  it("composes sections into a config the strict schema accepts", () => {
    const config = compose("en", [
      headline({ id: "h", title: "Go Pro", subtitle: "Everything, unlocked." }),
      packages({ id: "p", layout: "column" }),
      purchaseCta({ id: "c", label: "Continue" }),
      footer({ id: "f", restore: "Restore Purchases", terms: "Terms", privacy: "Privacy" }),
    ]);
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("merges every section's copy into the default locale table", () => {
    const config = compose("en", [
      headline({ id: "h", title: "Go Pro", subtitle: "Everything, unlocked." }),
    ]);
    expect(Object.values(config.localizations.en!)).toContain("Go Pro");
    expect(Object.values(config.localizations.en!)).toContain("Everything, unlocked.");
  });

  it("gives every localization key a value — no key without copy", () => {
    const config = compose("en", [
      headline({ id: "h", title: "T" }),
      packages({ id: "p", layout: "row" }),
      purchaseCta({ id: "c", label: "Go", trialLabel: "Start free trial" }),
      footer({ id: "f", restore: "R", terms: "T", privacy: "P" }),
    ]);
    const issues = validateBuilderConfig(config, VALIDATE_OPTS);
    const missing = issues.filter((i) => i.code === "UNKNOWN_LOC_KEY" || i.code === "EMPTY_LOC_VALUE");
    expect(missing).toEqual([]);
  });

  it("namespaces node ids and locale keys by the section id, so two sections never collide", () => {
    const config = compose("en", [
      headline({ id: "a", title: "One" }),
      headline({ id: "b", title: "Two" }),
    ]);
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
    const issues = validateBuilderConfig(config, VALIDATE_OPTS);
    expect(issues.filter((i) => i.code === "DUPLICATE_NODE_ID")).toEqual([]);
  });

  it("binds to no project data: no package ids, no defaultSelected, no asset urls", () => {
    const config = compose("en", [packages({ id: "p", layout: "column" })]);
    const json = JSON.stringify(config);
    expect(json).not.toContain("defaultSelected");
    const list = config.root.children.find((n) => n.type === "packageList");
    expect(list && "packageIds" in list ? list.packageIds : null).toEqual([]);
  });
});
```

`validateBuilderConfig`'s real signature is
`(config, { offeringPackageIds: string[]; now?: () => number })`
(`packages/shared/src/paywall/validate.ts:449`), so declare the options once at
the top of the file and reuse it:

```ts
/** A template binds to no offering, so the validator sees an empty package
 *  set -- which is exactly the condition FOREIGN_PACKAGE_ID fires on if a
 *  template ever names a package. `now` is pinned so a countdown section's
 *  deadline check cannot depend on the wall clock. */
const VALIDATE_OPTS = { offeringPackageIds: [], now: () => Date.parse("2026-01-01T00:00:00Z") };
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder/template-kit.test.ts --maxWorkers=2`

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the kit**

Create `template-kit.ts`. Every factory namespaces its node ids and locale
keys with the section id (`${id}_title`, `${id}_cta`), returns its own copy,
and never references project data. Header comment states the three catalogue
constraints so the next author does not have to find them in a spec:

```ts
// =============================================================
// Section factories behind the template catalogue. Every template is a
// composition of these, so a template is a short list of sections plus
// its copy rather than a 120-line object literal.
//
// Three constraints hold for EVERY factory, and `templates.test.ts`
// enforces all three over the whole catalogue:
//   1. No package ids and no `defaultSelected` -- `packageIds: []` means
//      "every package in the offering", so a template validates against
//      ANY offering (FOREIGN_PACKAGE_ID rejects anything else).
//   2. No asset URLs. Asset-CDN URLs are `{projectId}/{assetId}.{ext}`,
//      so a baked URL would point every project at one project's private
//      prefix. Image/video nodes ship `{ light: "" }` -- a placeholder the
//      author replaces, allowed at save and caught by the publish gate.
//   3. Every locale key a factory's nodes reference gets a value in the
//      same factory's `copy`.
// =============================================================
```

`compose` merges in order and builds the root with the same padding/spacing
the current `presets.ts` `root()` helper uses (spacing 16, padding
`{ t: 24, r: 20, b: 24, l: 20 }`) — lift that helper here and delete it from
`presets.ts` in Task 9 rather than keeping two copies.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder/template-kit.test.ts --maxWorkers=2`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/template-kit.ts \
        apps/dashboard/src/components/paywall-builder/template-kit.test.ts
git commit -m "feat(paywall-builder): section factories for the template catalogue

A template becomes a composition of named sections instead of a hand-
written node tree, so 18 templates cost 18 short lists rather than 18
near-duplicate object literals -- and every one of them inherits the
no-package-ids / no-asset-urls / every-key-has-copy constraints."
```

---

### Task 9: The 18-template catalogue

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/templates.ts`
- Create: `apps/dashboard/src/components/paywall-builder/templates.test.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/presets.ts` (re-export from the catalogue for one release, or delete — see Step 4)
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts:695-710` (`applyPreset` reads the catalogue)

**Interfaces:**
- Produces:
  ```ts
  export type TemplateCategory =
    | "minimal" | "featureLed" | "comparison" | "trialLed" | "urgency" | "mediaLed";
  export type PaywallTemplate = {
    id: string;
    name: string;
    category: TemplateCategory;
    description: string;
    tags: readonly string[];
    build: (defaultLocale: string) => BuilderConfig;
  };
  export const TEMPLATES: readonly PaywallTemplate[];
  export const TEMPLATE_CATEGORIES: readonly { id: TemplateCategory; label: string }[];
  export type TemplateId = (typeof TEMPLATES)[number]["id"];
  ```
- `hero` and `comparison` keep their existing ids so a stored reference to
  either still resolves.

- [ ] **Step 1: Write the failing catalogue test**

Create `templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  builderConfigSchema,
  collectMediaUrls,
  validateBuilderConfig,
  type PaywallNode,
} from "@rovenue/shared/paywall";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "./templates";

/** The roadmap item asks for 15-20; below 15 the gallery is not the feature. */
const MIN_TEMPLATES = 15;
const MAX_TEMPLATES = 20;

function walk(node: PaywallNode, visit: (n: PaywallNode) => void): void {
  visit(node);
  if ("children" in node && Array.isArray(node.children)) node.children.forEach((c) => walk(c, visit));
  if ("cellTemplate" in node && node.cellTemplate) walk(node.cellTemplate, visit);
  if (node.fallback) walk(node.fallback, visit);
}

describe("template catalogue", () => {
  it("holds between MIN_TEMPLATES and MAX_TEMPLATES entries", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(MIN_TEMPLATES);
    expect(TEMPLATES.length).toBeLessThanOrEqual(MAX_TEMPLATES);
  });

  it("has unique ids and names", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.name)).size).toBe(TEMPLATES.length);
  });

  it("keeps the two original preset ids resolvable", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(expect.arrayContaining(["hero", "comparison"]));
  });

  it("puts every template in a declared category, and leaves no category empty", () => {
    const declared = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const t of TEMPLATES) expect(declared.has(t.category)).toBe(true);
    for (const c of TEMPLATE_CATEGORIES) {
      expect(TEMPLATES.some((t) => t.category === c.id)).toBe(true);
    }
  });

  describe.each(TEMPLATES.map((t) => [t.id, t] as const))("%s", (_id, template) => {
    const config = template.build("en");

    it("parses against the strict authoring schema", () => {
      const parsed = builderConfigSchema.safeParse(config);
      expect(parsed.success).toBe(true);
    });

    it("raises no validator issue outside LOCALE_KEY_GAP", () => {
      const issues = validateBuilderConfig(config, VALIDATE_OPTS).filter((i) => i.code !== "LOCALE_KEY_GAP");
      expect(issues).toEqual([]);
    });

    it("references no package id and sets no defaultSelected", () => {
      walk(config.root, (n) => {
        if (n.type === "packageList") {
          expect(n.packageIds).toEqual([]);
          expect(n.defaultSelected).toBeUndefined();
        }
      });
    });

    it("carries no asset URL — every media node is an empty placeholder", () => {
      expect(collectMediaUrls(config)).toEqual([]);
    });

    it("gives every localization key its own copy in the default locale", () => {
      const table = config.localizations.en ?? {};
      const issues = validateBuilderConfig(config, VALIDATE_OPTS);
      expect(issues.filter((i) => i.code === "UNKNOWN_LOC_KEY")).toEqual([]);
      for (const value of Object.values(table)) expect(value.trim().length).toBeGreaterThan(0);
    });

    it("ships exactly one purchase button — a paywall that cannot be bought is not a template", () => {
      let count = 0;
      walk(config.root, (n) => {
        if (n.type === "purchaseButton") count += 1;
      });
      expect(count).toBe(1);
    });
  });
});
```

`collectMediaUrls(config)` returns `string[]`
(`packages/shared/src/paywall/collect-urls.ts:114`), and `VALIDATE_OPTS` is the
same constant Task 8's test file declares -- declare it here too rather than
importing across test files.

- [ ] **Step 2: Run and confirm it fails**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder/templates.test.ts --maxWorkers=2`

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the catalogue**

Create `templates.ts` with **18** entries across the six categories, each a
short composition of Task 8's sections plus its own copy. Distribution:

| Category | Templates |
|---|---|
| `minimal` (3) | `hero` (the existing one, rebuilt on the kit), `minimalCta`, `singlePlan` |
| `featureLed` (3) | `featureChecklist`, `benefitStack`, `proVsFree` |
| `comparison` (3) | `comparison` (existing), `planGrid`, `annualHighlight` |
| `trialLed` (3) | `trialTimeline`, `trialReminder`, `freeTrialHero` |
| `urgency` (3) | `limitedOffer`, `countdownDeal`, `winbackDiscount` |
| `mediaLed` (3) | `screenshotCarousel`, `videoHero`, `testimonialWall` |

Every template ends with a `footer(...)` section, so the new node type is
exercised by the whole catalogue rather than by one demo. Copy is real
marketing English, not lorem ipsum — this is a shipped product surface.

Categories table:

```ts
export const TEMPLATE_CATEGORIES = [
  { id: "minimal", label: "Minimal" },
  { id: "featureLed", label: "Feature-led" },
  { id: "comparison", label: "Comparison" },
  { id: "trialLed", label: "Trial-led" },
  { id: "urgency", label: "Urgency" },
  { id: "mediaLed", label: "Media-led" },
] as const satisfies readonly { id: TemplateCategory; label: string }[];
```

- [ ] **Step 4: Retire `presets.ts`**

`PRESETS` and `PresetId` are imported by `start-modal.tsx` and the VM's
`applyPreset`. Replace them:

- Delete `presets.ts` (its `root()` helper moved to the kit in Task 8).
- In `vm/paywall-builder.vm.ts`, rename `applyPreset(id: PresetId)` to
  `applyTemplate(id: TemplateId)` reading `TEMPLATES`; the body is otherwise
  unchanged (it already calls `build(this.defaultLocale || "en")` and resets
  `locales`/`defaultLocale`/`editLocale`/`selectedNodeId`).
- Update every call site the compiler names.

- [ ] **Step 5: Run the tests**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2`

Expected: PASS — 18 templates × 6 per-template assertions, plus the
catalogue-level ones.

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/dashboard && npx tsc --noEmit`

```bash
git add apps/dashboard/src/components/paywall-builder/
git commit -m "feat(paywall-builder): an 18-template catalogue

Six categories x three templates, each a composition of the section kit,
each ending in a footerLinks row. One test runs over EVERY entry: strict
schema parse, no validator issue outside LOCALE_KEY_GAP, no package ids,
no defaultSelected, no asset URLs, copy for every key, exactly one
purchase button -- so a nineteenth template cannot skip validation.

presets.ts is retired; applyPreset becomes applyTemplate."
```

---

### Task 10: The gallery UI

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/start-modal.tsx` (the `presets` tab)
- Create: `apps/dashboard/src/components/paywall-builder/template-preview.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/start-model.ts` (filter helper)
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/start-model.test.ts`, `__tests__/template-preview.test.tsx`

**Interfaces:**
- Consumes: `TEMPLATES`, `TEMPLATE_CATEGORIES` from `./templates`; `placeholderPriceView` from `./canvas-helpers`; `PaywallRenderer`, `RendererOffering` from `@rovenue/paywall-renderer`.
- Produces: `filterTemplates(templates, { category, query })` in `start-model.ts`; `TEMPLATE_PREVIEW_OFFERING` and `<TemplatePreview config scale />` in `template-preview.tsx`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/start-model.test.ts`:

```ts
describe("filterTemplates", () => {
  const list = [
    { id: "a", name: "Hero", category: "minimal", description: "Big image", tags: ["image"] },
    { id: "b", name: "Plan grid", category: "comparison", description: "Side by side", tags: ["plans"] },
  ] as unknown as Parameters<typeof filterTemplates>[0];

  it("returns everything for no category and an empty query", () => {
    expect(filterTemplates(list, { category: null, query: "" })).toHaveLength(2);
  });

  it("filters by category", () => {
    expect(filterTemplates(list, { category: "comparison", query: "" }).map((t) => t.id)).toEqual(["b"]);
  });

  it("matches name, description and tags, case-insensitively", () => {
    expect(filterTemplates(list, { category: null, query: "HERO" }).map((t) => t.id)).toEqual(["a"]);
    expect(filterTemplates(list, { category: null, query: "side by" }).map((t) => t.id)).toEqual(["b"]);
    expect(filterTemplates(list, { category: null, query: "plans" }).map((t) => t.id)).toEqual(["b"]);
  });

  it("combines category and query", () => {
    expect(filterTemplates(list, { category: "minimal", query: "grid" })).toEqual([]);
  });
});
```

Create `__tests__/template-preview.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TEMPLATES } from "../templates";
import { TemplatePreview } from "../template-preview";

describe("TemplatePreview", () => {
  it("renders every catalogue template without throwing", () => {
    for (const template of TEMPLATES) {
      const { unmount } = render(<TemplatePreview config={template.build("en")} scale={0.3} />);
      unmount();
    }
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  it("shows the template's real copy, not a silhouette", () => {
    const hero = TEMPLATES.find((t) => t.id === "hero")!;
    const config = hero.build("en");
    const firstString = Object.values(config.localizations.en!)[0]!;
    const { getByText } = render(<TemplatePreview config={config} scale={0.3} />);
    expect(getByText(firstString)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder/__tests__ --maxWorkers=2`

Expected: FAIL — neither `filterTemplates` nor `TemplatePreview` exists.

- [ ] **Step 3: Implement the preview**

Create `template-preview.tsx`:

```tsx
/**
 * A catalogue card's preview: the template's REAL tree through the real
 * renderer, scaled down, against a synthetic offering.
 *
 * The abstract silhouette this replaces was fine for two presets; with
 * eighteen, four minimal templates produce four indistinguishable
 * silhouettes. A template has no project offering to bind to, so the
 * preview reuses the canvas's existing "no price feed" path:
 * a fixed synthetic offering plus `placeholderPriceView`.
 */
export const TEMPLATE_PREVIEW_OFFERING: RendererOffering = {
  identifier: "template-preview",
  packages: [
    { packageIdentifier: "monthly", displayName: "Monthly" },
    { packageIdentifier: "annual", displayName: "Annual" },
    { packageIdentifier: "weekly", displayName: "Weekly" },
  ],
};

/** Card viewport in px — the tree renders at this width, then scales. */
export const TEMPLATE_PREVIEW_WIDTH = 390;
export const TEMPLATE_PREVIEW_HEIGHT = 780;
```

The component renders `PaywallRenderer` inside a fixed-size box with
`transform: scale(...)`, `transformOrigin: "top left"`, `overflow: hidden`
and `pointer-events: none` (a card is not interactive). Pass
`colorScheme` from the dashboard's current theme, `now` pinned to a fixed
instant so a countdown template's card is deterministic, and `platform`
unset (visibility fails open).

- [ ] **Step 4: Implement the filter and rebuild the tab**

Add `filterTemplates` to `start-model.ts` (pure, no React). Rebuild the
`presets` tab of `start-modal.tsx` as: a category chip row (All + the six
categories), a search input, and the responsive card grid. Each card shows
`TemplatePreview`, the name, the description and its category. Keep the
existing "Blank canvas" card as the first entry, unchanged. Keep the
`appstore` and `ai` tabs untouched.

Cards call the same `choose()` path that exists today, now via
`vm.applyTemplate(id)`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2`

Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/dashboard && npx tsc --noEmit`

```bash
git add apps/dashboard/src/components/paywall-builder/
git commit -m "feat(paywall-builder): a browsable template gallery

Category chips, search, and card previews that render the template's real
tree through the real renderer against a synthetic offering -- the
abstract silhouette worked for two presets and stops distinguishing
anything at eighteen."
```

---

### Task 11: Region-aware locale matching, on all three platforms

`resolveText` matches the requested locale exactly and then jumps to
`defaultLocale`. A host passing `pt-BR` at a table keyed `pt` silently shows
the default language. A locale picker full of region-tagged store codes makes
that systematic, so the lookup is fixed before translations are generated.

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts:843-852` (`resolveText`)
- Modify: `packages/paywall-renderer/src/nodes.tsx` (it calls the shared one — verify, and if it has its own copy, update that too)
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/PaywallViewModelHelpers.swift:52-64`
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/PaywallHelpers.kt`
- Modify: `packages/shared/src/paywall/render-fixtures.json`
- Test: `packages/shared/src/paywall/validate.test.ts`, plus the Swift and Kotlin helper tests

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("resolveText locale matching", () => {
  const config = {
    formatVersion: 2 as const,
    defaultLocale: "en",
    localizations: {
      en: { k: "English" },
      pt: { k: "Português" },
      "zh-hans": { k: "简体中文" },
    },
    root: { type: "stack" as const, id: "root", axis: "v" as const, children: [] },
  };

  it("prefers an exact match", () => {
    expect(resolveText(config, "pt", "k")).toBe("Português");
  });

  it("falls back from a region tag to its base language", () => {
    expect(resolveText(config, "pt-BR", "k")).toBe("Português");
  });

  it("matches case-insensitively — a device reports zh-Hans, the builder stores zh-hans", () => {
    expect(resolveText(config, "zh-Hans", "k")).toBe("简体中文");
    expect(resolveText(config, "zh-Hans-CN", "k")).toBe("简体中文");
  });

  it("falls back to the default locale when no language matches", () => {
    expect(resolveText(config, "de-DE", "k")).toBe("English");
  });

  it("returns null for a key no table carries", () => {
    expect(resolveText(config, "pt", "missing")).toBeNull();
  });

  it("never prefers a base-language match over an exact one", () => {
    const withRegion = {
      ...config,
      localizations: { ...config.localizations, "pt-br": { k: "Português (BR)" } },
    };
    expect(resolveText(withRegion, "pt-BR", "k")).toBe("Português (BR)");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd packages/shared && nice -n 19 npx vitest run src/paywall/validate.test.ts --maxWorkers=2`

Expected: FAIL on the region and case tests (exact and default-fallback pass today).

- [ ] **Step 3: Implement the shared lookup**

Replace `resolveText` in `validate.ts`:

```ts
/**
 * Candidate lookup order for `locale`: the tag itself, then each
 * progressively shorter prefix (`zh-Hans-CN` -> `zh-Hans` -> `zh`). Same
 * progressive-truncation rule `@rovenue/shared/i18n`'s `expand()` applies to
 * remote-config values; duplicated here rather than imported because this
 * function is PORTED verbatim into the SwiftUI and Android renderers, and a
 * cross-module import has nothing to port to.
 */
function localeCandidates(locale: string): string[] {
  const parts = locale.split("-");
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join("-"));
  return out;
}

/**
 * locale -> its shorter prefixes -> defaultLocale -> null.
 *
 * Matching is case-insensitive because BCP-47 tags are, and the two sides
 * disagree in practice: the builder lowercases what an author types
 * (`vm.addLocale`), while a device reports `pt-BR` / `zh-Hans`.
 *
 * Widening only: an exact match still wins, so no paywall that resolves
 * today resolves differently.
 */
export function resolveText(config: BuilderConfig, locale: string, key: string): string | null {
  const tables = new Map<string, Record<string, string>>();
  for (const [code, table] of Object.entries(config.localizations)) {
    tables.set(code.toLowerCase(), table);
  }
  for (const candidate of localeCandidates(locale)) {
    const value = tables.get(candidate.toLowerCase())?.[key];
    if (value !== undefined) return value;
  }
  const fallback = tables.get(config.defaultLocale.toLowerCase())?.[key];
  return fallback !== undefined ? fallback : null;
}
```

- [ ] **Step 4: Port to SwiftUI and Android**

Apply the identical candidate-list + case-insensitive rule in
`PaywallViewModelHelpers.swift:52-64` and Kotlin's `PaywallHelpers.kt`,
keeping each file's existing "port of the shared `resolveText`" comment and
adding a line naming the new step. Add a unit test per platform covering the
same six cases as Step 1.

- [ ] **Step 5: Add the fixture cases**

`render-fixtures.json` already carries text/variable-semantics cases (see its
`_comment`). Add resolution cases named `locale-region-falls-back-to-base`,
`locale-case-insensitive` and `locale-exact-beats-base`, in whatever shape the
file's existing text-semantics entries use, and assert them from all three
platforms' fixture-backed tests.

- [ ] **Step 6: Run all four suites, one at a time**

```
cd packages/shared && nice -n 19 npx vitest run src/paywall --maxWorkers=2
cd packages/paywall-renderer && nice -n 19 npx vitest run --maxWorkers=2
cd packages/sdk-swift && swift test
cd packages/sdk-kotlin && ./gradlew testDebugUnitTest
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/paywall-renderer packages/sdk-swift packages/sdk-kotlin
git commit -m "fix(paywall): resolve text by language, not by exact locale tag

A host passing the device locale pt-BR at a table keyed pt fell straight
through to the default language, silently -- the renderer has no way to
report a miss. resolveText now tries the tag, then each shorter prefix,
then the default, case-insensitively (the builder lowercases what an
author types; devices report pt-BR and zh-Hans).

Strictly widening: an exact match still wins. Ported to all three
renderers with fixture cases, since resolveText is part of the decoder
contract."
```

---

### Task 12: The store-locale table and the locale picker

**Files:**
- Create: `packages/shared/src/i18n/store-locales.ts`
- Create: `packages/shared/src/i18n/store-locales.test.ts`
- Modify: `packages/shared/src/i18n/index.ts` (barrel export)
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx` (or wherever "Add locale" lives — the compiler and a grep for `addLocale` will name it)
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/locale-picker.test.tsx`

**Interfaces:**
- Produces: `STORE_LOCALES: readonly LocaleCode[]`, `localeLabel(code): string`, `searchLocales(query): LocaleCode[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/i18n/store-locales.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STORE_LOCALES, localeLabel, searchLocales } from "./store-locales";

describe("store locales", () => {
  it("carries the App Store / Play localization set without duplicates", () => {
    expect(new Set(STORE_LOCALES).size).toBe(STORE_LOCALES.length);
    expect(STORE_LOCALES.length).toBeGreaterThanOrEqual(30);
  });

  it("uses well-formed BCP-47 tags", () => {
    const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/;
    for (const code of STORE_LOCALES) expect(tag.test(code)).toBe(true);
  });

  it("labels a locale in English, falling back to the code itself", () => {
    expect(localeLabel("de-DE")).toMatch(/German/i);
    expect(localeLabel("qq-ZZ")).toBe("qq-ZZ");
  });

  it("searches by code and by English name, case-insensitively", () => {
    expect(searchLocales("portug")).toContain("pt-BR");
    expect(searchLocales("PT-")).toContain("pt-PT");
    expect(searchLocales("")).toEqual([...STORE_LOCALES]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd packages/shared && nice -n 19 npx vitest run src/i18n --maxWorkers=2`

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the table**

Create `store-locales.ts`:

```ts
import type { LocaleCode } from "./types";

// =============================================================
// The locale codes a paywall is worth translating into: the
// localization set App Store Connect accepts for an app listing,
// which Google Play's own list is very nearly a subset of. A
// structured reference table, not a set of magic values -- and NOT a
// hard limit: the builder still accepts a free-typed code for anything
// this list does not carry.
// =============================================================

export const STORE_LOCALES: readonly LocaleCode[] = [
  "ar-SA", "ca", "cs", "da", "de-DE", "el", "en-AU", "en-CA", "en-GB", "en-US",
  "es-ES", "es-MX", "fi", "fr-CA", "fr-FR", "he", "hi", "hr", "hu", "id",
  "it", "ja", "ko", "ms", "nl-NL", "no", "pl", "pt-BR", "pt-PT", "ro",
  "ru", "sk", "sv", "th", "tr", "uk", "vi", "zh-Hans", "zh-Hant",
];
```

`localeLabel` uses `Intl.DisplayNames(["en"], { type: "language" })` inside a
`try`/`catch`, returning the code itself on failure — the same helper shape
`funnel-builder/locale-switcher.tsx:19` already uses, so the two builders name
languages identically. `searchLocales` matches the code or the label.

Export all three from `packages/shared/src/i18n/index.ts`.

- [ ] **Step 4: Replace the free-text "Add locale" input**

Find the current caller (`grep -rn "addLocale" apps/dashboard/src`). Replace
the free-text input with a searchable picker listing `STORE_LOCALES` minus the
locales already on the config, each row showing `localeLabel(code)` and the
code. Keep a "use a custom code" escape hatch that calls the same
`vm.addLocale`, so nothing an author can express today becomes unreachable.

Write `__tests__/locale-picker.test.tsx` asserting: already-added locales are
not offered, search narrows the list, choosing a row calls `vm.addLocale` with
the exact code, and the custom-code path still works.

- [ ] **Step 5: Run the suites and commit**

```
cd packages/shared && nice -n 19 npx vitest run src/i18n --maxWorkers=2
cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2
cd apps/dashboard && npx tsc --noEmit
```

```bash
git add packages/shared/src/i18n apps/dashboard/src/components/paywall-builder
git commit -m "feat(paywall-builder): pick languages from the store locale set

Adding a locale was a free-text box, so a typo produced a locale table no
device would ever ask for. Now it is a searchable picker over the App
Store localization set, labelled with Intl.DisplayNames the same way the
funnel builder does it -- with a custom-code escape hatch kept."
```

---

### Task 13: The auto-translate service

**Files:**
- Create: `apps/api/src/services/paywall-ai/translate.ts`
- Create: `apps/api/src/services/paywall-ai/translate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TRANSLATE_MAX_RETRIES = 1;
  export const TRANSLATE_MAX_ENTRIES = 200;
  export class TranslationInvalidError extends Error { readonly keys: string[]; }
  export type TranslateResult = {
    entries: Record<string, string>;
    /** Keys the model returned unusable output for, after the retry. */
    rejected: string[];
  };
  export function extractPlaceholders(text: string): string[];
  export function translateEntries(
    input: { projectId: string; sourceLocale: string; targetLocale: string; entries: Record<string, string> },
    deps?: { modelFactory?: (resolved: ResolvedProvider) => LanguageModel },
  ): Promise<TranslateResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `translate.test.ts`. The model is stubbed — the point is to prove the
guards reject bad output, never that a real model translates well:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { extractPlaceholders, translateEntries, TranslationInvalidError } from "./translate";

// A stub LanguageModel whose object output is scripted per call, so each test
// says exactly what the model "returned" and asserts what the service did with
// it. Nothing here asserts translation quality.
function stubModel(responses: Array<Record<string, string>>) { /* per the ai SDK's test doubles */ }

describe("extractPlaceholders", () => {
  it("returns every {{var}} occurrence, including repeats, in order", () => {
    expect(extractPlaceholders("{{price}} then {{period}} then {{price}}"))
      .toEqual(["price", "period", "price"]);
  });

  it("tolerates inner whitespace, the way resolveVariables does", () => {
    expect(extractPlaceholders("{{ price }}")).toEqual(["price"]);
  });

  it("returns an empty list for text with no placeholders", () => {
    expect(extractPlaceholders("Continue")).toEqual([]);
  });
});

describe("translateEntries", () => {
  it("returns the model's entries when placeholders are preserved", async () => {
    const model = stubModel([{ cta: "Continuar por {{price}}" }]);
    const res = await translateEntries(
      { projectId: "p", sourceLocale: "en", targetLocale: "es", entries: { cta: "Continue for {{price}}" } },
      { modelFactory: () => model },
    );
    expect(res.entries).toEqual({ cta: "Continuar por {{price}}" });
    expect(res.rejected).toEqual([]);
  });

  it("retries once, naming the offending key, when a placeholder is translated away", async () => {
    const model = stubModel([
      { cta: "Continuar por {{precio}}" },   // mangled
      { cta: "Continuar por {{price}}" },    // fixed on retry
    ]);
    const res = await translateEntries(
      { projectId: "p", sourceLocale: "en", targetLocale: "es", entries: { cta: "Continue for {{price}}" } },
      { modelFactory: () => model },
    );
    expect(res.entries).toEqual({ cta: "Continuar por {{price}}" });
    expect(res.rejected).toEqual([]);
  });

  it("drops a key rather than returning a corrupted string when the retry also fails", async () => {
    const model = stubModel([
      { cta: "Continuar por {{precio}}" },
      { cta: "Continuar por {{precio}}" },
    ]);
    const res = await translateEntries(
      { projectId: "p", sourceLocale: "en", targetLocale: "es", entries: { cta: "Continue for {{price}}" } },
      { modelFactory: () => model },
    );
    expect(res.entries).toEqual({});
    expect(res.rejected).toEqual(["cta"]);
  });

  it("rejects a dropped placeholder and a duplicated one, not only a renamed one", async () => {
    const model = stubModel([
      { a: "Sin variable", b: "{{price}} {{price}}" },
      { a: "Sin variable", b: "{{price}} {{price}}" },
    ]);
    const res = await translateEntries(
      { projectId: "p", sourceLocale: "en", targetLocale: "es", entries: { a: "With {{price}}", b: "Once {{price}}" } },
      { modelFactory: () => model },
    );
    expect(res.rejected.sort()).toEqual(["a", "b"]);
  });

  it("reports a key the model never returned instead of silently skipping it", async () => {
    const model = stubModel([{ a: "Uno" }, { a: "Uno" }]);
    const res = await translateEntries(
      { projectId: "p", sourceLocale: "en", targetLocale: "es", entries: { a: "One", b: "Two" } },
      { modelFactory: () => model },
    );
    expect(res.entries).toEqual({ a: "Uno" });
    expect(res.rejected).toContain("b");
  });

  it("drops a key the caller never asked for", async () => {
    const model = stubModel([{ a: "Uno", injected: "malicious" }]);
    const res = await translateEntries(
      { projectId: "p", sourceLocale: "en", targetLocale: "es", entries: { a: "One" } },
      { modelFactory: () => model },
    );
    expect(res.entries).toEqual({ a: "Uno" });
  });

  it("rejects more than TRANSLATE_MAX_ENTRIES in one call", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: TRANSLATE_MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, "x"]),
    );
    await expect(
      translateEntries({ projectId: "p", sourceLocale: "en", targetLocale: "es", entries }, {}),
    ).rejects.toThrow();
  });
});

describe("quota", () => {
  it("bumps messages once and tokens per model call, read back from the row", async () => {
    // Reads copilot_usage_monthly through the repo after the call and asserts
    // the counters MOVED -- the guard reads this row, so a route that only
    // guards lets a project translate forever for free.
  });
});
```

The quota test needs a real row read. If `apps/api`'s unit setup has no
database, make it `translate.integration.test.ts` against testcontainers
(check `docker ps` first) rather than asserting a mock's call log.

- [ ] **Step 2: Run and confirm they fail**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/paywall-ai/translate.test.ts --maxWorkers=2`

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the service**

Create `translate.ts`, mirroring `generate.ts`'s structure exactly (provider
resolution, `generateObject`, retry-once, quota bumping):

```ts
// =============================================================
// Auto-translate for paywall copy (ROADMAP §3). Mirrors generate.ts:
// resolve the project's BYOK provider, call `generateObject` against a
// compact schema, validate, retry ONCE with the failures named.
//
// The strings arrive in the REQUEST, not from the paywall row: the
// builder autosaves on its own schedule, so the stored builderConfig is
// stale by design and a server-side write would be clobbered by the next
// autosave tick (the client-side-apply invariant -- see paywalls.ts's
// /from-app-store and /paywall-generate routes).
//
// The correctness guard is placeholder preservation. Paywall copy carries
// {{price}} / {{period}} / {{packageName}}, and `resolveVariables` leaves
// an UNKNOWN placeholder VERBATIM rather than throwing -- so a model that
// renames {{price}} to {{precio}} ships literal braces to a paying
// customer and nothing downstream notices. Every returned string must
// carry the same multiset of placeholders as its source.
// =============================================================

/** One retry, then the key is dropped -- same shape as GENERATION_MAX_RETRIES. */
export const TRANSLATE_MAX_RETRIES = 1;
/** Upper bound per call. A paywall with more strings than this is translated
 *  in several calls by the client, which keeps one call = one quota bump. */
export const TRANSLATE_MAX_ENTRIES = 200;

const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** Every `{{var}}` occurrence, in order, repeats included -- the comparison
 *  is a multiset, so a duplicated placeholder is a mismatch too. */
export function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]!);
}

function placeholdersMatch(source: string, candidate: string): boolean {
  const a = extractPlaceholders(source).slice().sort();
  const b = extractPlaceholders(candidate).slice().sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
```

`PLACEHOLDER_PATTERN` must be the same expression as
`packages/shared/src/paywall/variables.ts`'s `VARIABLE_PATTERN` — import it if
that module exports it; otherwise duplicate it with a comment naming the
source, and add an assertion in the test that the two agree on a sample string.

The model schema is `z.record(z.string(), z.string())` for the target locale.
The system prompt states: translate values only, never keys; preserve every
`{{token}}` exactly, including its spelling and count; keep the tone of app
store marketing copy; return one entry per input key. Sterilize/pseudonymize
inputs the same way the copilot path does before they leave the process.

Quota: `bumpUsage({ messages: 1 })` once before the first model call (the
model is about to be paid for regardless of outcome), then
`bumpUsage({ inputTokens, outputTokens })` per `generateObject` result,
including the `NoObjectGeneratedError` path's `err.usage` — copy `generate.ts`'s
two helpers verbatim rather than reinventing the accounting.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/paywall-ai --maxWorkers=2`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/paywall-ai/translate.ts apps/api/src/services/paywall-ai/translate.test.ts
git commit -m "feat(api): Rovi auto-translate for paywall copy

Mirrors generate.ts: BYOK provider, generateObject, retry once with the
failures named, quota fed (not merely guarded).

The guard that matters is placeholder preservation. resolveVariables
leaves an unknown {{token}} verbatim rather than throwing, so a model that
renames {{price}} to {{precio}} would ship literal braces to a paying
customer with nothing downstream to catch it. Every string must carry the
same multiset of placeholders as its source; a key that fails twice is
dropped and reported rather than returned corrupted."
```

---

### Task 14: The translate route

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts` (new route next to `/:id/paywall-generate`)
- Test: `apps/api/tests/paywall-translate.test.ts` (create; match the directory the other paywall route tests live in)

**Interfaces:**
- Produces: `POST /dashboard/projects/:projectId/paywalls/:id/translate`
  - body: `{ sourceLocale: string; targetLocale: string; entries: Record<string, string> }`
  - `200 { data: { entries, rejected } }`
  - `412 ROVI_NOT_CONFIGURED`, `422 TRANSLATION_INVALID`, `429 ROVI_QUOTA_EXCEEDED`, `404` unknown paywall.

- [ ] **Step 1: Write the failing tests**

Cover: a happy path returning entries; `roviQuotaGuard` producing 429 when the
project is over its tier limit; 404 for an unknown paywall id; 400 for a body
with `sourceLocale === targetLocale`; 412 when no provider is configured; and
— the important one — that the route **writes nothing**:

```ts
it("persists nothing: the paywall row's builderConfig is byte-identical afterwards", async () => {
  const before = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, paywallId);
  await request.post(`/dashboard/projects/${projectId}/paywalls/${paywallId}/translate`).send(body);
  const after = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, paywallId);
  expect(after!.builderConfig).toEqual(before!.builderConfig);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd apps/api && nice -n 19 npx vitest run tests/paywall-translate.test.ts --maxWorkers=2`

Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement the route**

Add next to `/:id/paywall-generate` (`paywalls.ts:571`), composing
`roviQuotaGuard()` per-route exactly as that one does, with the same
`assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT)` gate,
the same `RoviConfigError → 412 ROVI_NOT_CONFIGURED` mapping, and
`TranslationInvalidError → 422 TRANSLATION_INVALID`. Zod body schema:

```ts
const translateBodySchema = z.object({
  sourceLocale: z.string().min(2),
  targetLocale: z.string().min(2),
  entries: z.record(z.string().min(1), z.string()).refine(
    (e) => Object.keys(e).length > 0 && Object.keys(e).length <= TRANSLATE_MAX_ENTRIES,
    { message: `entries must hold 1..${TRANSLATE_MAX_ENTRIES} keys` },
  ),
}).refine((b) => b.sourceLocale !== b.targetLocale, {
  message: "sourceLocale and targetLocale must differ",
});
```

Carry a comment above the route stating that it writes nothing and why (the
client-side-apply invariant), the same way the two neighbouring AI routes do.

- [ ] **Step 4: Run the tests and the api suite**

```
cd apps/api && nice -n 19 npx vitest run tests/paywall-translate.test.ts --maxWorkers=2
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2
```

Expected: PASS. (`apps/api/tests` is a separate tsconfig root from
`apps/api/src` — run `npx tsc --noEmit` in `apps/api` and confirm the tests
type-check too.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/paywalls.ts apps/api/tests/paywall-translate.test.ts
git commit -m "feat(api): POST .../paywalls/:id/translate

Quota-guarded per-route like /paywall-generate, and writes nothing -- the
strings arrive in the request and the translations go back in the
response, because the builder's autosave would clobber any server-side
builderConfig write. A test asserts the row is byte-identical afterwards."
```

---

### Task 15: Translation management in the builder

**Files:**
- Create: `apps/dashboard/src/lib/hooks/usePaywallTranslate.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/localization-modal.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` (a merge entry point)
- Modify: `apps/dashboard/src/components/paywall-builder/localization-model.ts` (source-entry selection)
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/localization-translate.test.ts`

**Interfaces:**
- Produces: `vm.applyTranslations(locale: string, entries: Record<string, string>)` — merges through the shared `applyTreeOp({ kind: "setLocalizations", locale, entries })`, snapshots for revert, and marks the touched keys machine-translated in builder-local state; `vm.machineTranslated: ReadonlySet<string>` keyed `` `${locale}:${key}` ``.
- Produces: `sourceEntriesFor(config, rows, sourceLocale, keys)` in `localization-model.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("applyTranslations", () => {
  it("merges into the target locale, leaving other locales untouched", () => { /* ... */ });

  it("does not overwrite a hand-written value when filling gaps", () => {
    // The caller sends only the MISSING keys; assert a key that already had a
    // value keeps it even if the response carries one for it.
  });

  it("marks every applied cell machine-translated, scoped to its locale", () => {
    vm.applyTranslations("es", { a: "Uno" });
    expect(vm.machineTranslated.has("es:a")).toBe(true);
    expect(vm.machineTranslated.has("pt:a")).toBe(false);
  });

  it("clears the machine-translated mark when the author edits that cell", () => {
    vm.applyTranslations("es", { a: "Uno" });
    vm.setLocaleText("a", "es", "Uno revisado");
    expect(vm.machineTranslated.has("es:a")).toBe(false);
  });

  it("keeps the mark out of BuilderConfig — it is builder state, not wire format", () => {
    vm.applyTranslations("es", { a: "Uno" });
    expect(JSON.stringify(vm.config)).not.toContain("machineTranslated");
  });

  it("one revert restores the pre-translation config", () => {
    const before = JSON.stringify(vm.config);
    vm.applyTranslations("es", { a: "Uno" });
    vm.revertAiChange();
    expect(JSON.stringify(vm.config)).toBe(before);
  });
});

describe("sourceEntriesFor", () => {
  it("returns only the requested keys, with their source-locale text", () => { /* ... */ });
  it("skips a key the source locale has no text for — there is nothing to translate", () => { /* ... */ });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder/__tests__/localization-translate.test.ts --maxWorkers=2`

Expected: FAIL — `applyTranslations` and `sourceEntriesFor` do not exist.

- [ ] **Step 3: Implement the VM and model pieces**

`applyTranslations` uses `applyTreeOp({ kind: "setLocalizations", locale,
entries })` — which merges rather than replaces
(`packages/shared/src/paywall/tree-op.ts:212`) — snapshots into
`configBeforeAiApply` the way `applyExternalTreeOp` already does
(`paywall-builder.vm.ts:717`) so `revertAiChange()` works unchanged, and
records `` `${locale}:${key}` `` in a `machineTranslated` set. Have
`setLocaleText` delete the corresponding mark, next to its existing
`clearAiSnapshotOnManualEdit()` call.

`sourceEntriesFor(config, rows, sourceLocale, keys)` returns
`Record<key, string>` for keys whose source text is non-empty, using
`isCellMissing` so it agrees with the completion badges.

- [ ] **Step 4: Add the hook and the UI**

`usePaywallTranslate` posts to the Task 14 route and returns
`{ entries, rejected }`.

In `localization-modal.tsx`:

- A **Translate** button per locale column header. Default action fills only
  that column's `missingKeys` (`localeCompletion` already computes them). A
  separate, confirmed "Retranslate everything" sends every key — merge-first
  is the default because the alternative silently destroys reviewed copy.
- A per-cell translate action on an empty cell.
- Progress while the request is in flight, and, when `rejected` is non-empty,
  a message naming those keys: *"N strings were left untranslated — their
  `{{variables}}` could not be preserved."* Never swallow them.
- A subtle marker on machine-translated cells with a legend, so a reviewer can
  see what no human has read.
- The existing "N untranslated strings" footer and publish gate stay exactly
  as they are.

Add the i18n keys for every new string to `en.json`.

- [ ] **Step 5: Run the suite, typecheck, commit**

```
cd apps/dashboard && nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2
cd apps/dashboard && npx tsc --noEmit
```

```bash
git add apps/dashboard/src
git commit -m "feat(paywall-builder): translate a locale from the matrix

Per-column and per-cell auto-translate, filling gaps by default and
overwriting only behind an explicit confirm -- merge-not-replace, because
the alternative destroys reviewed copy silently. Applied client-side
through the existing setLocalizations op, so one revert undoes a whole
column, and machine-translated cells are marked in BUILDER state, never in
BuilderConfig: the config is the three-platform decoder contract, not a
place for dashboard bookkeeping.

Keys whose {{variables}} could not be preserved are reported by name, not
dropped in silence."
```

---

### Task 16: Documentation and ROADMAP

**Files:**
- Modify: `ROADMAP.md` §3
- Modify: `apps/docs` — the paywall builder pages (node reference, localization)

- [ ] **Step 1: Update ROADMAP §3**

Tick the four lines, each with what actually shipped — and for element
experiments, say plainly that §4 closed it and that this plan only fixed the
`border` editor. Do **not** tick "on-device smoke test session": it needs
physical devices and store sandbox accounts, and nothing in this plan changed
that. Re-score the section.

- [ ] **Step 2: Update the docs site**

Add `footerLinks` to the node-type reference with its props and the separator
table, and document the localization workflow: the locale picker,
auto-translate, what the placeholder guard does and why a string can come back
untranslated, and the new **language-level** locale matching (a `pt-BR` device
now finds a `pt` table). Note that `{{variables}}` are preserved verbatim by
contract.

Remember: a bare `{{var}}` breaks the MDX prerender — escape or fence every
placeholder example (2026-07-22).

- [ ] **Step 3: Build the docs to prove the prerender survives**

Run: `cd apps/docs && pnpm build`

Expected: build succeeds.

- [ ] **Step 4: Full verification before declaring the plan done**

Run each, one at a time, and record real output — not an expectation:

```
cd packages/shared && nice -n 19 npx vitest run --maxWorkers=2
cd packages/paywall-renderer && nice -n 19 npx vitest run --maxWorkers=2
cd apps/dashboard && nice -n 19 npx vitest run --maxWorkers=2
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2
cd packages/sdk-swift && swift test
cd packages/sdk-kotlin && ./gradlew testDebugUnitTest
pnpm build --concurrency=2
```

`pnpm build` is not optional: it is the only step that catches a
browser-incompatible import in the dashboard bundle (2026-09-02).

- [ ] **Step 5: Commit**

```bash
git add ROADMAP.md apps/docs
git commit -m "docs: close ROADMAP §3's four open lines"
```

---

## Self-Review

**Spec coverage.** §0 item 1 → Task 1 (and Task 16's honest ROADMAP wording).
§2 footer node → Tasks 2–7. §3 template gallery → Tasks 8–10. §4.1 locale
picker → Task 12. §4.2 auto-translate → Tasks 13–14. §4.3 translation
management → Task 15. §4.4 locale matching → Task 11. §4.5 (`ImageNode.alt`)
is explicitly not implemented and is recorded in Task 16's ROADMAP edit. §5's
"no migration" is a Global Constraint. §6's testing strategy is distributed
across every task's test steps.

**Ordering.** Task 11 (locale matching) precedes Task 12 (the picker) and
Task 15 (translation), so authors never create region-tagged tables the SDK
cannot find. Task 6 (fixtures) follows Tasks 3–5, never precedes them. Task 7
depends on Task 2's schema but not on the native renderers, so it could run
earlier — it is placed after Task 6 so the node is contract-complete before it
becomes reachable in the UI.

**Type consistency.** `detectPropEditor`/`ElementPropEditor` (Task 1);
`FooterLinksNode`/`FooterLink`/`FOOTER_LINKS_MAX` (Task 2) used verbatim in
Tasks 3–7; `Section`/`compose` (Task 8) consumed by Task 9;
`TEMPLATES`/`TemplateId`/`applyTemplate` (Task 9) consumed by Task 10;
`STORE_LOCALES`/`localeLabel` (Task 12); `translateEntries`/`TranslateResult`/
`TRANSLATE_MAX_ENTRIES` (Task 13) consumed by Task 14;
`applyTranslations`/`sourceEntriesFor` (Task 15). `applyPreset` is renamed to
`applyTemplate` in exactly one place (Task 9, Step 4) and used under that name
thereafter.
