# HOST_MODE + Registration Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a single `HOST_MODE` (`self` | `cloud`) deployment switch that disables billing and feature limits in self-host, plus an `ALLOW_REGISTRATION` policy where (when closed) only the first user can register and everyone else must accept an invite — removing the now-redundant `BILLING_ENABLED` and `ROVI_UNLIMITED` flags.

**Architecture:** All mode interpretation lives in one API helper (`apps/api/src/lib/host-mode.ts`) and one mirror dashboard helper. A pure decision function gates registration; a Better Auth `databaseHooks.user.create.before` hook calls it on every user creation (the existing invite UI flow is unchanged). Billing stays cloud-only via the helper; Rovi unlimited + BYOK become self-only.

**Tech Stack:** Hono + TypeScript (strict), Zod env schema, Better Auth (Drizzle adapter), Drizzle ORM (Postgres), Vitest (+ testcontainers for integration), React (Vite) dashboard.

## Global Constraints

- TypeScript strict everywhere; Zod for any new env field. (CLAUDE.md)
- All API responses are `{ data: T }` or `{ error: { code, message } }`. (CLAUDE.md)
- Postgres access via Drizzle repositories only. (CLAUDE.md)
- Conventional commits; commit after each task. (CLAUDE.md)
- Stay on the current branch — do NOT create or switch branches. (project memory)
- Integration tests run against real Postgres via testcontainers and mutate `env` at runtime (the env object is parsed once at import; helpers must read it live, which they do). (project memory)
- `HOST_MODE` defaults to `self`. `ALLOW_REGISTRATION` is optional; when unset its effective value derives from `HOST_MODE` (self→closed, cloud→open).
- `BILLING_ENABLED` and `ROVI_UNLIMITED` are REMOVED — no code may reference them after this plan.

---

## File Structure

**API**
- `apps/api/src/lib/env.ts` — add `HOST_MODE`, `ALLOW_REGISTRATION`; remove `BILLING_ENABLED`, `ROVI_UNLIMITED`; superRefine keys-required gate now keys off `HOST_MODE==="cloud"`.
- `apps/api/src/lib/host-mode.ts` — NEW. Single source of truth: `isCloud / isSelfHosted / isBillingEnabled / quotasUnlimited / isByokAllowed / registrationOpen`.
- `apps/api/src/lib/billing-flags.ts` — DELETE (folded into host-mode.ts).
- `apps/api/src/lib/registration-gate.ts` — NEW. Pure `isRegistrationAllowed()` decision.
- `apps/api/src/lib/auth.ts` — add `databaseHooks.user.create.before` calling the gate.
- `apps/api/src/services/copilot/quota.ts` — `resolveTier` takes `unlimited` explicitly; drop `ROVI_UNLIMITED` read.
- `apps/api/src/middleware/rovi-quota-guard.ts`, `apps/api/src/routes/dashboard/copilot/usage.ts` — pass `unlimited: quotasUnlimited()`.
- `apps/api/src/routes/dashboard/copilot/credentials.ts` — `PUT` and `POST /test` reject when `!isByokAllowed()`.

**DB**
- `packages/db/src/drizzle/repositories/users.ts` — NEW. `countUsers(db)`.
- `packages/db/src/drizzle/repositories/invitations.ts` — add `findAnyPendingInvitationByEmail(db, email)` (global, expiry-checked).
- `packages/db/src/drizzle/index.ts` — export `userRepo`.

**Dashboard**
- `apps/dashboard/src/lib/host-mode.ts` — NEW. Build-time mirror of the API flags from `VITE_HOST_MODE` / `VITE_ALLOW_REGISTRATION`.
- `apps/dashboard/src/components/dashboard/topbar.tsx` — read `isSelfHosted` from the helper.
- `apps/dashboard/src/routes/login.tsx` — invite-only banner when registration not open.
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/rovi.tsx`, `apps/dashboard/src/components/rovi/rovi-missing-config.tsx` — show BYOK key entry only when `byokAllowed`.

**Config**
- `.env.example` — new Deployment-mode section; remove `BILLING_ENABLED`/`ROVI_UNLIMITED`; annotate Stripe + `ROVI_TIER` as cloud-only; add `VITE_HOST_MODE`/`VITE_ALLOW_REGISTRATION`.

---

## Task 1: Env schema — add HOST_MODE / ALLOW_REGISTRATION, remove old flags

**Files:**
- Modify: `apps/api/src/lib/env.ts`

**Interfaces:**
- Produces: `env.HOST_MODE: "self" | "cloud"`, `env.ALLOW_REGISTRATION: boolean | undefined`. Removes `env.BILLING_ENABLED` and `env.ROVI_UNLIMITED`.

- [ ] **Step 1: Add the deployment-mode fields.** In `apps/api/src/lib/env.ts`, immediately after the `NODE_ENV` field (the `.default("development")` block ending at line 19), insert:

```ts
    // ---- Deployment mode (self-hosted vs managed cloud) ------------------
    // "self"  → no billing, Rovi unlimited + BYOK, registration closed after
    //           the first user (invite-only). Default for self-hosters.
    // "cloud" → Stripe billing, Rovi tier quotas, open registration.
    HOST_MODE: z.enum(["self", "cloud"]).default("self"),
    // Open-registration override. Unset → derived from HOST_MODE
    // (self → false, cloud → true). "true" allows anyone to sign up.
    ALLOW_REGISTRATION: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
```

- [ ] **Step 2: Remove `BILLING_ENABLED`.** Delete lines 112–119 (the `// ---- Billing (Stripe) ----` comment block through the `BILLING_ENABLED: z.enum(...).transform(...)` field). Keep the `STRIPE_BILLING_*` fields directly below; prepend this comment in their place:

```ts
    // ---- Billing (Stripe) — cloud only (HOST_MODE=cloud) -----------------
    // Required in production when HOST_MODE=cloud (see superRefine below).
```

- [ ] **Step 3: Remove `ROVI_UNLIMITED`.** Replace the Rovi comment+field at lines 169–173 with (keep `ROVI_TIER` and everything after):

```ts
    // ---- Rovi (AI copilot) ------------------------------------------------
    // Tier quotas apply only in cloud (HOST_MODE=cloud); self-host is
    // unlimited (see lib/host-mode.ts). ROVI_TIER sets the cloud default
    // tier when projects.metadata has no rovi_tier override.
    ROVI_TIER: z.enum(["free", "team", "business", "enterprise"]).optional(),
```

- [ ] **Step 4: Repoint the production keys-required gate.** In the `superRefine`, replace `if (data.BILLING_ENABLED) {` (line 257) with `if (data.HOST_MODE === "cloud") {` and update the three messages from `"BILLING_ENABLED=true requires ..."` to `"HOST_MODE=cloud requires ..."` (secret key, webhook secret, Indie monthly price id).

- [ ] **Step 5: Typecheck.**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS (no references to removed fields in env.ts itself; other files fixed in later tasks may still error — note them, they are addressed in Tasks 2/5).

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/lib/env.ts
git commit -m "feat(api): add HOST_MODE + ALLOW_REGISTRATION env, drop BILLING_ENABLED/ROVI_UNLIMITED"
```

---

## Task 2: host-mode.ts helper (replace billing-flags.ts) + repoint importers

**Files:**
- Create: `apps/api/src/lib/host-mode.ts`
- Delete: `apps/api/src/lib/billing-flags.ts`
- Modify importers of `isBillingEnabled`: `apps/api/src/lib/stripe-billing.ts`, `apps/api/src/routes/dashboard/billing/{invoices,upgrade,summary,usage,payment-methods}.ts`, `apps/api/src/routes/billing/webhook.ts`
- Test: `apps/api/src/lib/host-mode.test.ts`

**Interfaces:**
- Produces: `isCloud()`, `isSelfHosted()`, `isBillingEnabled()`, `quotasUnlimited()`, `isByokAllowed()`, `registrationOpen()` — all `() => boolean`, read `env` live.

- [ ] **Step 1: Write the failing test.** Create `apps/api/src/lib/host-mode.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";
import {
  isBillingEnabled,
  isByokAllowed,
  isCloud,
  isSelfHosted,
  quotasUnlimited,
  registrationOpen,
} from "./host-mode";

const original = { HOST_MODE: env.HOST_MODE, ALLOW_REGISTRATION: env.ALLOW_REGISTRATION };
afterEach(() => {
  env.HOST_MODE = original.HOST_MODE;
  env.ALLOW_REGISTRATION = original.ALLOW_REGISTRATION;
});

describe("host-mode flags", () => {
  it("self: billing off, unlimited, byok on, registration closed by default", () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = undefined;
    expect(isSelfHosted()).toBe(true);
    expect(isCloud()).toBe(false);
    expect(isBillingEnabled()).toBe(false);
    expect(quotasUnlimited()).toBe(true);
    expect(isByokAllowed()).toBe(true);
    expect(registrationOpen()).toBe(false);
  });

  it("cloud: billing on, quotas enforced, no byok, registration open by default", () => {
    env.HOST_MODE = "cloud";
    env.ALLOW_REGISTRATION = undefined;
    expect(isBillingEnabled()).toBe(true);
    expect(quotasUnlimited()).toBe(false);
    expect(isByokAllowed()).toBe(false);
    expect(registrationOpen()).toBe(true);
  });

  it("explicit ALLOW_REGISTRATION overrides the derived default", () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = true;
    expect(registrationOpen()).toBe(true);
    env.HOST_MODE = "cloud";
    env.ALLOW_REGISTRATION = false;
    expect(registrationOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — fails (module missing).**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/host-mode.test.ts`
Expected: FAIL — cannot resolve `./host-mode`.

- [ ] **Step 3: Create the helper.** Create `apps/api/src/lib/host-mode.ts`:

```ts
import { env } from "./env";

// Single source of truth for deployment-mode behaviour. All functions read
// `env` live so test fixtures that mutate env take effect.

export function isCloud(): boolean {
  return env.HOST_MODE === "cloud";
}

export function isSelfHosted(): boolean {
  return env.HOST_MODE === "self";
}

// Platform billing (Stripe) is cloud-only.
export function isBillingEnabled(): boolean {
  return isCloud();
}

// Self-host runs Rovi without tier quotas.
export function quotasUnlimited(): boolean {
  return isSelfHosted();
}

// Bring-your-own AI provider key is a self-host-only capability.
export function isByokAllowed(): boolean {
  return isSelfHosted();
}

// Open registration: an explicit ALLOW_REGISTRATION wins; otherwise it is
// derived from the host mode (cloud → open, self → closed).
export function registrationOpen(): boolean {
  return env.ALLOW_REGISTRATION ?? isCloud();
}
```

- [ ] **Step 4: Repoint importers, delete old file.** Update every `isBillingEnabled` import to the new path, then delete `billing-flags.ts`:

```bash
# stripe-billing.ts imports from "./billing-flags"; routes import from a relative path.
grep -rl "billing-flags" apps/api/src
# In each hit, change the import source from ".../billing-flags" to ".../host-mode"
# (same filename depth — only the basename changes). E.g.:
#   import { isBillingEnabled } from "./billing-flags";        -> "./host-mode"
#   import { isBillingEnabled } from "../../../lib/billing-flags"; -> "../../../lib/host-mode"
rm apps/api/src/lib/billing-flags.ts
```

Apply the import edits with your editor (do not leave any reference to `billing-flags`). Verify none remain:

```bash
grep -rn "billing-flags" apps/api/src || echo "clean"
```

- [ ] **Step 5: Run the test — passes.**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/host-mode.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Migrate billing tests that assumed the old default.** Billing routes now return their disabled response when `HOST_MODE !== "cloud"`, and the default is `self`. Find tests that set `BILLING_ENABLED` or rely on billing being active:

```bash
grep -rn "BILLING_ENABLED" apps/api/src
```

For each: replace `env.BILLING_ENABLED = true` with `env.HOST_MODE = "cloud"`, and `env.BILLING_ENABLED = false` with `env.HOST_MODE = "self"` (and restore in teardown). Run the billing suites:

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/dashboard/billing src/routes/billing src/lib/stripe-billing`
Expected: PASS (or pre-existing-red only — compare against `git stash` baseline if unsure).

- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/lib/host-mode.ts apps/api/src/lib/host-mode.test.ts apps/api/src
git rm apps/api/src/lib/billing-flags.ts
git commit -m "refactor(api): fold billing-flags into host-mode helper; billing is cloud-only"
```

---

## Task 3: DB helpers — countUsers + global pending-invite finder

**Files:**
- Create: `packages/db/src/drizzle/repositories/users.ts`
- Modify: `packages/db/src/drizzle/repositories/invitations.ts`
- Modify: `packages/db/src/drizzle/index.ts`
- Test: `packages/db/src/drizzle/repositories/registration-gate-helpers.integration.test.ts`

**Interfaces:**
- Produces: `userRepo.countUsers(db): Promise<number>`; `invitationRepo.findAnyPendingInvitationByEmail(db, email): Promise<ProjectInvitation | null>` (pending = not accepted, not revoked, not expired; matches across ALL projects).

- [ ] **Step 1: Write the failing integration test.** Create `packages/db/src/drizzle/repositories/registration-gate-helpers.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../../test/pg-testcontainer"; // existing helper; adjust path if different
import { countUsers } from "./users";
import { findAnyPendingInvitationByEmail, createInvitation } from "./invitations";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { ctx = await createTestDb(); });
afterAll(async () => { await ctx.teardown(); });

describe("registration gate DB helpers", () => {
  it("countUsers reflects inserted users", async () => {
    expect(await countUsers(ctx.db)).toBe(0);
    // seed one user + project via the test's existing seed helpers
    const { userId, projectId } = await ctx.seedUserAndProject();
    expect(await countUsers(ctx.db)).toBe(1);

    // a fresh pending invite for a new email is found
    await createInvitation(ctx.db, {
      projectId,
      email: "invitee@example.com",
      role: "DEVELOPER",
      tokenHash: "hash-1",
      invitedByUserId: userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(await findAnyPendingInvitationByEmail(ctx.db, "INVITEE@example.com")).not.toBeNull();
    expect(await findAnyPendingInvitationByEmail(ctx.db, "nobody@example.com")).toBeNull();
  });
});
```

> If the repo lacks `createTestDb` / `seedUserAndProject` helpers, follow the pattern in a neighbouring `*.integration.test.ts` under `packages/db` (testcontainers Postgres + `pnpm db:migrate`). Keep the assertions identical.

- [ ] **Step 2: Run it — fails (countUsers + finder missing).**

Run: `pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/registration-gate-helpers.integration.test.ts`
Expected: FAIL — `countUsers` / `findAnyPendingInvitationByEmail` not exported.

- [ ] **Step 3: Add the users repo.** Create `packages/db/src/drizzle/repositories/users.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { user } from "../schema";

// Total registered users. Used by the registration gate to detect the
// founding (first) user.
export async function countUsers(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(user);
  return rows[0]?.n ?? 0;
}
```

- [ ] **Step 4: Add the global pending-invite finder.** In `packages/db/src/drizzle/repositories/invitations.ts`, add `gt` to the drizzle-orm import (line 1 becomes `import { and, desc, eq, gt, gte, isNull, or, sql } from "drizzle-orm";`) and append after `findPendingInvitationByEmail` (line 93):

```ts
// Project-agnostic pending invite lookup used by the registration gate:
// any non-accepted, non-revoked, unexpired invitation for this email.
export async function findAnyPendingInvitationByEmail(
  db: Db,
  email: string,
): Promise<ProjectInvitation | null> {
  const rows = await db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.email, email.toLowerCase()),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
        gt(projectInvitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 5: Export the users repo.** In `packages/db/src/drizzle/index.ts`, add next to the other `export * as` lines (e.g. after line 38 `userPreferencesRepo`):

```ts
export * as userRepo from "./repositories/users";
```

- [ ] **Step 6: Run the test — passes.**

Run: `pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/registration-gate-helpers.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/db/src/drizzle/repositories/users.ts packages/db/src/drizzle/repositories/invitations.ts packages/db/src/drizzle/index.ts packages/db/src/drizzle/repositories/registration-gate-helpers.integration.test.ts
git commit -m "feat(db): countUsers + global pending-invite finder for registration gate"
```

---

## Task 4: Registration gate decision + Better Auth user.create hook

**Files:**
- Create: `apps/api/src/lib/registration-gate.ts`
- Create: `apps/api/src/lib/registration-gate.test.ts`
- Modify: `apps/api/src/lib/auth.ts`
- Test: `apps/api/src/lib/auth-registration-gate.integration.test.ts`

**Interfaces:**
- Consumes: `userRepo.countUsers`, `invitationRepo.findAnyPendingInvitationByEmail` (Task 3); `registrationOpen()` (Task 2).
- Produces: `isRegistrationAllowed(input: { userCount: number; registrationOpen: boolean; hasPendingInvite: boolean }): boolean`.

- [ ] **Step 1: Write the failing unit test.** Create `apps/api/src/lib/registration-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRegistrationAllowed } from "./registration-gate";

describe("isRegistrationAllowed", () => {
  it("allows the very first user regardless of policy", () => {
    expect(isRegistrationAllowed({ userCount: 0, registrationOpen: false, hasPendingInvite: false })).toBe(true);
  });
  it("allows anyone when registration is open", () => {
    expect(isRegistrationAllowed({ userCount: 5, registrationOpen: true, hasPendingInvite: false })).toBe(true);
  });
  it("allows an invited user when registration is closed", () => {
    expect(isRegistrationAllowed({ userCount: 5, registrationOpen: false, hasPendingInvite: true })).toBe(true);
  });
  it("rejects an uninvited user when registration is closed", () => {
    expect(isRegistrationAllowed({ userCount: 5, registrationOpen: false, hasPendingInvite: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — fails (module missing).**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/registration-gate.test.ts`
Expected: FAIL — cannot resolve `./registration-gate`.

- [ ] **Step 3: Create the decision function.** Create `apps/api/src/lib/registration-gate.ts`:

```ts
export interface RegistrationGateInput {
  /** Total existing users before this creation. */
  userCount: number;
  /** Whether open self-service registration is currently allowed. */
  registrationOpen: boolean;
  /** Whether a pending invitation exists for the signup email. */
  hasPendingInvite: boolean;
}

// The first user always bootstraps the instance. After that, a new account
// is allowed only when open registration is on, or the signup is backed by a
// pending invitation.
export function isRegistrationAllowed(input: RegistrationGateInput): boolean {
  if (input.userCount === 0) return true;
  if (input.registrationOpen) return true;
  return input.hasPendingInvite;
}
```

- [ ] **Step 4: Run the unit test — passes.**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/registration-gate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the Better Auth hook.** In `apps/api/src/lib/auth.ts`:

Add imports near the top (after line 9):

```ts
import { APIError } from "better-auth/api";
import { registrationOpen } from "./host-mode";
import { isRegistrationAllowed } from "./registration-gate";
```

Add a `databaseHooks` property to the `betterAuth({ ... })` config object (place it right after `secret: env.BETTER_AUTH_SECRET,` at line 186):

```ts
  databaseHooks: {
    user: {
      create: {
        // Gate account creation. Runs for every new user (OAuth callback and
        // dev email/password). Existing users sign in without hitting this.
        before: async (newUser: { email?: string }) => {
          const email = (newUser.email ?? "").toLowerCase();
          const userCount = await drizzle.userRepo.countUsers(drizzle.db);
          const hasPendingInvite = email
            ? Boolean(
                await drizzle.invitationRepo.findAnyPendingInvitationByEmail(
                  drizzle.db,
                  email,
                ),
              )
            : false;

          if (
            !isRegistrationAllowed({
              userCount,
              registrationOpen: registrationOpen(),
              hasPendingInvite,
            })
          ) {
            log.warn("registration_blocked", { email });
            throw new APIError("FORBIDDEN", {
              code: "REGISTRATION_CLOSED",
              message: "registration_closed",
            });
          }
        },
      },
    },
  },
```

- [ ] **Step 6: Write the failing integration test.** Email/password signup is enabled outside production, so it exercises the hook directly. Create `apps/api/src/lib/auth-registration-gate.integration.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "./env";
import { auth } from "./auth";
import { drizzle } from "@rovenue/db";
// Reuse the API package's testcontainer bootstrap (see neighbouring
// *.integration.test.ts for the exact helper + migrate call).
import { startApiTestDb, seedInvitation } from "../../test/db"; // adjust to actual helper

beforeAll(async () => { await startApiTestDb(); });
afterAll(async () => { /* teardown per existing pattern */ });

const origMode = env.HOST_MODE;
const origAllow = env.ALLOW_REGISTRATION;
afterEach(async () => {
  env.HOST_MODE = origMode;
  env.ALLOW_REGISTRATION = origAllow;
  // truncate user/project_invitations between cases per existing test helper
});

async function signUp(email: string) {
  return auth.api.signUpEmail({
    body: { email, password: "password123", name: email.split("@")[0]! },
  });
}

describe("registration gate (user.create hook)", () => {
  it("allows the first user even when registration is closed", async () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = undefined;
    await expect(signUp("founder@example.com")).resolves.toBeTruthy();
    expect(await drizzle.userRepo.countUsers(drizzle.db)).toBe(1);
  });

  it("blocks a second uninvited user when closed", async () => {
    env.HOST_MODE = "self";
    await signUp("founder@example.com");
    await expect(signUp("stranger@example.com")).rejects.toThrow(/registration_closed/);
  });

  it("allows a second user when open (cloud)", async () => {
    env.HOST_MODE = "cloud";
    await signUp("founder@example.com");
    await expect(signUp("second@example.com")).resolves.toBeTruthy();
  });

  it("allows a second user when closed but invited", async () => {
    env.HOST_MODE = "self";
    await signUp("founder@example.com");
    await seedInvitation({ email: "invited@example.com" }); // pending, unexpired
    await expect(signUp("invited@example.com")).resolves.toBeTruthy();
  });
});
```

> Adjust `startApiTestDb` / `seedInvitation` / truncation to the API package's actual integration-test harness (mirror the closest existing `*.integration.test.ts`). The four behaviours under test must stay exactly as written.

- [ ] **Step 7: Run it — passes.**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/auth-registration-gate.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Verify the OAuth error surface.** Confirm Better Auth redirects a blocked OAuth callback to `errorCallbackURL` (`/login`) with the message in the query string. Inspect the redirect manually or in logs; note the exact param name (`error`) so Task 7's login banner reads it. (No code change here if it already lands on `/login?error=...`.)

- [ ] **Step 9: Commit.**

```bash
git add apps/api/src/lib/registration-gate.ts apps/api/src/lib/registration-gate.test.ts apps/api/src/lib/auth.ts apps/api/src/lib/auth-registration-gate.integration.test.ts
git commit -m "feat(api): gate user creation — first-user bootstrap + invite-only when registration closed"
```

---

## Task 5: Rovi quotas derive `unlimited` from host-mode

**Files:**
- Modify: `apps/api/src/services/copilot/quota.ts`
- Modify: `apps/api/src/middleware/rovi-quota-guard.ts`
- Modify: `apps/api/src/routes/dashboard/copilot/usage.ts`
- Test: `apps/api/src/services/copilot/quota.test.ts` (extend if present; else create)

**Interfaces:**
- Consumes: `quotasUnlimited()` (Task 2).
- Produces: `resolveTier(args: { project; env: { ROVI_TIER?: RoviTier }; unlimited: boolean }): { tier: RoviTier; unlimited: boolean }`.

- [ ] **Step 1: Write/extend the failing test.** Create or extend `apps/api/src/services/copilot/quota.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTier } from "./quota";

describe("resolveTier", () => {
  it("self-host (unlimited=true) → enterprise + unlimited", () => {
    expect(resolveTier({ project: { metadata: null }, env: {}, unlimited: true }))
      .toEqual({ tier: "enterprise", unlimited: true });
  });
  it("cloud (unlimited=false) → env tier, enforced", () => {
    expect(resolveTier({ project: { metadata: null }, env: { ROVI_TIER: "team" }, unlimited: false }))
      .toEqual({ tier: "team", unlimited: false });
  });
  it("cloud default tier is free when nothing set", () => {
    expect(resolveTier({ project: { metadata: null }, env: {}, unlimited: false }))
      .toEqual({ tier: "free", unlimited: false });
  });
  it("project metadata rovi_tier overrides env", () => {
    expect(resolveTier({ project: { metadata: { rovi_tier: "business" } }, env: { ROVI_TIER: "team" }, unlimited: false }))
      .toEqual({ tier: "business", unlimited: false });
  });
});
```

- [ ] **Step 2: Run it — fails (signature mismatch / unlimited arg unknown).**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/copilot/quota.test.ts`
Expected: FAIL — `resolveTier` does not accept `unlimited`.

- [ ] **Step 3: Update `resolveTier`.** Replace the function at `apps/api/src/services/copilot/quota.ts:37-45` with:

```ts
export function resolveTier(args: {
  project: { metadata?: Record<string, unknown> | null };
  env: { ROVI_TIER?: RoviTier };
  unlimited: boolean;
}): { tier: RoviTier; unlimited: boolean } {
  const metaTier = args.project.metadata?.["rovi_tier"] as RoviTier | undefined;
  const tier =
    metaTier ?? (args.unlimited ? "enterprise" : (args.env.ROVI_TIER ?? "free"));
  return { tier, unlimited: args.unlimited };
}
```

- [ ] **Step 4: Update both callers.** In `apps/api/src/middleware/rovi-quota-guard.ts` add `import { quotasUnlimited } from "../lib/host-mode";` and change the `resolveTier({...})` call (lines 18–21) to:

```ts
    const { tier, unlimited } = resolveTier({
      project: { metadata: project.settings as Record<string, unknown> | null },
      env,
      unlimited: quotasUnlimited(),
    });
```

In `apps/api/src/routes/dashboard/copilot/usage.ts` add `import { quotasUnlimited } from "../../../lib/host-mode";` and change the `resolveTier({...})` call (lines 21–24) to:

```ts
    const { tier, unlimited } = resolveTier({
      project: { metadata: project?.settings as Record<string, unknown> | null },
      env,
      unlimited: quotasUnlimited(),
    });
```

- [ ] **Step 5: Run the test — passes.**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/copilot/quota.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck the package.**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS (no remaining `ROVI_UNLIMITED` references). If any test sets `env.ROVI_UNLIMITED`, replace with `env.HOST_MODE = "self"`/`"cloud"`.

- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/services/copilot/quota.ts apps/api/src/services/copilot/quota.test.ts apps/api/src/middleware/rovi-quota-guard.ts apps/api/src/routes/dashboard/copilot/usage.ts
git commit -m "feat(api): derive Rovi unlimited from HOST_MODE (self → unlimited)"
```

---

## Task 6: Rovi BYOK key entry is self-host-only

**Files:**
- Modify: `apps/api/src/routes/dashboard/copilot/credentials.ts`
- Test: `apps/api/src/routes/dashboard/copilot/credentials-byok-guard.integration.test.ts` (or extend existing credentials test)

**Interfaces:**
- Consumes: `isByokAllowed()` (Task 2).

- [ ] **Step 1: Write the failing test.** Create `apps/api/src/routes/dashboard/copilot/credentials-byok-guard.integration.test.ts` (mirror the harness of the existing copilot credentials/quota integration tests for app bootstrap + an OWNER session):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../../../lib/env";
// import the test app + an authenticated OWNER request helper from the
// existing copilot integration test harness.

const orig = env.HOST_MODE;
afterEach(() => { env.HOST_MODE = orig; });

describe("BYOK credentials guard", () => {
  it("PUT credentials is rejected in cloud mode", async () => {
    env.HOST_MODE = "cloud";
    const res = await ownerPut(`/dashboard/projects/${projectId}/copilot/credentials`, {
      provider: "openai", apiKey: "sk-x", defaultModel: "gpt-4o-mini",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("byok_not_allowed");
  });

  it("PUT credentials succeeds in self mode", async () => {
    env.HOST_MODE = "self";
    const res = await ownerPut(`/dashboard/projects/${projectId}/copilot/credentials`, {
      provider: "openai", apiKey: "sk-x", defaultModel: "gpt-4o-mini",
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it — fails (cloud PUT currently returns 200).**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/dashboard/copilot/credentials-byok-guard.integration.test.ts`
Expected: FAIL — cloud PUT not yet guarded.

- [ ] **Step 3: Add the guard.** In `apps/api/src/routes/dashboard/copilot/credentials.ts` add `import { isByokAllowed } from "../../../lib/host-mode";` (next to the `env` import at line 14). Then add this guard as the first line inside BOTH the `.put("/", ...)` handler (after line 50) and the `.post("/test", ...)` handler (after line 78):

```ts
    if (!isByokAllowed()) {
      throw new HTTPException(403, {
        message: "byok_not_allowed",
        res: c.json(
          { error: { code: "byok_not_allowed", message: "Adding an AI provider key is only available on self-hosted instances" } },
          403,
        ),
      });
    }
```

> If the project's error envelope is produced by a shared error handler keyed on a thrown app error rather than `HTTPException` with `res`, follow that pattern instead — the response body MUST be `{ error: { code: "byok_not_allowed", message } }` with status 403.

- [ ] **Step 4: Run the test — passes.**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/dashboard/copilot/credentials-byok-guard.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/routes/dashboard/copilot/credentials.ts apps/api/src/routes/dashboard/copilot/credentials-byok-guard.integration.test.ts
git commit -m "feat(api): restrict Rovi BYOK key entry to self-host (HOST_MODE=self)"
```

---

## Task 7: Dashboard — host-mode helper, billing UI hide, login banner, BYOK gating

**Files:**
- Create: `apps/dashboard/src/lib/host-mode.ts`
- Create: `apps/dashboard/src/lib/host-mode.test.ts`
- Modify: `apps/dashboard/src/components/dashboard/topbar.tsx`
- Modify: `apps/dashboard/src/routes/login.tsx`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/rovi.tsx`
- Modify: `apps/dashboard/src/components/rovi/rovi-missing-config.tsx`

**Interfaces:**
- Produces (module constants): `isSelfHosted`, `isCloud`, `billingEnabled`, `byokAllowed`, `registrationOpen` — all `boolean`, computed once from build-time env.

- [ ] **Step 1: Write the failing helper test.** Create `apps/dashboard/src/lib/host-mode.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

describe("dashboard host-mode helper", () => {
  it("defaults to self-hosted when VITE_HOST_MODE is unset", async () => {
    vi.stubEnv("VITE_HOST_MODE", "");
    vi.stubEnv("VITE_ALLOW_REGISTRATION", "");
    const m = await import("./host-mode?case=self");
    expect(m.isSelfHosted).toBe(true);
    expect(m.billingEnabled).toBe(false);
    expect(m.byokAllowed).toBe(true);
    expect(m.registrationOpen).toBe(false);
  });
});
```

> Module-level constants are evaluated at import time; if `vi.stubEnv` + cache-busting query import is awkward in this repo's vitest config, instead export a small `computeHostMode(env)` pure function and test that, with the constants derived from `import.meta.env`. Pick whichever matches existing dashboard test patterns; keep the asserted values identical.

- [ ] **Step 2: Run it — fails (module missing).**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/lib/host-mode.test.ts`
Expected: FAIL — cannot resolve `./host-mode`.

- [ ] **Step 3: Create the dashboard helper.** Create `apps/dashboard/src/lib/host-mode.ts`:

```ts
// Build-time deployment-mode flags, mirrored from the API's HOST_MODE.
// Self-hosters set VITE_HOST_MODE=self (the default) at image build time.
const HOST_MODE = (import.meta.env.VITE_HOST_MODE as string | undefined) ?? "self";
const ALLOW_REGISTRATION_RAW = import.meta.env.VITE_ALLOW_REGISTRATION as
  | string
  | undefined;

export const isCloud = HOST_MODE === "cloud";
export const isSelfHosted = !isCloud;
export const billingEnabled = isCloud;
export const byokAllowed = isSelfHosted;
export const registrationOpen =
  ALLOW_REGISTRATION_RAW === undefined || ALLOW_REGISTRATION_RAW === ""
    ? isCloud
    : ALLOW_REGISTRATION_RAW === "true";
```

- [ ] **Step 4: Run the helper test — passes.**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/lib/host-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Point the topbar at the helper.** In `apps/dashboard/src/components/dashboard/topbar.tsx`, remove line 7 (`const IS_SELF_HOSTED = import.meta.env.VITE_SELF_HOSTED === "true";`) and add to the imports at the top:

```ts
import { isSelfHosted as IS_SELF_HOSTED } from "../../lib/host-mode";
```

(The existing `{IS_SELF_HOSTED && (...)}` GitHub-link block at lines 63–76 is unchanged.)

- [ ] **Step 6: Add the invite-only banner to login.** In `apps/dashboard/src/routes/login.tsx` add to the imports:

```ts
import { registrationOpen } from "../lib/host-mode";
```

Then, inside the `!submitted` branch, immediately after the existing `{error && (...)}` block (after line 83), add:

```tsx
                {!registrationOpen && (
                  <div role="status" className="si-error" style={{ color: "#A1A1AA" }}>
                    {t("auth.signIn.inviteOnly")}
                  </div>
                )}
```

Add the i18n key `auth.signIn.inviteOnly` = "New accounts are invite-only on this instance. Sign in if you already have an account, or ask a project owner to invite you." to the dashboard locale files (mirror where `auth.signIn.tagline` is defined).

- [ ] **Step 7: Gate the Rovi BYOK key entry UI.** Read `apps/dashboard/src/routes/_authed/projects/$projectId/settings/rovi.tsx`, then:
  - Add `import { byokAllowed } from "../../../../../lib/host-mode";` (fix the relative depth to reach `src/lib`).
  - Wrap the provider/API-key/test form section in `{byokAllowed && ( ... )}`.
  - When `!byokAllowed`, render an informational note instead: "AI is managed on Rovenue Cloud — no provider key needed."

  Likewise in `apps/dashboard/src/components/rovi/rovi-missing-config.tsx`, only render the "Add a provider API key" CTA / link when `byokAllowed`; otherwise show the managed-AI note.

- [ ] **Step 8: Typecheck + build the dashboard.**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard build`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add apps/dashboard/src/lib/host-mode.ts apps/dashboard/src/lib/host-mode.test.ts apps/dashboard/src/components/dashboard/topbar.tsx apps/dashboard/src/routes/login.tsx apps/dashboard/src/routes/_authed/projects/\$projectId/settings/rovi.tsx apps/dashboard/src/components/rovi/rovi-missing-config.tsx
# include locale files touched in Step 6
git commit -m "feat(dashboard): HOST_MODE-aware UI — hide billing/BYOK, invite-only login banner"
```

---

## Task 8: `.env.example` documentation

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the Deployment-mode section.** In `.env.example`, after line 19 of the Server block (or near the top, before the Dashboard section), insert:

```
# ---- Deployment mode ---------------------------------------------------
# "self"  = self-hosted single tenant: no billing, Rovi unlimited + BYOK,
#           registration closed after the first user (invite-only).
# "cloud" = managed cloud: Stripe billing, Rovi tier quotas, open signup.
HOST_MODE=self
# Override open-registration. Unset = derived from HOST_MODE
# (self -> false, cloud -> true). "true" lets anyone sign up.
# ALLOW_REGISTRATION=
```

- [ ] **Step 2: Update the Dashboard (Vite client) block** (lines 120–123). Replace with:

```
# ---- Dashboard (Vite client) -------------------------------------------
# Build-time mirror of HOST_MODE for the dashboard image. "self" surfaces
# the GitHub link + BYOK key entry and shows the invite-only login banner;
# "cloud" shows billing UI. Must match the API's HOST_MODE.
VITE_HOST_MODE=self
# Optional: mirror of ALLOW_REGISTRATION for the login banner. Unset =
# derived from VITE_HOST_MODE.
# VITE_ALLOW_REGISTRATION=
```

- [ ] **Step 3: Update the Billing block** (lines 143–148). Replace the comment + `BILLING_ENABLED=false` line with:

```
# ---- Billing (Stripe) — cloud only -------------------------------------
# Active only when HOST_MODE=cloud. In production with HOST_MODE=cloud the
# secret key, webhook secret, and Indie monthly price id are required.
```

(Keep the `STRIPE_BILLING_*` lines; update the line-152 comment "Required when BILLING_ENABLED=true." → "Required when HOST_MODE=cloud.")

- [ ] **Step 4: Update the Rovi block** (lines 193–198). Replace through `ROVI_UNLIMITED=true` / `# ROVI_TIER=...` with:

```
# ---- Rovi (AI copilot) ------------------------------------------------
# Tier quotas apply only when HOST_MODE=cloud; self-host is unlimited and
# uses bring-your-own provider keys (set per project in the dashboard).
# ROVI_TIER sets the cloud default tier when projects.metadata has no
# rovi_tier override.
# ROVI_TIER=free|team|business|enterprise
```

- [ ] **Step 5: Verify no stale flags remain.**

Run: `grep -n "BILLING_ENABLED\|ROVI_UNLIMITED\|VITE_SELF_HOSTED" .env.example || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Commit.**

```bash
git add .env.example
git commit -m "docs(env): document HOST_MODE/ALLOW_REGISTRATION; drop BILLING_ENABLED/ROVI_UNLIMITED"
```

---

## Final verification

- [ ] **API typecheck + unit/integration tests:**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit && pnpm --filter @rovenue/api test`
Expected: PASS (allowing only the documented pre-existing-red integrations from project memory).

- [ ] **DB package tests:**

Run: `pnpm --filter @rovenue/db test`
Expected: PASS.

- [ ] **Full build (clean) — catches lockfile/type drift:**

Run: `rm -rf node_modules && pnpm install --frozen-lockfile && pnpm build --force`
Expected: all packages build (8/8 per project memory).

- [ ] **Grep sweep — no dangling references anywhere:**

Run: `grep -rn "BILLING_ENABLED\|ROVI_UNLIMITED\|billing-flags\|VITE_SELF_HOSTED" apps packages .env.example || echo "clean"`
Expected: `clean`.

---

## Self-review notes (author)

- **Spec coverage:** §1 env→Task 1; §2 helper→Task 2; §3 gate→Tasks 3+4; §4 billing/Rovi/BYOK→Tasks 2/5/6; §5 dashboard→Task 7; §6 .env.example→Task 8; §"Testing"→tests embedded per task + Final verification. Flag removal (`BILLING_ENABLED`,`ROVI_UNLIMITED`) covered in Tasks 1/2/5 + final grep.
- **Type consistency:** `isRegistrationAllowed` input shape identical in Task 4 def, unit test, and the auth-hook call. `resolveTier` new arg `unlimited: boolean` matches both callers (Task 5). Helper fn names (`registrationOpen`, `quotasUnlimited`, `isByokAllowed`, `isBillingEnabled`) identical across API helper, importers, and tests.
- **Known soft spots flagged inline:** exact testcontainer/seed helper names (Tasks 3/4/6) and the dashboard env-stub test mechanism (Task 7) defer to the repo's existing patterns; asserted behaviours are fixed. The OAuth error→`/login?error=` param is verified in Task 4 Step 8 before the login banner relies on it.
