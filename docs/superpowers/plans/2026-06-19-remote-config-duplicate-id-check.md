# Remote Config — Live Duplicate-ID Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Remote Config (feature-flags) new-flag form, validate the key/ID inline ~400ms after the user stops typing and block creating a flag whose key already exists in the selected environment.

**Architecture:** Keep the duplicate logic pure and unit-tested. A pure `deriveKeyStatus(key, existingKeys)` helper in the feature-flags `format.ts` decides `empty | invalid | available | taken`. A generic `useDebouncedValue` hook delays the typed key. `flag-form.tsx` loads the env-scoped flag list via the existing `useFeatureFlags(projectId, env)` query, feeds the debounced key + that env's keys into `deriveKeyStatus`, renders an inline status under the key field, and adds the result to its submit-disabled gate. The DB unique index `(projectId, env, key)` remains the authoritative backstop.

**Tech Stack:** React + TypeScript, TanStack Query, react-i18next, Vitest + Testing Library (jsdom).

## Global Constraints

- Dashboard only. No backend, schema, repository, or `@rovenue/shared` changes.
- Create mode only. Edit mode already locks the key (`disabled={isEdit}`) — do not add a check there.
- Duplicate scope = **exact, case-sensitive** key match within the **selected env**, mirroring the unique index `feature_flags_projectId_env_key_key` on `(projectId, env, key)`. The same key in another env is NOT a duplicate.
- Valid key pattern is `^[a-z0-9_-]+$` (case-insensitive) — the existing rule in `flag-form.tsx:227`. Centralize it so the form and the status helper share one source.
- Compare the **trimmed** key.
- All user-facing copy via i18n (`react-i18next`); add keys under `featureFlags.new`.
- Existing on-submit behavior (`errors.required`, `errors.invalidKey`, API error surfacing) must not regress.

---

## File Structure

- `apps/dashboard/src/components/feature-flags/format.ts` — add `FLAG_KEY_PATTERN`, the `KeyStatus` type, and the pure `deriveKeyStatus` helper (sits beside the existing `toDbEnv` env helper).
- `apps/dashboard/src/components/feature-flags/format.test.ts` — **new** unit tests for `deriveKeyStatus`.
- `apps/dashboard/src/components/feature-flags/index.ts` — export the new helper/type.
- `apps/dashboard/src/lib/hooks/useDebouncedValue.ts` — **new** generic debounce hook.
- `apps/dashboard/src/lib/hooks/useDebouncedValue.test.ts` — **new** unit test (fake timers).
- `apps/dashboard/src/components/feature-flags/flag-form.tsx` — wire debounce + list + status UI + submit gating.
- `apps/dashboard/src/i18n/locales/en.json` — add `featureFlags.new.keyStatus.*`.

---

## Task 1: Pure key-status helper

**Files:**
- Modify: `apps/dashboard/src/components/feature-flags/format.ts`
- Modify: `apps/dashboard/src/components/feature-flags/index.ts`
- Test: `apps/dashboard/src/components/feature-flags/format.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const FLAG_KEY_PATTERN = /^[a-z0-9_-]+$/i;`
  - `export type KeyStatus = "empty" | "invalid" | "available" | "taken";`
  - `export function deriveKeyStatus(rawKey: string, existingKeys: readonly string[]): KeyStatus;`
  - Semantics: trims `rawKey`. Empty → `"empty"`. Fails `FLAG_KEY_PATTERN` → `"invalid"`. Trimmed key present in `existingKeys` (exact, case-sensitive) → `"taken"`. Otherwise → `"available"`. Order: empty → invalid → taken → available.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/feature-flags/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveKeyStatus, FLAG_KEY_PATTERN } from "./format";

describe("deriveKeyStatus", () => {
  const existing = ["new_onboarding_flow", "paywall_v2"];

  it("returns empty for blank or whitespace-only input", () => {
    expect(deriveKeyStatus("", existing)).toBe("empty");
    expect(deriveKeyStatus("   ", existing)).toBe("empty");
  });

  it("returns invalid for keys with disallowed characters", () => {
    expect(deriveKeyStatus("has spaces", existing)).toBe("invalid");
    expect(deriveKeyStatus("nope!", existing)).toBe("invalid");
  });

  it("returns taken for an exact match in the current env list", () => {
    expect(deriveKeyStatus("paywall_v2", existing)).toBe("taken");
    expect(deriveKeyStatus("  paywall_v2  ", existing)).toBe("taken");
  });

  it("is case-sensitive — a case variant is available, not taken", () => {
    expect(deriveKeyStatus("Paywall_V2", existing)).toBe("available");
  });

  it("returns available for a valid, unused key", () => {
    expect(deriveKeyStatus("checkout_redesign", existing)).toBe("available");
  });

  it("treats a key free in this env (empty list) as available", () => {
    // env-switch behavior: same key, different env's list
    expect(deriveKeyStatus("paywall_v2", [])).toBe("available");
  });

  it("exposes the shared key pattern", () => {
    expect(FLAG_KEY_PATTERN.test("good-key_1")).toBe(true);
    expect(FLAG_KEY_PATTERN.test("bad key")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test src/components/feature-flags/format.test.ts`
Expected: FAIL — `deriveKeyStatus`/`FLAG_KEY_PATTERN` is not exported.

- [ ] **Step 3: Add the helper to `format.ts`**

Append to `apps/dashboard/src/components/feature-flags/format.ts`:

```ts
// =============================================================
// Key (ID) validation — shared by the new-flag form's live check
// =============================================================

/** Allowed flag-key characters. Mirrors the on-submit rule and SDK lookup. */
export const FLAG_KEY_PATTERN = /^[a-z0-9_-]+$/i;

export type KeyStatus = "empty" | "invalid" | "available" | "taken";

/**
 * Classify a typed flag key against the keys already present in the selected
 * environment. Case-sensitive exact match — mirrors the Postgres unique index
 * on (projectId, env, key), where "Foo" and "foo" are distinct keys.
 */
export function deriveKeyStatus(
  rawKey: string,
  existingKeys: readonly string[],
): KeyStatus {
  const key = rawKey.trim();
  if (key.length === 0) return "empty";
  if (!FLAG_KEY_PATTERN.test(key)) return "invalid";
  if (existingKeys.includes(key)) return "taken";
  return "available";
}
```

- [ ] **Step 4: Export from the barrel**

In `apps/dashboard/src/components/feature-flags/index.ts`, extend the `./format` export block to include the new symbols:

```ts
export {
  deriveKeyStatus,
  evalSparkSeries,
  FLAG_KEY_PATTERN,
  formatEvalCount,
  mapApiFeatureFlag,
  toDbEnv,
} from "./format";
export type { KeyStatus } from "./format";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test src/components/feature-flags/format.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/feature-flags/format.ts apps/dashboard/src/components/feature-flags/format.test.ts apps/dashboard/src/components/feature-flags/index.ts
git commit -m "feat(dashboard/remote-config): add deriveKeyStatus helper for key validation"
```

---

## Task 2: Generic debounced-value hook

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useDebouncedValue.ts`
- Test: `apps/dashboard/src/lib/hooks/useDebouncedValue.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function useDebouncedValue<T>(value: T, delayMs: number): T;` — returns the latest `value` only after it has been stable for `delayMs`. Resets the timer on every change; cleans up on unmount/change.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/lib/hooks/useDebouncedValue.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 400));
    expect(result.current).toBe("a");
  });

  it("delays updates until the value is stable for the delay", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 400),
      { initialProps: { v: "a" } },
    );
    rerender({ v: "ab" });
    expect(result.current).toBe("a"); // not yet
    act(() => vi.advanceTimersByTime(399));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("ab");
  });

  it("resets the timer when the value keeps changing", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 400),
      { initialProps: { v: "a" } },
    );
    rerender({ v: "ab" });
    act(() => vi.advanceTimersByTime(300));
    rerender({ v: "abc" });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe("a"); // never settled
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("abc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test src/lib/hooks/useDebouncedValue.test.ts`
Expected: FAIL — module not found / hook not exported.

- [ ] **Step 3: Write the hook**

Create `apps/dashboard/src/lib/hooks/useDebouncedValue.ts`:

```ts
import { useEffect, useState } from "react";

/**
 * Returns `value` only after it has stayed unchanged for `delayMs`.
 * Each change restarts the timer, so transient intermediate values are skipped.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test src/lib/hooks/useDebouncedValue.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useDebouncedValue.ts apps/dashboard/src/lib/hooks/useDebouncedValue.test.ts
git commit -m "feat(dashboard): add useDebouncedValue hook"
```

---

## Task 3: Wire the live check into the new-flag form

**Files:**
- Modify: `apps/dashboard/src/components/feature-flags/flag-form.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: `deriveKeyStatus`, `KeyStatus`, `FLAG_KEY_PATTERN` (Task 1); `useDebouncedValue` (Task 2); existing `useFeatureFlags(projectId, env?)` from `../../lib/hooks/useFeatureFlags`; existing `UI_TO_DB_ENV` map and `Field`/`Input` in this file.
- Produces: no new exports. Behavioral change only.

- [ ] **Step 1: Add i18n copy**

In `apps/dashboard/src/i18n/locales/en.json`, inside the `featureFlags.new` object, add a `keyStatus` block (e.g. directly after the existing `"placeholders": { ... }` block):

```json
      "keyStatus": {
        "checking": "Checking availability…",
        "available": "Available",
        "taken": "This ID is already used in {{env}}.",
        "invalid": "Letters, digits, dashes or underscores only."
      },
```

(Leave the existing `errors.required` / `errors.invalidKey` keys as-is; they still drive the on-submit path.)

- [ ] **Step 2: Import the new helpers in `flag-form.tsx`**

Add to the existing import groups near the top of `flag-form.tsx`:

```tsx
import { deriveKeyStatus, type KeyStatus } from "./format";
import { useDebouncedValue } from "../../lib/hooks/useDebouncedValue";
import { useFeatureFlags } from "../../lib/hooks/useFeatureFlags";
import { AlertCircle, Check, Loader2 } from "lucide-react";
```

Note: `AlertCircle` and `Check` are already imported in the existing lucide import block — do not duplicate them; only add `Loader2`. (Merge into the existing `lucide-react` import rather than adding a second statement.)

- [ ] **Step 3: Derive the live status inside `FlagForm`**

Inside the `FlagForm` component, after the existing `const [key, setKey] = useState(...)` and `const [env, setEnv] = useState<FlagEnv>(...)` declarations, add:

```tsx
  // Live duplicate-ID check (create mode only; edit locks the key).
  const debouncedKey = useDebouncedValue(key, 400);
  const flagsQuery = useFeatureFlags(projectId, UI_TO_DB_ENV[env]);
  const existingKeys = useMemo(
    () => (flagsQuery.data ?? []).map((f) => f.key),
    [flagsQuery.data],
  );
  const keyStatus: KeyStatus = useMemo(
    () => (isEdit ? "available" : deriveKeyStatus(debouncedKey, existingKeys)),
    [isEdit, debouncedKey, existingKeys],
  );
  // True while the user has typed something the debounce hasn't caught up to.
  const keyChecking =
    !isEdit && key.trim().length > 0 && key !== debouncedKey;
```

(`useMemo` is already imported at the top of the file.)

- [ ] **Step 4: Render the inline status under the key field**

In the key `Field` (the one wrapping the `<Input value={key} ...>` near `flag-form.tsx:365-383`), add a status line after the `Input` and before the `isEdit` "keyLocked" hint. Replace this block:

```tsx
            <Input
              value={key}
              mono
              onChange={(e) => setKey(e.target.value)}
              placeholder="new_onboarding_flow"
              required
              disabled={isEdit}
            />
            {isEdit && (
              <span className="mt-1 text-[10px] text-rv-mute-500">
                {t("featureFlags.edit.keyLocked")}
              </span>
            )}
```

with:

```tsx
            <Input
              value={key}
              mono
              onChange={(e) => setKey(e.target.value)}
              placeholder="new_onboarding_flow"
              required
              disabled={isEdit}
              aria-invalid={keyStatus === "taken" || keyStatus === "invalid"}
            />
            {isEdit ? (
              <span className="mt-1 text-[10px] text-rv-mute-500">
                {t("featureFlags.edit.keyLocked")}
              </span>
            ) : keyChecking ? (
              <span className="mt-1 inline-flex items-center gap-1 font-rv-mono text-[10px] text-rv-mute-500">
                <Loader2 size={10} className="animate-spin" />
                {t("featureFlags.new.keyStatus.checking")}
              </span>
            ) : keyStatus === "available" ? (
              <span className="mt-1 inline-flex items-center gap-1 font-rv-mono text-[10px] text-rv-success">
                <Check size={10} />
                {t("featureFlags.new.keyStatus.available")}
              </span>
            ) : keyStatus === "taken" ? (
              <span className="mt-1 inline-flex items-start gap-1 font-rv-mono text-[10px] text-rv-danger">
                <AlertCircle size={10} className="mt-px flex-shrink-0" />
                {t("featureFlags.new.keyStatus.taken", { env })}
              </span>
            ) : keyStatus === "invalid" ? (
              <span className="mt-1 inline-flex items-start gap-1 font-rv-mono text-[10px] text-rv-danger">
                <AlertCircle size={10} className="mt-px flex-shrink-0" />
                {t("featureFlags.new.keyStatus.invalid")}
              </span>
            ) : null}
```

Note: `env` is the lowercase UI value (`"prod" | "staging" | "development"`), interpolated directly into the message. No separate env-label i18n lookup is needed.

- [ ] **Step 5: Gate submit on the live status**

Find the existing line (`flag-form.tsx:329`):

```tsx
  const submitDisabled = pending || !defaultValid || !rulesValid;
```

Replace with:

```tsx
  const keyBlocksSubmit = !isEdit && keyStatus !== "available";
  const submitDisabled =
    pending || !defaultValid || !rulesValid || keyBlocksSubmit;
```

This blocks submit while the key is empty, invalid, taken, or mid-debounce-from-empty. (In edit mode `keyBlocksSubmit` is always false, preserving current behavior.)

- [ ] **Step 6: Typecheck and run the dashboard test suite**

Run: `pnpm --filter @rovenue/dashboard exec tsc -b --noEmit`
Expected: no errors.

Run: `pnpm --filter @rovenue/dashboard test`
Expected: PASS, including Task 1 and Task 2 suites; no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/feature-flags/flag-form.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/remote-config): live duplicate-ID check on new-flag key input"
```

---

## Verification (whole feature)

- [ ] `pnpm --filter @rovenue/dashboard test` — all green.
- [ ] `pnpm --filter @rovenue/dashboard exec tsc -b --noEmit` — clean.
- [ ] Manual smoke (optional): open Remote Config → New flag. Type an existing key for the selected env → ✗ "already used"; submit disabled. Switch env to one where the key is free → ✓ Available; submit enabled. Type `bad key` → invalid message. Confirm the edit screen still shows the locked-key hint and no status indicator.

## Spec Coverage Map

- "Debounce ~400ms after typing" → Task 2 (`useDebouncedValue(key, 400)`), Task 3 Step 3.
- "Invalid format inline" → Task 1 `"invalid"` status + Task 3 Step 4 message.
- "Taken = same key in selected env" → Task 1 `"taken"` (case-sensitive exact) over `useFeatureFlags(projectId, UI_TO_DB_ENV[env])` keys (Task 3 Step 3).
- "Available indicator" → Task 1 `"available"` + Task 3 Step 4.
- "Empty/mid-debounce neutral" → Task 1 `"empty"` + `keyChecking` (Task 3 Step 3/4).
- "Env switch re-runs check" → `useFeatureFlags` keyed by env + `existingKeys`/`keyStatus` memo deps (Task 3 Step 3); unit-covered by the empty-list case in Task 1.
- "Submit gating" → Task 3 Step 5.
- "DB constraint backstop / surface API error as today" → unchanged `handleSubmit` catch block (no edit to error path).
- "Edit mode unaffected" → `isEdit` short-circuits status + `keyBlocksSubmit` (Task 3 Steps 3/5).
- "No backend/schema/shared changes" → file list is dashboard-only.
