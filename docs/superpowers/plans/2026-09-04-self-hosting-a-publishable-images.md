# Self-hosting A — Publishable Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rovenue's container images publishable and pullable — a dashboard that learns its API origin at runtime, Apple's trust anchors baked in, and a signed, scanned, multi-arch release to GHCR.

**Architecture:** The dashboard's four `VITE_*` values move from Vite build-time inlining to a `window.__ROVENUE_CONFIG__` object served by the image's own Caddy from environment placeholders, resolved through one module. Apple root CAs are vendored into the repo and copied into the api image. A tagged release workflow builds four images on native amd64/arm64 runners, scans and signs them, and pushes a joined manifest to `ghcr.io/broverse/`.

**Tech Stack:** Vite 6 / React 19 / TypeScript strict, Vitest (jsdom), Caddy 2, Docker Buildx, GitHub Actions, cosign, trivy, Postgres/Drizzle (for the migration guard).

**Spec:** `docs/superpowers/specs/2026-09-04-self-hosting-packaging-design.md`

**Plan set:** This is plan **A** of three. **B** (Coolify template + Helm chart) and **C** (upgrade runbook, backup/restore, asset-header verifier) follow. B depends on A. C is independent of both.

## Global Constraints

- **Never switch or create git branches.** Work on the current branch. Do not create worktrees.
- **Throttle test runs.** The machine strains under full-suite parallelism. Use `nice -n 19 npx vitest run --maxWorkers=2` for vitest and `--concurrency=2` for turbo builds. Run test files individually where the task names one; never launch a full-repo suite as a side check.
- **No magic values.** Hoist literals into named constants — image names, registry host, default URLs, env var names, header names, exit codes. Structured data tables (the image matrix, the grandfathered-migration list) are data, not magic values.
- **No self-confirming tests.** A test that asserts a hand-built object has the property you just set proves nothing. Shell scripts are exercised by running them; the certificate test parses the real committed bytes.
- **Additive only.** `VITE_*` build args stay in `apps/dashboard/Dockerfile` and `docker-compose.yml`. The `deploy/apple-certs` bind mount stays. `docker-compose.yml` continues to build from source. Nothing in this plan may break `docker compose up` or `pnpm dev`.
- **TypeScript strict.** Shell scripts run under `set -euo pipefail` and must be `shellcheck`-clean.
- **Conventional commits.** Commit at the end of every task, exactly as written in the task's final step.
- Registry is `ghcr.io/broverse`. Image names: `rovenue-api`, `rovenue-dashboard`, `rovenue-docs`, `rovenue-postgres`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/dashboard/src/lib/runtime-config.ts` (create) | The **only** module that reads `import.meta.env.VITE_*` or `window.__ROVENUE_CONFIG__`. Exports four resolved accessors and one pure resolver. |
| `apps/dashboard/src/lib/runtime-config.test.ts` (create) | Precedence, empty-string-as-absent, and default behaviour of the pure resolver. |
| `apps/dashboard/src/lib/host-mode.ts`, `custom-host.ts` (modify) | Keep their pure `compute*` functions; their env objects are now fed from `runtime-config`. |
| `apps/dashboard/public/config.js` (create) | Dev-only empty placeholder so `pnpm dev` gets a 200. |
| `apps/dashboard/index.html` (modify) | Loads `/config.js` before the module bundle. |
| `deploy/caddy/Caddyfile.dashboard` (modify) | Serves `/config.js` from env placeholders; all routing moved into explicit `handle` blocks. |
| `deploy/dashboard/entrypoint.sh` (create) | Validates the four runtime values, then `exec caddy run`. Fails loudly on a bad value. |
| `apps/dashboard/tests/entrypoint.test.ts` (create) | Runs the real script in validate-only mode against good and bad inputs. |
| `deploy/apple-certs/*.cer` (create) | Vendored Apple root CAs. |
| `apps/api/tests/apple-certs.test.ts` (create) | Parses the committed bytes; asserts issuer and non-expiry. |
| `packages/db/src/migration-policy.test.ts` (create) | Fails a new migration containing destructive DDL without an explicit contract marker. |
| `.github/CONTRIBUTING.md` (modify) | The expand/contract policy the guard enforces. |
| `.github/workflows/release-images.yml` (create) | Multi-arch build, scan, sign, push, manifest. |
| `eslint.config.mjs` (modify) | Forbids `import.meta.env.VITE_*` outside `runtime-config.ts`. |

---

### Task 1: Expand/contract migration policy, with a guard

Ordered first because it constrains what every later migration may contain. It has no dependency on anything else in this plan.

**Files:**
- Modify: `.github/CONTRIBUTING.md`
- Create: `packages/db/src/migration-policy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the marker comment `-- rovenue:contract-phase <reason>`, recognised by the guard test. Later plans reference this policy from `docs/operations/upgrade.md`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/migration-policy.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @rovenue/db is "type": "module", so __dirname does not exist here.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "drizzle", "migrations");

/**
 * Destructive DDL breaks the old image mid-rollout: `pre-upgrade`
 * migrations run before the new pods, so during a rolling update the
 * OLD code is serving against the NEW schema. See CONTRIBUTING.md
 * "Expand/contract schema changes".
 */
const DESTRUCTIVE_DDL = /\bDROP\s+COLUMN\b|\bDROP\s+TABLE\b|\bRENAME\s+COLUMN\b|\bSET\s+NOT\s+NULL\b/i;

/** Opt-out marker an author writes when the drop IS the contract step. */
const CONTRACT_MARKER = "-- rovenue:contract-phase";

/**
 * Migrations that predate the policy. This list is FROZEN — never add to
 * it. A new migration needing destructive DDL carries CONTRACT_MARKER
 * instead, which is a reviewable decision rather than a silent append.
 */
const GRANDFATHERED = new Set<string>([
  "0012_drop_exposure_events.sql",
  "0015a_drop_revenue_events_legacy.sql",
  "0016a_drop_credit_ledger_legacy.sql",
  "0017a_drop_outgoing_webhooks_legacy.sql",
  "0030_drop_projects_slug.sql",
  "0051_funnel_partitions.sql",
  "0055_subscriber_access_accessid.sql",
  "0056_products_accessids.sql",
  "0069_damp_kingpin.sql",
  "0074_offerings_decouple_packages.sql",
  "0087_drop_stripe_credentials.sql",
  "0098_font_face_content_hash.sql",
]);

describe("migration policy", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  it("finds migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s has no unmarked destructive DDL", (file) => {
    if (GRANDFATHERED.has(file)) return;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (!DESTRUCTIVE_DDL.test(sql)) return;
    expect(
      sql.includes(CONTRACT_MARKER),
      `${file} contains destructive DDL. Schema changes are expand/contract ` +
        `(see .github/CONTRIBUTING.md). If this migration IS the contract ` +
        `step and no running version reads the dropped shape, add:\n` +
        `  ${CONTRACT_MARKER} <reason>`,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm the frozen list still matches the repo**

The twelve names above were read from the repo when this plan was written. If
migrations landed since, the list is stale — check before trusting it:

```bash
cd /Volumes/Development/rovenue
grep -ilE "DROP COLUMN|DROP TABLE|RENAME COLUMN|SET NOT NULL" \
  packages/db/drizzle/migrations/*.sql | xargs -n1 basename | sort
```

Expected: exactly the twelve names in `GRANDFATHERED`. Any extra name is a
migration written after this plan and **must not** be added to the list — give
it the `-- rovenue:contract-phase` marker instead, which is the reviewable
path the policy exists to create.

- [ ] **Step 3: Run the test to verify it passes**

```bash
nice -n 19 npx vitest run --maxWorkers=2 packages/db/src/migration-policy.test.ts
```

Expected: PASS.

- [ ] **Step 4: Prove the guard actually catches a new migration**

The test must fail for a *new* destructive migration, not merely pass on the frozen set — otherwise it is a test of the allowlist and nothing else.

```bash
cd /Volumes/Development/rovenue
echo 'ALTER TABLE "subscribers" DROP COLUMN "x";' > packages/db/drizzle/migrations/9999_guard_probe.sql
nice -n 19 npx vitest run --maxWorkers=2 packages/db/src/migration-policy.test.ts
```

Expected: FAIL naming `9999_guard_probe.sql` and printing the marker instructions. Then add the marker and confirm it passes:

```bash
printf -- '-- rovenue:contract-phase probe\nALTER TABLE "subscribers" DROP COLUMN "x";\n' \
  > packages/db/drizzle/migrations/9999_guard_probe.sql
nice -n 19 npx vitest run --maxWorkers=2 packages/db/src/migration-policy.test.ts
rm packages/db/drizzle/migrations/9999_guard_probe.sql
```

Expected: PASS, then the file is removed. **Do not commit the probe file.**

- [ ] **Step 5: Write the policy into CONTRIBUTING.md**

Append to `.github/CONTRIBUTING.md`:

```markdown
## Expand/contract schema changes

Migrations run **before** the new application version finishes rolling out —
`pre-upgrade` on Helm, `docker compose run migrate` before `up -d` on compose.
For the length of that rollout the **old image is still serving, against the
new schema**. A migration that drops or renames a column therefore breaks
every still-running old pod.

So schema changes land in three separate releases:

1. **Expand.** Add the new column or table, nullable or defaulted. Old and new
   code both work.
2. **Migrate.** New code writes both shapes and backfills the old rows.
3. **Contract.** Only once no running version reads the old shape, drop it.

`DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN` and `SET NOT NULL` may never
appear in the same release that introduces their replacement.
`packages/db/src/migration-policy.test.ts` enforces this. When a migration
genuinely *is* the contract step, say so in the file:

    -- rovenue:contract-phase drops subscribers.legacy_tier, unread since v1.4.0

A change that cannot be expressed this way is marked **downtime-required** in
its release notes, and the upgrade runbook's procedure for those is
scale-to-zero, migrate, scale-up.
```

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Development/rovenue
git add .github/CONTRIBUTING.md packages/db/src/migration-policy.test.ts
git commit -m "feat(db): enforce expand/contract schema changes

Migrations run before the new version finishes rolling out, so the old
image serves against the new schema for the length of the rollout. A
DROP COLUMN in the same release as its replacement breaks every
still-running old pod.

The 12 migrations predating the policy are grandfathered in a frozen
list; a new destructive migration must carry an explicit
-- rovenue:contract-phase marker.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `runtime-config.ts` and the thirteen call sites

**Files:**
- Create: `apps/dashboard/src/lib/runtime-config.ts`
- Create: `apps/dashboard/src/lib/runtime-config.test.ts`
- Modify: `apps/dashboard/src/lib/host-mode.ts`, `apps/dashboard/src/lib/host-mode.test.ts`
- Modify: `apps/dashboard/src/lib/custom-host.ts`, `apps/dashboard/src/lib/custom-host.test.ts`
- Modify (ten `VITE_API_URL` sites): `apps/dashboard/src/lib/api.ts:4-5`, `apps/dashboard/src/lib/auth.ts:4`, `apps/dashboard/src/runner/runner-api.ts:19`, `apps/dashboard/src/lib/hooks/useProjectIntegrations.ts:118`, `useSubscriberActions.ts:13`, `useExportMe.ts:4`, `useLiveEventsStream.ts:4`, `usePushDevices.ts:61`, `apps/dashboard/src/routes/unsubscribe.tsx:16`, `apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx:39`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveRuntimeConfig(runtime: RuntimeConfig | undefined, build: BuildEnv): ResolvedConfig`
  - `apiBaseUrl(): string`
  - `hostModeValue(): string | undefined`
  - `allowRegistrationValue(): string | undefined`
  - `dashboardHostValue(): string | undefined`
  - `DEFAULT_API_BASE_URL: "http://localhost:3000"`
  - Global `window.__ROVENUE_CONFIG__?: RuntimeConfig` with keys `apiUrl`, `hostMode`, `allowRegistration`, `dashboardHost` — Task 3's Caddyfile emits exactly these key names.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/lib/runtime-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_API_BASE_URL, resolveRuntimeConfig } from "./runtime-config";

describe("resolveRuntimeConfig", () => {
  it("prefers the runtime value over the build-time one", () => {
    const r = resolveRuntimeConfig(
      { apiUrl: "https://api.example.com" },
      { VITE_API_URL: "http://localhost:3000" },
    );
    expect(r.apiUrl).toBe("https://api.example.com");
  });

  it("falls back to the build-time value when runtime is absent", () => {
    const r = resolveRuntimeConfig(undefined, { VITE_API_URL: "https://built.example.com" });
    expect(r.apiUrl).toBe("https://built.example.com");
  });

  it("falls back to the default when neither is set", () => {
    const r = resolveRuntimeConfig(undefined, {});
    expect(r.apiUrl).toBe(DEFAULT_API_BASE_URL);
  });

  // The container emits `{$VAR:}` for unset variables, which arrives as "".
  // host-mode.ts distinguishes unset from empty, so "" must not shadow the
  // build-time value and must not be handed on as a set value.
  it("treats an empty runtime string as absent", () => {
    const r = resolveRuntimeConfig(
      { apiUrl: "", hostMode: "", allowRegistration: "", dashboardHost: "" },
      { VITE_API_URL: "https://built.example.com", VITE_HOST_MODE: "cloud" },
    );
    expect(r.apiUrl).toBe("https://built.example.com");
    expect(r.hostMode).toBe("cloud");
    expect(r.allowRegistration).toBeUndefined();
    expect(r.dashboardHost).toBeUndefined();
  });

  it("leaves optional values undefined when nothing supplies them", () => {
    const r = resolveRuntimeConfig(undefined, {});
    expect(r.hostMode).toBeUndefined();
    expect(r.allowRegistration).toBeUndefined();
    expect(r.dashboardHost).toBeUndefined();
  });

  it("carries every runtime key through", () => {
    const r = resolveRuntimeConfig(
      {
        apiUrl: "https://a.example.com",
        hostMode: "cloud",
        allowRegistration: "true",
        dashboardHost: "app.example.com",
      },
      {},
    );
    expect(r).toEqual({
      apiUrl: "https://a.example.com",
      hostMode: "cloud",
      allowRegistration: "true",
      dashboardHost: "app.example.com",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Volumes/Development/rovenue
nice -n 19 npx vitest run --maxWorkers=2 apps/dashboard/src/lib/runtime-config.test.ts
```

Expected: FAIL — `Failed to resolve import "./runtime-config"`.

- [ ] **Step 3: Write the module**

Create `apps/dashboard/src/lib/runtime-config.ts`:

```ts
// =============================================================
// Runtime configuration
// =============================================================
//
// The ONE module allowed to read `import.meta.env.VITE_*`, enforced by an
// eslint rule in eslint.config.mjs.
//
// Vite inlines `import.meta.env.VITE_*` at BUILD time, so a published
// dashboard image would carry whatever the release build was given —
// http://localhost:3000 — and no operator could change it. The container
// therefore serves /config.js, which assigns window.__ROVENUE_CONFIG__
// before the bundle loads (deploy/caddy/Caddyfile.dashboard).
//
// Runtime wins over build time: in a published image the build-time value
// is only ever the development default. `import.meta.env` remains the
// `pnpm dev` path, where Vite serves the empty public/config.js.

export const DEFAULT_API_BASE_URL = "http://localhost:3000";

/** Shape assigned by /config.js. Keys mirror deploy/caddy/Caddyfile.dashboard. */
export interface RuntimeConfig {
  apiUrl?: string;
  hostMode?: string;
  allowRegistration?: string;
  dashboardHost?: string;
}

/** The build-time values Vite inlines. */
export interface BuildEnv {
  VITE_API_URL?: string;
  VITE_HOST_MODE?: string;
  VITE_ALLOW_REGISTRATION?: string;
  VITE_DASHBOARD_HOST?: string;
}

export interface ResolvedConfig {
  apiUrl: string;
  hostMode?: string;
  allowRegistration?: string;
  dashboardHost?: string;
}

declare global {
  interface Window {
    __ROVENUE_CONFIG__?: RuntimeConfig;
  }
}

/** Caddy emits `{$VAR:}` for unset variables, which arrives as "". */
function firstSet(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Pure — tests drive it without stubbing globals or import.meta.env. */
export function resolveRuntimeConfig(
  runtime: RuntimeConfig | undefined,
  build: BuildEnv,
): ResolvedConfig {
  return {
    apiUrl: firstSet(runtime?.apiUrl, build.VITE_API_URL) ?? DEFAULT_API_BASE_URL,
    hostMode: firstSet(runtime?.hostMode, build.VITE_HOST_MODE),
    allowRegistration: firstSet(runtime?.allowRegistration, build.VITE_ALLOW_REGISTRATION),
    dashboardHost: firstSet(runtime?.dashboardHost, build.VITE_DASHBOARD_HOST),
  };
}

const resolved = resolveRuntimeConfig(
  typeof window === "undefined" ? undefined : window.__ROVENUE_CONFIG__,
  {
    VITE_API_URL: import.meta.env.VITE_API_URL as string | undefined,
    VITE_HOST_MODE: import.meta.env.VITE_HOST_MODE as string | undefined,
    VITE_ALLOW_REGISTRATION: import.meta.env.VITE_ALLOW_REGISTRATION as string | undefined,
    VITE_DASHBOARD_HOST: import.meta.env.VITE_DASHBOARD_HOST as string | undefined,
  },
);

export function apiBaseUrl(): string {
  return resolved.apiUrl;
}

export function hostModeValue(): string | undefined {
  return resolved.hostMode;
}

export function allowRegistrationValue(): string | undefined {
  return resolved.allowRegistration;
}

export function dashboardHostValue(): string | undefined {
  return resolved.dashboardHost;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
nice -n 19 npx vitest run --maxWorkers=2 apps/dashboard/src/lib/runtime-config.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Rewire `host-mode.ts`**

The interface field names say `VITE_*`, which stops being true once the values arrive at runtime. Rename them.

In `apps/dashboard/src/lib/host-mode.ts`, replace the `HostModeEnv` interface, the `computeHostMode` body's first two lines, and the module-level call:

```ts
import { allowRegistrationValue, hostModeValue } from "./runtime-config";

export interface HostModeEnv {
  hostMode?: string;
  allowRegistration?: string;
}

export function computeHostMode(env: HostModeEnv): HostModeFlags {
  const hostMode = env.hostMode ?? "self";
  const allowRegistrationRaw = env.allowRegistration;
  // ... rest of the function unchanged ...
}

const _flags = computeHostMode({
  hostMode: hostModeValue(),
  allowRegistration: allowRegistrationValue(),
});
```

Also update the doc comment at the top of the file: the values are no longer build-time only. Replace the first paragraph with:

```ts
/**
 * Deployment-mode flags, mirrored from the API's HOST_MODE helper.
 *
 * Values come from lib/runtime-config.ts — the container's /config.js at
 * runtime, or the VITE_* build args in a from-source build. Self-hosters
 * get `self` (the default); Rovenue Cloud sets `cloud`.
 */
```

Then update `apps/dashboard/src/lib/host-mode.test.ts`: replace every `VITE_HOST_MODE:` with `hostMode:` and every `VITE_ALLOW_REGISTRATION:` with `allowRegistration:`.

- [ ] **Step 6: Rewire `custom-host.ts`**

In `apps/dashboard/src/lib/custom-host.ts`:

```ts
import { dashboardHostValue } from "./runtime-config";

export interface CustomHostEnv {
  dashboardHost?: string | undefined;
}

export function isCanonicalDashboardHost(
  env: CustomHostEnv,
  hostname: string,
): boolean {
  const configured = env.dashboardHost;
  if (!configured) return false;
  return normalize(configured) === normalize(hostname);
}

export const dashboardHostEnv: CustomHostEnv = {
  dashboardHost: dashboardHostValue(),
};
```

Then update `apps/dashboard/src/lib/custom-host.test.ts`: replace every `VITE_DASHBOARD_HOST:` with `dashboardHost:`.

- [ ] **Step 7: Run both existing test files**

```bash
nice -n 19 npx vitest run --maxWorkers=2 \
  apps/dashboard/src/lib/host-mode.test.ts \
  apps/dashboard/src/lib/custom-host.test.ts
```

Expected: PASS, unchanged counts.

- [ ] **Step 8: Rewire the ten `VITE_API_URL` sites**

In `apps/dashboard/src/lib/api.ts`, replace lines 4-5 with:

```ts
import { apiBaseUrl } from "./runtime-config";

export const API_BASE_URL = apiBaseUrl();
```

In the other nine files, replace the `import.meta.env.VITE_API_URL ?? "http://localhost:3000"` expression with a call to `apiBaseUrl()`, importing it with the correct relative path:

| File | Line | Import path |
|---|---|---|
| `src/lib/auth.ts` | 4 | `./runtime-config` |
| `src/runner/runner-api.ts` | 19 | `../lib/runtime-config` |
| `src/lib/hooks/useProjectIntegrations.ts` | 118 | `../runtime-config` |
| `src/lib/hooks/useSubscriberActions.ts` | 13 | `../runtime-config` |
| `src/lib/hooks/useExportMe.ts` | 4 | `../runtime-config` |
| `src/lib/hooks/useLiveEventsStream.ts` | 4 | `../runtime-config` |
| `src/lib/hooks/usePushDevices.ts` | 61 | `../runtime-config` |
| `src/routes/unsubscribe.tsx` | 16 | `../lib/runtime-config` |
| `src/routes/_authed/projects/$projectId/transactions.tsx` | 39 | `../../../../lib/runtime-config` |

`usePushDevices.ts:61` has the expression inline inside a template literal; replace it with `${apiBaseUrl()}`.

- [ ] **Step 9: Verify no reads remain outside the module**

```bash
cd /Volumes/Development/rovenue
grep -rn "import\.meta\.env\.VITE_" apps/dashboard/src
```

Expected: exactly four lines, all in `src/lib/runtime-config.ts`.

- [ ] **Step 10: Add the eslint rule**

In `eslint.config.mjs`, append a new config object after the existing rules block:

```js
  {
    // Deployment config is read in exactly one place. Vite inlines
    // import.meta.env.VITE_* at BUILD time, so a direct read anywhere else
    // silently re-breaks the published dashboard image — a bug that never
    // reproduces in dev and never fails a test.
    files: ["apps/dashboard/src/**/*.ts", "apps/dashboard/src/**/*.tsx"],
    ignores: ["apps/dashboard/src/lib/runtime-config.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.type='MetaProperty'][property.name=/^VITE_/]",
          message:
            "Read deployment config through lib/runtime-config.ts. Vite inlines VITE_* at build time, which a published image cannot override.",
        },
      ],
    },
  },
```

- [ ] **Step 11: Prove the rule fires, then confirm the tree is clean**

```bash
cd /Volumes/Development/rovenue
printf 'export const x = import.meta.env.VITE_API_URL;\n' > apps/dashboard/src/lib/_lint-probe.ts
npx eslint apps/dashboard/src/lib/_lint-probe.ts
```

Expected: one `no-restricted-syntax` error with the message above. Then:

```bash
rm apps/dashboard/src/lib/_lint-probe.ts
npx eslint apps/dashboard/src
```

Expected: no `no-restricted-syntax` errors. **Do not commit the probe file.**

- [ ] **Step 12: Typecheck and run the dashboard suite**

```bash
cd /Volumes/Development/rovenue
npx tsc -p apps/dashboard --noEmit
nice -n 19 npx vitest run --maxWorkers=2 --root apps/dashboard
```

Expected: no type errors; all dashboard tests pass.

- [ ] **Step 13: Commit**

```bash
cd /Volumes/Development/rovenue
git add apps/dashboard/src eslint.config.mjs
git commit -m "feat(dashboard): resolve deployment config at runtime, not build time

Vite inlines import.meta.env.VITE_* during vite build, so a published
dashboard image would carry http://localhost:3000 and no operator could
change it. All thirteen read sites now go through lib/runtime-config.ts,
which prefers window.__ROVENUE_CONFIG__ (served by the container) over
the build-time value.

An eslint rule keeps it that way: a direct VITE_* read is a bug that
never reproduces in dev and never fails a test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Serve `/config.js` from the image

**Files:**
- Create: `apps/dashboard/public/config.js`
- Modify: `apps/dashboard/index.html`
- Modify: `deploy/caddy/Caddyfile.dashboard`
- Create: `deploy/dashboard/entrypoint.sh`
- Modify: `apps/dashboard/Dockerfile` (runtime stage)
- Create: `apps/dashboard/tests/entrypoint.test.ts`

**Interfaces:**
- Consumes: the `window.__ROVENUE_CONFIG__` key names from Task 2 (`apiUrl`, `hostMode`, `allowRegistration`, `dashboardHost`).
- Produces: container env vars `ROVENUE_API_URL`, `ROVENUE_HOST_MODE`, `ROVENUE_ALLOW_REGISTRATION`, `ROVENUE_DASHBOARD_HOST`. Plan B's Coolify template and Helm chart set exactly these.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/tests/entrypoint.test.ts`:

```ts
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
// ESM package — no __dirname. apps/dashboard/tests -> repo root is three up.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "deploy", "dashboard", "entrypoint.sh");

/**
 * VALIDATE_ONLY short-circuits before `exec caddy run`, so the real script
 * is exercised here — not a reimplementation of its rules.
 */
async function validate(env: Record<string, string>) {
  return execFileAsync("sh", [SCRIPT], {
    env: { ...process.env, VALIDATE_ONLY: "1", ...env },
  });
}

describe("dashboard entrypoint validation", () => {
  it("accepts a fully unset environment", async () => {
    const { stdout } = await validate({});
    expect(stdout).toContain("ok");
  });

  it("accepts valid values", async () => {
    const { stdout } = await validate({
      ROVENUE_API_URL: "https://api.example.com",
      ROVENUE_HOST_MODE: "cloud",
      ROVENUE_ALLOW_REGISTRATION: "true",
      ROVENUE_DASHBOARD_HOST: "https://app.example.com",
    });
    expect(stdout).toContain("ok");
  });

  it("rejects a non-absolute API URL", async () => {
    await expect(validate({ ROVENUE_API_URL: "api.example.com" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ROVENUE_API_URL"),
    });
  });

  // The reason validation exists at all: Caddy's {$VAR} substitution is
  // textual, so a quote would emit a syntactically broken config.js and the
  // dashboard would fail to boot with no explanation.
  it("rejects a value containing a quote", async () => {
    await expect(
      validate({ ROVENUE_API_URL: 'https://a.example.com/"' }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ROVENUE_API_URL") });
  });

  it("rejects an unknown host mode", async () => {
    await expect(validate({ ROVENUE_HOST_MODE: "staging" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ROVENUE_HOST_MODE"),
    });
  });

  it("rejects a non-boolean allowRegistration", async () => {
    await expect(validate({ ROVENUE_ALLOW_REGISTRATION: "yes" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ROVENUE_ALLOW_REGISTRATION"),
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Volumes/Development/rovenue
nice -n 19 npx vitest run --maxWorkers=2 apps/dashboard/tests/entrypoint.test.ts
```

Expected: FAIL — ENOENT on `deploy/dashboard/entrypoint.sh`.

- [ ] **Step 3: Write the entrypoint**

Create `deploy/dashboard/entrypoint.sh`:

```sh
#!/bin/sh
# =============================================================
# Dashboard container entrypoint
# =============================================================
#
# Caddy serves /config.js by substituting {$ROVENUE_*} into a JS literal
# (deploy/caddy/Caddyfile.dashboard). That substitution is TEXTUAL — Caddy
# does no JSON escaping — so a value containing a quote would emit a broken
# config.js and the dashboard would fail to boot with a syntax error and no
# explanation of where it came from.
#
# Validating here converts that into a container that refuses to start and
# names the offending variable.
set -eu

HOST_MODE_VALUES="self cloud"
BOOL_VALUES="true false"

fail() {
	echo "dashboard entrypoint: $1" >&2
	exit 1
}

# Rejects the characters that would break out of the JS string literal, plus
# anything non-printable. Applied to every value regardless of its own rule.
check_safe() {
	name="$1"
	value="$2"
	case "$value" in
	*'"'* | *'\'* | *'`'* | *'$'*) fail "$name contains a character that cannot be embedded in config.js" ;;
	esac
	case "$value" in
	*"$(printf '\n')"*) fail "$name contains a newline" ;;
	esac
}

check_absolute_url() {
	name="$1"
	value="$2"
	[ -z "$value" ] && return 0
	check_safe "$name" "$value"
	case "$value" in
	http://* | https://*) return 0 ;;
	*) fail "$name must be an absolute http(s) URL, got: $value" ;;
	esac
}

check_enum() {
	name="$1"
	value="$2"
	allowed="$3"
	[ -z "$value" ] && return 0
	check_safe "$name" "$value"
	for candidate in $allowed; do
		[ "$value" = "$candidate" ] && return 0
	done
	fail "$name must be one of: $allowed — got: $value"
}

check_absolute_url ROVENUE_API_URL "${ROVENUE_API_URL:-}"
check_absolute_url ROVENUE_DASHBOARD_HOST "${ROVENUE_DASHBOARD_HOST:-}"
check_enum ROVENUE_HOST_MODE "${ROVENUE_HOST_MODE:-}" "$HOST_MODE_VALUES"
check_enum ROVENUE_ALLOW_REGISTRATION "${ROVENUE_ALLOW_REGISTRATION:-}" "$BOOL_VALUES"

# Exercised by apps/dashboard/tests/entrypoint.test.ts.
if [ -n "${VALIDATE_ONLY:-}" ]; then
	echo "ok"
	exit 0
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

Make it executable:

```bash
chmod +x deploy/dashboard/entrypoint.sh
```

- [ ] **Step 4: Run the test to verify it passes, and shellcheck the script**

```bash
cd /Volumes/Development/rovenue
nice -n 19 npx vitest run --maxWorkers=2 apps/dashboard/tests/entrypoint.test.ts
shellcheck deploy/dashboard/entrypoint.sh
```

Expected: 6 tests PASS; shellcheck silent. (If `shellcheck` is not installed: `brew install shellcheck`.)

- [ ] **Step 5: Add the dev placeholder and the script tag**

Create `apps/dashboard/public/config.js`:

```js
// Dev placeholder. Vite serves this file at /config.js during `pnpm dev` so
// the tag in index.html gets a 200 instead of a console error.
//
// It is NOT what a container serves: deploy/caddy/Caddyfile.dashboard
// intercepts /config.js and responds from the ROVENUE_* environment. With
// every key absent here, lib/runtime-config.ts falls through to the VITE_*
// build values, which is exactly the dev behaviour.
window.__ROVENUE_CONFIG__ = {};
```

In `apps/dashboard/index.html`, add the tag **before** the module script:

```html
    <script src="/config.js"></script>
    <script type="module" src="/src/main.tsx"></script>
```

- [ ] **Step 6: Rewrite the dashboard Caddyfile**

Replace the whole of `deploy/caddy/Caddyfile.dashboard` with:

```
# Static file server for the built dashboard SPA. Baked into the dashboard
# image and run on :80 inside the docker network; the edge Caddy
# (deploy/caddy/Caddyfile) reverse-proxies app.rovenue.io here.
#
# Everything is routed through explicit `handle` blocks so that /config.js
# resolves here and never reaches file_server — the static build also
# contains a config.js (the dev placeholder from apps/dashboard/public/),
# and leaving both reachable would make which one wins depend on Caddy's
# directive ordering. The wrong answer serves an empty config to every
# browser.
:80 {
	encode zstd gzip

	# Runtime deployment config, read by lib/runtime-config.ts before the
	# bundle loads. Vite inlines VITE_* at BUILD time, so this is the only
	# way one published image can serve any operator's origin.
	#
	# Substitution is textual — deploy/dashboard/entrypoint.sh validates
	# every value and refuses to start the container on anything that could
	# break out of these string literals.
	#
	# no-cache is load-bearing: a cached config.js survives a redeploy that
	# changed the API origin, and the failure is a dashboard silently
	# talking to the wrong host.
	handle /config.js {
		header Content-Type "application/javascript; charset=utf-8"
		header Cache-Control "no-cache"
		respond `window.__ROVENUE_CONFIG__={"apiUrl":"{$ROVENUE_API_URL:}","hostMode":"{$ROVENUE_HOST_MODE:}","allowRegistration":"{$ROVENUE_ALLOW_REGISTRATION:}","dashboardHost":"{$ROVENUE_DASHBOARD_HOST:}"};` 200
	}

	# Stripe's Apple Pay domain association file (shipped in the Vite
	# public/ dir). This origin serves the funnel paywall at /f/<slug>, and
	# Stripe will not mark Apple Pay active on a payment method domain that
	# does not serve this file. The file is extensionless, so without this
	# header Caddy sends no Content-Type at all; Stripe's own payment hosts
	# serve it as application/octet-stream.
	handle /.well-known/apple-developer-merchantid-domain-association {
		root * /srv
		header Content-Type "application/octet-stream"
		file_server
	}

	handle {
		root * /srv
		# SPA fallback: serve index.html for any path that is not a real
		# file, so TanStack Router client routes resolve on hard refresh.
		try_files {path} /index.html
		file_server
		# Long-cache fingerprinted assets; never cache index.html.
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		header /index.html Cache-Control "no-cache"
	}
}
```

- [ ] **Step 7: Wire the entrypoint into the image**

In `apps/dashboard/Dockerfile`, replace the runtime stage's final lines with:

```dockerfile
FROM caddy:2-alpine AS runtime
COPY deploy/caddy/Caddyfile.dashboard /etc/caddy/Caddyfile
COPY deploy/dashboard/entrypoint.sh /usr/local/bin/rovenue-entrypoint.sh
COPY --from=builder /app/apps/dashboard/dist /srv
RUN chmod +x /usr/local/bin/rovenue-entrypoint.sh
EXPOSE 80
# Validates ROVENUE_* and refuses to start on a bad value, then execs caddy.
ENTRYPOINT ["/usr/local/bin/rovenue-entrypoint.sh"]
```

Note the `ENTRYPOINT` replaces the base image's; no `CMD` is needed because the script ends in `exec caddy run`.

- [ ] **Step 8: Verify the image end to end**

This is the only step that proves the three pieces agree. Build and run the real image:

```bash
cd /Volumes/Development/rovenue
docker build -f apps/dashboard/Dockerfile -t rovenue-dashboard-test .
docker run -d --rm --name rovenue-dash-test -p 8099:80 \
  -e ROVENUE_API_URL=https://api.example.com \
  -e ROVENUE_HOST_MODE=cloud \
  rovenue-dashboard-test
sleep 3
curl -fsS -D- http://localhost:8099/config.js
```

Expected: `200`, `Cache-Control: no-cache`, and a body containing
`"apiUrl":"https://api.example.com"` and `"hostMode":"cloud"`.

Then prove the container refuses a bad value:

```bash
docker rm -f rovenue-dash-test
docker run --rm -e ROVENUE_API_URL='not-a-url' rovenue-dashboard-test; echo "exit=$?"
```

Expected: stderr naming `ROVENUE_API_URL`, `exit=1`.

Clean up:

```bash
docker rm -f rovenue-dash-test 2>/dev/null; docker rmi rovenue-dashboard-test
```

- [ ] **Step 9: Verify `pnpm dev` still works**

```bash
cd /Volumes/Development/rovenue
npx vite --root apps/dashboard --port 5199 &
sleep 6
curl -fsS http://localhost:5199/config.js
kill %1
```

Expected: the placeholder file's contents, `200`. (If port 5199 is taken, pick another — see the note about a :3000 conflict tearing down the whole turbo stack; a bare `vite` here avoids that.)

- [ ] **Step 10: Commit**

```bash
cd /Volumes/Development/rovenue
git add apps/dashboard/public/config.js apps/dashboard/index.html \
  apps/dashboard/Dockerfile apps/dashboard/tests/entrypoint.test.ts \
  deploy/caddy/Caddyfile.dashboard deploy/dashboard/entrypoint.sh
git commit -m "feat(dashboard): serve /config.js from the container environment

Caddy responds to /config.js from ROVENUE_* placeholders, so one published
image serves any operator's origin. Nothing is written to disk, which keeps
readOnlyRootFilesystem available.

Caddy's substitution is textual, so the entrypoint validates every value
and refuses to start on one that could break out of the JS string literal —
the alternative is a container that boots and serves a syntactically broken
config with no error anywhere.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Vendor Apple's root certificates

**Files:**
- Create: `deploy/apple-certs/AppleRootCA-G3.cer`, `deploy/apple-certs/AppleIncRootCertificate.cer`
- Create: `apps/api/tests/apple-certs.test.ts`
- Modify: `apps/api/Dockerfile` (runtime stage)
- Modify: `deploy/apple-certs/.gitkeep` — delete it

**Interfaces:**
- Consumes: nothing.
- Produces: `/etc/rovenue/apple-certs` populated inside `rovenue-api`, and `APPLE_ROOT_CERTS_DIR` defaulted to it. Plan B's Coolify template and Helm chart rely on this — neither can mount host files.

- [ ] **Step 1: Fetch the certificates**

```bash
cd /Volumes/Development/rovenue
rm -f deploy/apple-certs/.gitkeep
curl -fsSL -o deploy/apple-certs/AppleRootCA-G3.cer \
  https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
curl -fsSL -o deploy/apple-certs/AppleIncRootCertificate.cer \
  https://www.apple.com/appleca/AppleIncRootCertificate.cer
ls -l deploy/apple-certs/
```

Expected: two files, roughly 0.5–1.5 KB each.

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/apple-certs.test.ts`:

```ts
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ESM package — no __dirname. apps/api/tests -> repo root is three up.
const HERE = dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = join(HERE, "..", "..", "..", "deploy", "apple-certs");

/**
 * These bytes are vendored rather than downloaded at image-build time, so
 * nothing else checks them. The App Store JWS verifier chain-pins to them
 * and fails closed; a truncated or expired file would surface as every
 * receipt verification failing in production.
 */
const EXPECTED = [
  { file: "AppleRootCA-G3.cer", subjectContains: "Apple Root CA - G3" },
  { file: "AppleIncRootCertificate.cer", subjectContains: "Apple Root CA" },
];

describe("vendored Apple root certificates", () => {
  it.each(EXPECTED)("$file parses as a certificate", ({ file, subjectContains }) => {
    const cert = new X509Certificate(readFileSync(join(CERTS_DIR, file)));
    expect(cert.subject).toContain(subjectContains);
  });

  it.each(EXPECTED)("$file is self-signed (it is a root)", ({ file }) => {
    const cert = new X509Certificate(readFileSync(join(CERTS_DIR, file)));
    expect(cert.issuer).toBe(cert.subject);
  });

  it.each(EXPECTED)("$file is not expired", ({ file }) => {
    const cert = new X509Certificate(readFileSync(join(CERTS_DIR, file)));
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 3: Run the test**

```bash
cd /Volumes/Development/rovenue
nice -n 19 npx vitest run --maxWorkers=2 --root apps/api tests/apple-certs.test.ts
```

Expected: 6 tests PASS. If a file fails to parse, it is DER-encoded and `X509Certificate` handles DER — a parse failure means the download returned an error page, so re-check Step 1's output.

- [ ] **Step 4: Bake them into the api image**

In `apps/api/Dockerfile`, in the `runtime` stage after the existing `COPY --from=builder ... /app/locales` line, add:

```dockerfile
# Apple's public root CAs, vendored in deploy/apple-certs/ rather than
# fetched here: a build that downloads a trust anchor depends on apple.com
# being reachable and on that URL never moving, cannot run offline, and
# hides the bytes from code review. apps/api/tests/apple-certs.test.ts
# parses the committed files on every CI run.
#
# APPLE_ROOT_CERTS_DIR is required in production and the SignedDataVerifier
# fails closed without it, so a packaging path that cannot mount host files
# (Coolify, Helm) would otherwise have no way to satisfy it.
COPY --chown=rovenue:rovenue deploy/apple-certs/*.cer /etc/rovenue/apple-certs/
```

And extend the existing `ENV` block with a default:

```dockerfile
ENV NODE_ENV=production \
    PORT=3000 \
    APPLE_ROOT_CERTS_DIR=/etc/rovenue/apple-certs \
    VIPS_BLOCK_UNTRUSTED=1
```

Keep the `VIPS_BLOCK_UNTRUSTED` comment that is already there.

- [ ] **Step 5: Verify the image carries them**

```bash
cd /Volumes/Development/rovenue
docker build -f apps/api/Dockerfile -t rovenue-api-test .
docker run --rm --entrypoint sh rovenue-api-test -c 'ls -l $APPLE_ROOT_CERTS_DIR'
docker rmi rovenue-api-test
```

Expected: both `.cer` files listed, owned by `rovenue`.

- [ ] **Step 6: Confirm the compose override still wins**

The root compose file mounts `./deploy/apple-certs` over the same path. Since the directory now holds the same two files, the mount is a no-op rather than a conflict — confirm nothing broke:

```bash
cd /Volumes/Development/rovenue
grep -n "apple-certs" docker-compose.yml
```

Expected: the existing `volumes:` line under `api`, unchanged. Leave it alone — it is the documented override for an operator with their own copy.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Development/rovenue
git add deploy/apple-certs apps/api/Dockerfile apps/api/tests/apple-certs.test.ts
git commit -m "feat(api): vendor Apple root CAs and bake them into the image

APPLE_ROOT_CERTS_DIR is required in production and the JWS verifier fails
closed without it, so every packaging path needed a way to supply two files
an operator had to fetch by hand.

Committed rather than downloaded during the build: a pinned checksum
protects integrity but still ties every release to apple.com, rules out
offline builds, and hides the bytes from review. A test parses the
committed files and asserts they are self-signed and unexpired.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Multi-arch release workflow

**Files:**
- Create: `.github/workflows/release-images.yml`

**Interfaces:**
- Consumes: Tasks 3 and 4 (the dashboard image must be runtime-configurable and the api image must carry the certs before either is worth publishing).
- Produces: `ghcr.io/broverse/rovenue-{api,dashboard,docs,postgres}:vX.Y.Z` (also `X.Y` and `latest`), multi-arch amd64+arm64. Plan B's Helm `values.yaml` and Coolify template reference these names and the `vX.Y.Z` tag form.

**Two deliberate deviations from spec §3, both to be closed in Plan B:**

- The spec calls for `docker/metadata-action` to generate tags. This workflow
  resolves the version once per image in the `manifest` job instead, because
  the push-by-digest → `imagetools create` flow needs bare tag strings as `-t`
  flags rather than metadata-action's newline-delimited output. The drift the
  spec was guarding against cannot happen here: all four images take their
  tags from the same step in the same job.
- The spec also has this workflow `helm package` and `helm push` the chart.
  The chart does not exist yet, so that step lands with the chart in Plan B.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release-images.yml`:

```yaml
name: Release images

# Tagged releases only. These are multi-arch builds, and the upgrade
# runbook pins versions rather than commits, so there is nothing for a
# per-push build to serve.
on:
  push:
    tags: ["v*.*.*"]
  workflow_dispatch:
    inputs:
      tag:
        description: "Version tag to build, e.g. v1.2.0"
        required: true

env:
  REGISTRY: ghcr.io
  IMAGE_NAMESPACE: broverse

jobs:
  build:
    name: build ${{ matrix.image }} (${{ matrix.platform }})
    runs-on: ${{ matrix.runner }}
    permissions:
      contents: read
      packages: write
    strategy:
      fail-fast: false
      matrix:
        image:
          - { name: rovenue-api, dockerfile: apps/api/Dockerfile, context: "." }
          - { name: rovenue-dashboard, dockerfile: apps/dashboard/Dockerfile, context: "." }
          - { name: rovenue-docs, dockerfile: apps/docs/Dockerfile, context: "." }
          - { name: rovenue-postgres, dockerfile: deploy/postgres/Dockerfile, context: "deploy/postgres" }
        # Native runners, not QEMU: pnpm install + vite build under emulated
        # arm64 runs into tens of minutes and turns a release into an
        # afternoon.
        include:
          - platform: linux/amd64
            runner: ubuntu-24.04
          - platform: linux/arm64
            runner: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push by digest
        id: build
        uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.image.context }}
          file: ${{ matrix.image.dockerfile }}
          platforms: ${{ matrix.platform }}
          provenance: mode=max
          sbom: true
          outputs: type=image,name=${{ env.REGISTRY }}/${{ env.IMAGE_NAMESPACE }}/${{ matrix.image.name }},push-by-digest=true,name-canonical=true,push=true
          cache-from: type=gha,scope=${{ matrix.image.name }}-${{ matrix.platform }}
          cache-to: type=gha,mode=max,scope=${{ matrix.image.name }}-${{ matrix.platform }}

      - name: Export digest
        run: |
          mkdir -p /tmp/digests
          touch "/tmp/digests/${{ matrix.image.name }}@${GITHUB_JOB}-${{ strategy.job-index }}"
          echo "${{ steps.build.outputs.digest }}" > \
            "/tmp/digests/${{ matrix.image.name }}-$(echo '${{ matrix.platform }}' | tr / -)"

      - uses: actions/upload-artifact@v4
        with:
          name: digests-${{ matrix.image.name }}-${{ strategy.job-index }}
          path: /tmp/digests/*
          retention-days: 1

  manifest:
    name: manifest ${{ matrix.image }}
    needs: build
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        image: [rovenue-api, rovenue-dashboard, rovenue-docs, rovenue-postgres]
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: digests-${{ matrix.image }}-*
          path: /tmp/digests
          merge-multiple: true

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Resolve version
        id: version
        run: |
          VERSION="${{ github.event.inputs.tag }}"
          [ -z "$VERSION" ] && VERSION="${GITHUB_REF#refs/tags/}"
          MINOR="$(echo "${VERSION#v}" | cut -d. -f1,2)"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "minor=$MINOR" >> "$GITHUB_OUTPUT"

      - name: Create and push the multi-arch manifest
        run: |
          IMAGE="${{ env.REGISTRY }}/${{ env.IMAGE_NAMESPACE }}/${{ matrix.image }}"
          DIGESTS=""
          for f in /tmp/digests/${{ matrix.image }}-*; do
            DIGESTS="$DIGESTS ${IMAGE}@$(cat "$f")"
          done
          # shellcheck disable=SC2086
          docker buildx imagetools create \
            -t "${IMAGE}:${{ steps.version.outputs.version }}" \
            -t "${IMAGE}:${{ steps.version.outputs.minor }}" \
            -t "${IMAGE}:latest" \
            $DIGESTS
          docker buildx imagetools inspect "${IMAGE}:${{ steps.version.outputs.version }}"
```

- [ ] **Step 2: Validate the workflow syntax locally**

```bash
cd /Volumes/Development/rovenue
npx --yes @action-validator/cli@latest --verbose .github/workflows/release-images.yml
```

Expected: no errors. If `@action-validator` is unavailable, fall back to a YAML parse check:

```bash
npx --yes js-yaml .github/workflows/release-images.yml > /dev/null && echo "yaml ok"
```

- [ ] **Step 3: Verify each Dockerfile builds from the context the matrix gives it**

The matrix claims `rovenue-postgres` builds from `deploy/postgres` while the other three build from the repo root. Prove it rather than assume it:

```bash
cd /Volumes/Development/rovenue
docker build -f deploy/postgres/Dockerfile deploy/postgres -t rovenue-postgres-test
docker build -f apps/docs/Dockerfile . -t rovenue-docs-test
docker rmi rovenue-postgres-test rovenue-docs-test
```

Expected: both succeed. (`rovenue-api` and `rovenue-dashboard` were built in Tasks 3 and 4.)

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Development/rovenue
git add .github/workflows/release-images.yml
git commit -m "feat(ci): publish multi-arch images to GHCR on tagged releases

Four images — api (which also runs migrate, dispatcher and the four
notification workers), dashboard, docs, postgres — built on native
amd64 and arm64 runners and joined into one manifest.

Native runners rather than QEMU: pnpm install plus vite build under
emulated arm64 takes tens of minutes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Sign, scan, and pin the release

**Files:**
- Modify: `.github/workflows/release-images.yml`
- Modify: `docs/operations/deployment.md`

**Interfaces:**
- Consumes: Task 5's `manifest` job and its `steps.version.outputs.version`.
- Produces: cosign signatures on each published tag, verifiable with the command documented in `deployment.md`.

- [ ] **Step 1: Add the vulnerability gate to the build job**

In `.github/workflows/release-images.yml`, in the `build` job, insert this step **between** `Build and push by digest` and `Export digest`:

```yaml
      # A gate, not a report. The sharp >= 0.35.3 floor
      # (CVE-2026-33327/33328/35590/35591, GIF/TIFF/VIPS loaders) is a
      # standing obligation; this is what turns it into an enforced one.
      - name: Scan for HIGH/CRITICAL vulnerabilities
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAMESPACE }}/${{ matrix.image.name }}@${{ steps.build.outputs.digest }}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: "1"
          format: table
```

- [ ] **Step 2: Add signing to the manifest job**

Add `id-token: write` to the `manifest` job's `permissions` block (keyless signing needs the OIDC token):

```yaml
    permissions:
      contents: read
      packages: write
      id-token: write
```

Then append these steps to the end of the `manifest` job:

```yaml
      - uses: sigstore/cosign-installer@v3

      # Keyless, via the workflow's GitHub OIDC identity. An operator
      # verifies with the command in docs/operations/deployment.md, which
      # names this repository and workflow as the expected identity.
      - name: Sign the published tags
        run: |
          IMAGE="${{ env.REGISTRY }}/${{ env.IMAGE_NAMESPACE }}/${{ matrix.image }}"
          for TAG in "${{ steps.version.outputs.version }}" "${{ steps.version.outputs.minor }}" latest; do
            DIGEST="$(docker buildx imagetools inspect "${IMAGE}:${TAG}" --format '{{.Manifest.Digest}}')"
            cosign sign --yes "${IMAGE}@${DIGEST}"
          done
```

- [ ] **Step 3: Pin every third-party action by commit SHA**

A moving tag on an action that holds registry push credentials is a repeated real-world supply-chain compromise. Resolve each tag to its SHA and rewrite the `uses:` lines, keeping the version in a trailing comment:

```bash
cd /Volumes/Development/rovenue
for REF in actions/checkout@v4 actions/upload-artifact@v4 actions/download-artifact@v4 \
           docker/setup-buildx-action@v3 docker/login-action@v3 docker/build-push-action@v6 \
           aquasecurity/trivy-action@0.28.0 sigstore/cosign-installer@v3; do
  REPO="${REF%@*}"; TAG="${REF#*@}"
  SHA="$(gh api "repos/${REPO}/commits/${TAG}" --jq .sha)"
  echo "${REPO}@${SHA} # ${TAG}"
done
```

Replace each `uses:` line with the corresponding `owner/repo@<sha> # <tag>` output.

- [ ] **Step 4: Re-validate the workflow**

```bash
cd /Volumes/Development/rovenue
npx --yes js-yaml .github/workflows/release-images.yml > /dev/null && echo "yaml ok"
grep -c "uses:.*@[0-9a-f]\{40\}" .github/workflows/release-images.yml
```

Expected: `yaml ok`, and a count matching the number of `uses:` lines (8 distinct actions across both jobs — count the actual lines, some actions appear in both jobs).

- [ ] **Step 5: Document verification for operators**

Append to `docs/operations/deployment.md`, before the smoke-test section:

```markdown
## Verifying the images you pulled

Released images are signed with cosign using the release workflow's GitHub
OIDC identity — there is no key to distribute, and no key for an attacker
to steal. Verify before a production deploy:

    cosign verify \
      --certificate-identity-regexp '^https://github.com/broverse/rovenue/\.github/workflows/release-images\.yml@refs/tags/v' \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      ghcr.io/broverse/rovenue-api:v1.0.0

Expected: a JSON payload listing the verified signature. A failure means the
image was not produced by that workflow — do not deploy it.

Each image also carries a SLSA provenance attestation and an SPDX SBOM:

    cosign download sbom ghcr.io/broverse/rovenue-api:v1.0.0

Use it to answer "am I affected" when a transitive CVE is announced, without
waiting for us.
```

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Development/rovenue
git add .github/workflows/release-images.yml docs/operations/deployment.md
git commit -m "feat(ci): sign, scan and pin the image release

Operators pull these images and run them against production databases,
which makes the release pipeline a security boundary.

- trivy gates HIGH/CRITICAL before the manifest is published, which is
  what turns the standing sharp >= 0.35.3 floor into an enforced one
- cosign keyless signing, with the verify command documented for operators
- SLSA provenance and an SPDX SBOM on every image
- every third-party action pinned by commit SHA, not by a moving tag

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `grep -rn "import\.meta\.env\.VITE_" apps/dashboard/src` returns only lines inside `runtime-config.ts`.
- A locally built `rovenue-dashboard` image serves `/config.js` reflecting its `ROVENUE_*` environment, and refuses to start on an invalid value.
- A locally built `rovenue-api` image has both `.cer` files at `$APPLE_ROOT_CERTS_DIR`.
- `nice -n 19 npx vitest run --maxWorkers=2 --root apps/dashboard` and the two new api/db test files pass.
- `docker compose up` and `pnpm dev` are unchanged in behaviour.
- `.github/workflows/release-images.yml` parses, pins every action by SHA, and its four Dockerfile/context pairs each build locally.

**Not verifiable from here:** the workflow has never run — no tag has been pushed. The first `v*.*.*` tag is the real test, and Plan B should not start against published tags until one has succeeded.
