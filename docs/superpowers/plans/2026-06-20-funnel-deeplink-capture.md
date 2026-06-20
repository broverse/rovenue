# Deep-link Token Capture (Sub-project D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Rovenue.claimFromUrl(url)` extracts a funnel token from a Universal Link / deep link and claims it; non-funnel URLs resolve `null`.

**Architecture:** Pure TypeScript in `packages/sdk-rn/src/api/funnel.ts`: a tested `extractFunnelToken(url)` parser (no `URL` constructor) + a thin `claimFromUrl` wrapper that reuses the existing `call()`/`parse()`/native `claimFunnelToken` from A. No native code, no backend change — fully unit tested.

**Tech Stack:** TypeScript (sdk-rn/src, Vitest).

## Global Constraints

- Stay on the current git branch (main); never switch/create branches/worktrees; commit on current HEAD.
- Conventional commits.
- No native code, no backend change, no new `RovenueModuleSpec` method (reuses `claimFunnelToken` from A).
- The parser does NOT use the `URL` constructor (unreliable for custom schemes in RN/Hermes) — robust string parsing.
- `claimFromUrl` must be safe to call with ANY incoming URL: non-funnel URLs resolve `null` and never throw. Recognized token shapes: the `funnels/open/<token>` path (anywhere); `rovenue_funnel_token=` query (anywhere); `token=` query ONLY when the URL contains `onboarding-complete` (the Rovenue funnel deep-link host).
- Reuse the existing `funnel.ts` helpers: `call()`, `parse()`, `NativeClaim`, `getNative()`.

---

### Task 1: `extractFunnelToken` + `claimFromUrl` + tests + wiring

**Files:**
- Modify: `packages/sdk-rn/src/api/funnel.ts`
- Modify: `packages/sdk-rn/src/index.ts`
- Test: `packages/sdk-rn/src/api/funnel.test.ts`

**Interfaces:**
- Consumes (existing in funnel.ts): `call()`, `parse()`, `NativeClaim`, `getNative()`, `FunnelClaimResult`.
- Produces: `extractFunnelToken(url: string): string | null` (named export) and `claimFromUrl(url: string): Promise<FunnelClaimResult | null>`, added to the `Rovenue` object.

- [ ] **Step 1: Write the failing tests**

In `packages/sdk-rn/src/api/funnel.test.ts`, add a new `describe` block (the `claimFunnelToken` mock fn already exists in the `vi.mock("../core/native", ...)` factory from A — reuse it; add `import { extractFunnelToken, claimFromUrl } from "./funnel"`):

```typescript
describe("extractFunnelToken", () => {
  const TOK = "a".repeat(48); // 40-64 char funnel token
  it("extracts from a Universal Link path", () => {
    expect(extractFunnelToken(`https://links.acme.com/universal/funnels/open/${TOK}`)).toBe(TOK);
  });
  it("extracts from a path with trailing query/fragment", () => {
    expect(extractFunnelToken(`https://d/universal/funnels/open/${TOK}?x=1#y`)).toBe(TOK);
  });
  it("stops the path token at the next '/' (real funnel tokens have no slash)", () => {
    expect(extractFunnelToken(`https://d/universal/funnels/open/${TOK}/extra`)).toBe(TOK);
  });
  it("extracts from the funnel deep-link query (token= on onboarding-complete)", () => {
    expect(extractFunnelToken(`myapp://onboarding-complete?token=${TOK}`)).toBe(TOK);
  });
  it("extracts rovenue_funnel_token= anywhere", () => {
    expect(extractFunnelToken(`myapp://whatever?rovenue_funnel_token=${TOK}`)).toBe(TOK);
  });
  it("ignores a generic token= on a non-funnel host", () => {
    expect(extractFunnelToken(`myapp://reset-password?token=${TOK}`)).toBeNull();
  });
  it("returns null for a non-funnel URL", () => {
    expect(extractFunnelToken("https://example.com/page?x=1")).toBeNull();
  });
  it("returns null for empty/garbage", () => {
    expect(extractFunnelToken("")).toBeNull();
    expect(extractFunnelToken("not a url")).toBeNull();
  });
});

describe("claimFromUrl", () => {
  const TOK = "b".repeat(48);
  beforeEach(() => claimFunnelToken.mockReset());
  it("claims when the URL carries a token", async () => {
    claimFunnelToken.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: '{"q":1}' });
    const r = await claimFromUrl(`https://d/universal/funnels/open/${TOK}`);
    expect(claimFunnelToken).toHaveBeenCalledWith(TOK);
    expect(r).toEqual({ subscriberId: "s", funnelAnswers: { q: 1 } });
  });
  it("resolves null and does NOT touch native for a non-funnel URL", async () => {
    const r = await claimFromUrl("https://example.com/page");
    expect(r).toBeNull();
    expect(claimFunnelToken).not.toHaveBeenCalled();
  });
});
```

(Confirm `claimFunnelToken` is the mock fn name used by the existing funnel.test.ts mock factory; if it's referenced differently, match it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: FAIL — `extractFunnelToken`/`claimFromUrl` are not exported.

- [ ] **Step 3: Implement the parser + wrapper**

In `packages/sdk-rn/src/api/funnel.ts`, add (after the existing `parse()` helper / near the other exports):

```typescript
function safeDecode(s: string): string {
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Extract a funnel token from a deep link / Universal Link. Recognises:
 *  - Universal Link path: `…/funnels/open/<token>`
 *  - `rovenue_funnel_token=<token>` query (anywhere — Rovenue-specific key)
 *  - `token=<token>` query ONLY on the funnel deep-link host
 *    (`…onboarding-complete…`) so an unrelated deep link's generic `token=` is
 *    not mistaken for a funnel token.
 * Returns null for any non-funnel URL. Does not use the `URL` constructor
 * (unreliable for custom schemes in RN/Hermes).
 */
export function extractFunnelToken(url: string): string | null {
  if (!url) return null;

  // 1) Universal-link path: the segment after "funnels/open/".
  const marker = "funnels/open/";
  const mi = url.indexOf(marker);
  if (mi !== -1) {
    const rest = url.slice(mi + marker.length);
    const seg = rest.split(/[/?#]/)[0];
    const tok = safeDecode(seg);
    if (tok) return tok;
  }

  // 2) Query parameters.
  const qi = url.indexOf("?");
  if (qi !== -1) {
    const query = url.slice(qi + 1).split("#")[0];
    let generic: string | null = null;
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.slice(0, eq);
      const val = safeDecode(pair.slice(eq + 1));
      if (!val) continue;
      if (key === "rovenue_funnel_token") return val; // Rovenue-specific → trust anywhere
      if (key === "token") generic = val;
    }
    // generic `token=` only on the Rovenue funnel deep-link host.
    if (generic && url.includes("onboarding-complete")) return generic;
  }

  return null;
}

/**
 * Claim a funnel token carried by a deep link / Universal Link. Forward every
 * incoming URL here from your app's Linking handler; non-funnel URLs resolve
 * `null` without a network call. A recognized-but-invalid token surfaces the
 * usual claim error via the returned promise.
 */
export async function claimFromUrl(url: string): Promise<FunnelClaimResult | null> {
  const token = extractFunnelToken(url);
  if (!token) return null;
  return call(async () => parse(await getNative().claimFunnelToken(token)));
}
```

- [ ] **Step 4: Wire the public surface**

In `packages/sdk-rn/src/index.ts`:
- Add `claimFromUrl` and `extractFunnelToken` to the existing funnel import (line ~92):
```typescript
import { claimFunnelToken, claimInstall, claimViaEmail, installId, addFunnelClaimListener, claimFromClipboard, claimFromUrl, extractFunnelToken } from "./api/funnel";
```
- Add `claimFromUrl` to the `Rovenue` object (near `claimFromClipboard`):
```typescript
  claimFromUrl,
```
- Export `extractFunnelToken` as a named export (advanced callers / sub-project E). Add to the exports near the bottom:
```typescript
export { extractFunnelToken } from "./api/funnel";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test && pnpm build && pnpm test`
Expected: the new tests PASS; tsc=0; full suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn/src/api/funnel.ts packages/sdk-rn/src/api/funnel.test.ts packages/sdk-rn/src/index.ts
git commit -m "feat(sdk-rn): add Rovenue.claimFromUrl() + extractFunnelToken for deep-link capture"
```

---

### Task 2: Version bump + docs

**Files:**
- Modify: `Cargo.toml`, `packages/sdk-rn/src/version.ts`, `packages/sdk-rn/package.json` (lockstep)
- Modify: `apps/docs/content/docs/reference/methods.mdx`

- [ ] **Step 1: Bump all three versions in lockstep**

Confirm all three are equal (e.g. `0.12.0`), then bump each by one minor to the next (e.g. `0.13.0`): workspace `Cargo.toml` `[workspace.package]` version, `packages/sdk-rn/src/version.ts` `SDK_VERSION`, `packages/sdk-rn/package.json` `version`. All three MUST end identical.

- [ ] **Step 2: Document `claimFromUrl`**

In `apps/docs/content/docs/reference/methods.mdx`, in the `## Funnel Attribution` section, add a `### claimFromUrl` entry mirroring the existing per-method format:
- Use when the app is opened via a funnel Universal Link / App Link / deep link.
- Returns `FunnelClaimResult | null` (null for non-funnel URLs — safe to call with any URL).
- Wire the app's deep-link handler (RN example):
```ts
import * as Linking from 'expo-linking';
// warm:
Linking.addEventListener('url', ({ url }) => { Rovenue.claimFromUrl(url); });
// cold start via link:
const initial = await Linking.getInitialURL();
if (initial) await Rovenue.claimFromUrl(initial);
```
- Note the app-side OS config (iOS Associated Domains for the funnel domain; Android App Links intent filter; the custom scheme) — these live in the consuming app, not the SDK.
- Recognized URL shapes: `…/funnels/open/<token>`, `?rovenue_funnel_token=…`, and `?token=…` on the `onboarding-complete` deep link.
Add `claimFromUrl` to the Funnel Attribution method-summary table if one exists. Keep the deterministic/no-fingerprinting framing intact.

- [ ] **Step 3: Verify**

Run: `cargo build -p librovenue && cd packages/sdk-rn && pnpm test`
Expected: crate builds at the new version; sdk-rn tests pass including `version.test.ts` parity at the new version. `pnpm --filter @rovenue/docs build` may fail only on the known pre-existing SSR home-page crash — confirm it's that, not your MDX.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock packages/sdk-rn/src/version.ts packages/sdk-rn/package.json apps/docs/content/docs/reference/methods.mdx
git commit -m "chore(sdk): bump versions + document claimFromUrl deep-link capture"
```

---

## Self-Review

**Spec coverage:**
- §4 `claimFromUrl(url)` → Task 1. §5.1 `extractFunnelToken` (path + rovenue_funnel_token anywhere + token= gated on onboarding-complete) → Task 1 Step 3. §5.2 wrapper reusing call/parse/claimFunnelToken → Task 1. §5.3 public surface (Rovenue object + extractFunnelToken named export, no spec change) → Task 1 Step 4. §6 docs → Task 2. §7 testing (extractFunnelToken cases + claimFromUrl) → Task 1 Step 1. §8 versioning → Task 2.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; the test cases cover each URL shape + non-funnel + garbage.

**Type consistency:** `extractFunnelToken(string) → string | null` and `claimFromUrl(string) → Promise<FunnelClaimResult | null>` consistent across funnel.ts, index.ts, and tests. `claimFromUrl` reuses `call()`/`parse()`/`getNative().claimFunnelToken` exactly as `claimFunnelToken` (from A) does. No native/spec change.
