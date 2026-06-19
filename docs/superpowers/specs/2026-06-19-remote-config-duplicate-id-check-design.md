# Remote Config — Live Duplicate-ID Check on Key Input

**Date:** 2026-06-19
**Status:** Approved (design)
**Scope:** Dashboard only — `apps/dashboard/src/components/feature-flags/flag-form.tsx`

## Context

"Remote Config" is the user-facing label for the **feature-flags** feature
(`apps/dashboard/src/i18n/locales/en.json`: `featureFlags` → "Remote Config").
The "ID" referenced in the requirement is the flag **key**.

Today, in the new-flag form (`flag-form.tsx`):

- The `key` field is free text.
- It is validated **only on submit**: non-empty + `^[a-z0-9_-]+$` (case-insensitive).
- Duplicate keys are only caught when the API rejects the create against the DB
  unique index `feature_flags_projectId_env_key_key` on `(projectId, env, key)`.
- There is no inline feedback while the user types.

Because uniqueness is scoped to `(projectId, env, key)`, the **same key is allowed
in different environments** (PROD / STAGING / DEVELOPMENT).

## Requirement

When the user finishes typing the ID:

1. Do not allow a duplicate ID.
2. Run the check inline on that input.

## Design

### Behavior

- Debounce **~400ms** after the user stops typing the key. Then evaluate the key
  and render an inline status directly under the key field:
  - **Invalid format** — fails `^[a-z0-9_-]+$` → show the existing `errors.invalidKey`
    message inline (today it only appears on submit).
  - **Taken** — key already exists in the *currently selected environment* →
    ✗ "This ID is already used in {env}".
  - **Available** — non-empty, valid format, and unique → ✓ "Available".
  - **Empty / mid-debounce** — neutral, no message.
- **Scope:** a duplicate is an **exact key match within the selected env**, mirroring
  the `(projectId, env, key)` unique index. Switching the env re-runs the check, since
  the same key may be free in another env.
- **Case sensitivity:** case-sensitive exact match. The Postgres unique index is
  case-sensitive, so `"Foo"` and `"foo"` are distinct keys; the client check must
  match that to avoid false positives.
- **Whitespace:** compare against the trimmed key.

### Submit gating

- Extend the existing `submitDisabled` so submit is disabled when the key is **empty,
  invalid format, or taken**.
- The DB unique constraint remains the authoritative backstop. If a concurrent create
  races through after the client check passes, the API error is surfaced exactly as it
  is today (no regression).

### Data source

- Reuse `useFeatureFlags(projectId, UI_TO_DB_ENV[env])` to load the env-scoped flag
  list. `listFeatureFlags` returns the full set (no pagination, ordered by key), so the
  client-side check is complete and reliable.
- Compare the trimmed typed key against the existing keys in that list via `useMemo`.
- **No new API endpoint** and **no per-keystroke network calls** — the list is already
  cached by React Query and keyed by `["feature-flags", projectId, env]`.

### Edit mode

- No change. Edit mode already locks the key field (`disabled={isEdit}`), so the check
  applies to **create mode only**.

## Implementation Notes

- Add a small debounce: a `useDebouncedValue(key, 400)` hook (or an inline
  `useEffect` + timer) feeding the comparison.
- Derive key status (`empty | invalid | checking | available | taken`) via `useMemo`
  over the debounced key, the selected env, and the env-scoped flag list.
- New i18n keys under `featureFlags.new` (e.g. `keyStatus.available`,
  `keyStatus.taken`, `keyStatus.checking`), and surface `errors.invalidKey` inline.
- No backend, schema, repository, or shared-types changes.

## Out of Scope

- Experiments and other features that also carry IDs (the requirement is specific to
  Remote Config / feature flags).
- Any change to the DB uniqueness scope or to the create API.
- Server-side availability endpoints.

## Testing

- Component test for `flag-form` (create mode) covering the status transitions:
  - empty → neutral
  - valid + unique → available + submit enabled
  - duplicate in selected env → taken + submit disabled
  - invalid characters → invalid + submit disabled
  - env switch frees/blocks the same key (same key taken in PROD, available in STAGING)
- Confirm edit mode is unaffected (key field stays locked, no check).
