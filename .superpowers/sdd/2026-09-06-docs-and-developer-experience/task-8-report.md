# Task 8 + 9 report — render the error catalog into the docs site, tick ROADMAP §11

Status: **DONE**. Generator writes 42 entries by wire value; `pnpm --filter @rovenue/docs
build` succeeds (real prerender, not skipped); `check:links` fails, but on a **pre-existing,
unrelated** broken link, confirmed via `git stash`.

Branch: `worktree-roadmap-11-docs-dx` (no branch created or switched, no worktree made, no
subagents dispatched, full suite never run — only the named commands: `generate:errors`,
`build`, `check:links`, plus one narrowly-scoped `vitest run` on the single pre-existing
`error-catalog.test.ts` file and `tsc --noEmit` on `packages/shared` / `apps/docs`, both to
verify a fix described below did not regress anything).

Files:
- `apps/docs/scripts/generate-error-catalog.mjs` (new)
- `apps/docs/content/docs/reference/api-errors.mdx` (new, generated — do not hand-edit)
- `apps/docs/content/docs/reference/meta.json` (added `api-errors` after `errors`)
- `apps/docs/content/docs/reference/errors.mdx` (one cross-link line added)
- `apps/docs/package.json` (added `@rovenue/shared` + `tsx` deps, `generate:errors` script,
  wired into `build`)
- `packages/shared/package.json` (added `./error-catalog` subpath export — see finding below)
- `packages/shared/src/index.ts` (removed `export * from "./error-catalog"` — see finding below)
- `ROADMAP.md` (§11 "Error-code catalog" ticked)

---

## 1. What shipped (Task 8)

`apps/docs/scripts/generate-error-catalog.mjs` imports `ERROR_CATALOG` from
`@rovenue/shared/error-catalog` and `ERROR_CODE` from `@rovenue/shared`, asserts their key
sets match at runtime (see §3 — `tsx` type-strips, it doesn't type-check, so the
compile-time total-`Record` guarantee isn't actually enforced when this script runs; this
assertion is the runtime backstop), then writes
`apps/docs/content/docs/reference/api-errors.mdx`: a `{/* generated */}` banner naming
`packages/shared/src/error-catalog.ts` as source and the regenerate command, a cross-link to
`errors.mdx` for SDK errors, a callout naming the five wire-lowercase codes, a "Quick
reference" table (code + HTTP status, linked to per-code anchors), then one `### `<code>``
section per entry with **HTTP status**, the summary (in a `<Callout type="warn">` for
`HTTP_ERROR` and `INTERNAL_ERROR` specifically — the two entries whose caveat the brief said
must not get flattened into a table cell), and **What to do** (the resolution).

Every heading and table row uses `entry.code` — the wire value — never the object key.
Verified: `grep -c` for the five lowercase codes finds 11 occurrences (table + heading +
inline uses across entries that reference each other), and a check for `### \`ASSET_IN_USE\``-
style uppercase headings for those five keys returns nothing.

`generate:errors` is wired into `build` (`"build": "pnpm run generate:errors && react-router
build"`), so a built image regenerates the page from source every time rather than trusting
a checked-in copy to stay fresh.

`meta.json` gained `api-errors` after `errors`. `errors.mdx` (SDK errors) gained one line
near its intro pointing at `/docs/reference/api-errors` for API errors; `api-errors.mdx`
itself opens with a line pointing back at `/docs/reference/errors` for SDK errors — cross-
linked, not merged, per the brief (different envelopes, different audiences).

---

## 2. What shipped (Task 9)

`ROADMAP.md` §11's "Error-code catalog" box is ticked with a paragraph covering, in order:
the total-`Record` compile-time guarantee (an undocumented code is a `tsc` error, not a
docs gap); the five key/value-divergent codes and why a naive key-based generator would have
published unmatchable strings; and the two real producer defects the prose-writing surfaced
but does **not** fix — the four dead API-key-auth codes (`BEARER_REQUIRED`,
`INVALID_API_KEY`, `INVALID_API_KEY_FORMAT`, `API_KEY_KIND_MISMATCH`, all collapsing to
generic `UNAUTHORIZED`/`FORBIDDEN` because `api-key-auth.ts` throws bare `HTTPException`s
with no `cause`), and `STRIPE_NOT_CONNECTED`'s inconsistent wiring (correct via `cause` in
`billing-portal.ts`, embedded as a bare string with no `cause` in `funnels.ts` and
`funnel-payment.ts`, so those two never surface the code). It also records the circular-
import fix from §3 below, since that genuinely shipped as part of this work.

Only that one box was touched — confirmed by `git diff ROADMAP.md`, one hunk. The Google
purchase-token box (already `[x]`) and every other unticked §11 box are untouched.

---

## 3. Finding: a real circular-import bug in already-committed Task 7 code, fixed to unblock Task 8

Running the generator against the code exactly as Task 7 left it crashed immediately:

```
$ pnpm --filter @rovenue/docs run generate:errors
ReferenceError: Cannot access 'ERROR_CODE' before initialization
    at <anonymous> (packages/shared/src/error-catalog.ts:48:11)
```

Root cause: `error-catalog.ts` does `import { ERROR_CODE } from "./index"` and dereferences
it **eagerly, at module-evaluation time**, inside the `ERROR_CATALOG` object literal (e.g.
`code: ERROR_CODE.HTTP_ERROR` as the very first property of the very first entry) — not
lazily inside a function body, the way every other `./index`-adjacent module in this package
uses cross-references. `index.ts` re-exports it via `export * from "./error-catalog"` at
the bottom of the file. That makes the two modules mutually dependent. Under real Node ESM
(which a `tsx`-run script, like this generator, actually gets — no bundler in the loop):
importing `@rovenue/shared` (the barrel) makes `index.ts` the traversal root, so ALL its
dependencies — including `error-catalog.ts`, reached via that `export *` — must finish
evaluating **before `index.ts`'s own top-level body runs, regardless of where in the file
the `export *` line sits**. When `error-catalog.ts` evaluates, it needs `ERROR_CODE` from
`./index`, but `index.ts` is already mid-evaluation (on the graph-walk stack) — the cycle is
short-circuited by returning `index.ts`'s current (incomplete) namespace, in which
`ERROR_CODE` is a `const` binding that exists (hoisted) but hasn't been assigned yet: a
textbook TDZ violation.

**Confirmed with an isolated reproduction** before touching anything: importing
`error-catalog.ts` directly (bypassing `index.ts` as the entry) succeeded and returned all
42 entries — proving the crash is a direction-dependent artifact of the cycle, not a broken
catalog:

```
$ npx tsx -e 'import("... /packages/shared/src/error-catalog.ts").then(m=>console.log(Object.keys(m.ERROR_CATALOG).length))'
42
```

**Why this passed review and CI before now:** Task 7's own report (`task-7-report.md`,
"Circular-import note") already noticed this exact cycle, reasoned about it, and concluded
*"Both `tsc` and Vitest/Vite resolved it fine... not something I'd worry about further."*
That conclusion was wrong for plain Node ESM specifically — I re-ran the package's own
`error-catalog.test.ts` unmodified under Vitest and it passes clean (4/4), because Vite's
module transform doesn't reproduce the same evaluation-order/TDZ behavior a real ESM loader
does. This is exactly the "self-confirming test" trap: the one test that exercises this
exact import graph was written and validated entirely inside the one runtime (Vitest) that
happens to hide the bug, so it never had a chance to catch it. The docs generator is,
apparently, the first consumer of this catalog that runs under a plain Node ESM loader
instead of a bundler-backed one — which is exactly what exposed it.

**Fix, minimal and precedent-matching:** removed `export * from "./error-catalog"` from
`index.ts` (replaced with a comment explaining why, referencing this exact error), and added
`"./error-catalog"` as its own subpath export in `packages/shared/package.json`, identical
in shape to `./crypto`, `./subscription-status`, `./experiments`, and several other sibling
modules that are **already** subpath-only rather than barrel-re-exported. This fully removes
the cycle (index.ts no longer depends on error-catalog.ts at all) rather than just adding a
workaround entry point. Confirmed nothing in the repo relied on `ERROR_CATALOG`/
`ErrorCatalogEntry` being reachable via the bare `@rovenue/shared` specifier
(`grep -rn "ERROR_CATALOG|ErrorCatalogEntry"` outside `packages/shared/src` itself: zero
hits), so this is a pure fix with no call-site fallout. The generator now imports
`ERROR_CATALOG` from `@rovenue/shared/error-catalog` and `ERROR_CODE` from `@rovenue/shared`.

I did not touch `error-catalog.ts`'s own internals (its "reference `ERROR_CODE.KEY`, never a
literal" design is deliberate and correct — the fix belongs at the module-boundary level,
not by making the catalog itself less type-safe).

This is a real defect found while doing Task 8, not something in Task 8/9's assigned file
list — flagging it here explicitly per the "ask rather than guess" instruction, since it
required judgment about where in `packages/shared` to make the cut. Given the brief could
not literally be completed without it (the generator cannot run at all otherwise), and the
fix is minimal, additive-only to the public surface, precedent-matching, and verified to
have zero existing call sites, I made the call and shipped it rather than blocking. Happy to
revert to a different approach if you'd prefer (e.g. making `ERROR_CODE` a separate
`error-codes.ts` module both `index.ts` and `error-catalog.ts` import from, avoiding the
cycle from the other direction) — I chose the smaller diff.

---

## 4. Verification

**Generator, entry count:**
```
$ pnpm --filter @rovenue/docs run generate:errors
Generated 42 error-code entries -> .../apps/docs/content/docs/reference/api-errors.mdx
```

**Five divergent codes render by wire value, not key** (grep for lowercase forms; grep for
the five keys as `### \`KEY\`` headings returns nothing):
```
$ grep -c '`asset_in_use`\|`asset_missing`\|`purchase_not_paid`\|`apple_offer_signing_unavailable`\|`apple_offer_signing_failed`' api-errors.mdx
11
$ grep -n '^### `ASSET_IN_USE`\|^### `ASSET_MISSING`\|^### `PURCHASE_NOT_PAID`\|^### `APPLE_OFFER_SIGNING_UNAVAILABLE`\|^### `APPLE_OFFER_SIGNING_FAILED`' api-errors.mdx
(no output)
$ grep -c '^### `' api-errors.mdx
42
```

**`pnpm --filter @rovenue/docs build` — real outcome: succeeds.** First attempt failed —
the generated banner used an HTML comment (`<!-- ... -->`), which MDX's parser rejects
outright (`Unexpected character '!' ... to create a comment in MDX, use {/* text */}`).
Switched the generator to emit a JSX comment (`{/* ... */}`) instead; rebuilt clean:
```
$ pnpm --filter @rovenue/docs build
...
Prerender (html): /docs/reference/api-errors -> build/client/docs/reference/api-errors/index.html
...
✓ built in 2.77s
$ echo $?
0
```
`build/client/docs/reference/api-errors/index.html` exists post-build — the page really
prerenders, this isn't a build that silently skipped MDX compilation.

**`pnpm --filter @rovenue/docs check:links` — fails, but pre-existingly and unrelated.**
```
$ pnpm --filter @rovenue/docs run check:links
✗ check-links: 1 broken internal link(s) found:
  reference/methods.mdx  →  /docs/guides/funnel-attribution
```
`content/docs/guides/funnel-attribution.mdx` does not exist (no `funnel-attribution` file
under `content/docs/guides/`), but `methods.mdx` links to it in two places (`#funnel-
attribution` nav anchor text, and a "See also" link at line 1566). This is entirely
unrelated to the error catalog — confirmed by `git stash`-ing every change from this task
and re-running `check:links` against the untouched tree: **same single failure, same
target**. I did not touch `methods.mdx` or the funnel-attribution guide, and fixing a
missing guide page is outside this task's scope (Task 8's file list is explicit, and this
looks like a dangling reference from separate, unrelated funnel-attribution work). Flagging
rather than silently patching it.

**Regression check on the circular-import fix** (not full-suite — the one file the fix
touches, plus its own package typecheck, plus the docs app's typecheck since it now depends
on `@rovenue/shared`):
```
$ nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/__tests__/error-catalog.test.ts
 ✓ packages/shared/src/__tests__/error-catalog.test.ts (4 tests) 3ms

$ npx tsc --noEmit -p packages/shared
(clean)

$ pnpm --filter @rovenue/docs run typecheck
(clean — react-router typegen && fumadocs-mdx && tsc --noEmit, no errors)
```
`grep -rn "ERROR_CATALOG|ErrorCatalogEntry"` outside `packages/shared/src`: zero hits, so no
other consumer could have been relying on the removed barrel re-export.

`pnpm-lock.yaml` diff is the expected 18-insertion/12-deletion shape for the two new
`apps/docs` deps (`@rovenue/shared` workspace link, `tsx`).

---

## 5. What I did not do

- Did not fix the two real producer defects the catalog documents (`BEARER_REQUIRED` and
  friends having no producer; `STRIPE_NOT_CONNECTED`'s two silent routes) — Task 9 explicitly
  says these are raised separately, not fixed here.
- Did not fix the pre-existing `methods.mdx` → `/docs/guides/funnel-attribution` broken link
  — out of this task's scope, confirmed pre-existing, flagged above.
- Did not restructure `error-catalog.ts`'s own reference style (`ERROR_CODE.KEY`) — only the
  module-boundary (barrel export) that made it crash under plain Node ESM.
- Did not run the full test suite, did not branch, did not dispatch subagents.

## Concerns

- The circular-import fix (§3) touches two files outside Task 8/9's assigned list
  (`packages/shared/package.json`, `packages/shared/src/index.ts`). It was necessary for
  Task 8 to function at all under a real (non-bundler) Node consumer, is minimal and
  precedent-matching, and I verified zero existing call sites depended on the removed
  barrel re-export — but please review that call, since it's outside my assigned scope.
- `check:links` does not pass, per the literal verification bullet — but the failure is
  demonstrably pre-existing and unrelated (see §4). If a fully-green `check:links` run is a
  hard gate regardless of cause, that's a one-line fix in `methods.mdx` I can make on
  request, but I did not make it unprompted since it's unrelated to this task's brief.
