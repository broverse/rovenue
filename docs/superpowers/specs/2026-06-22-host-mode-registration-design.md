# HOST_MODE deployment switch + registration gating

**Date:** 2026-06-22
**Status:** Approved (design)
**Author:** brainstormed with V. Furkan

## Summary

Introduce a single deployment-mode switch, `HOST_MODE` (`self` | `cloud`,
default `self`), as the one source of truth for whether a Rovenue instance is a
self-hosted single-tenant deployment or the managed cloud. Self-host has **no
billing and no feature limits**; cloud keeps billing, Rovi quota tiers, and open
registration.

Add a registration policy, `ALLOW_REGISTRATION`, whose default is derived from
`HOST_MODE` (`self` → closed, `cloud` → open). When registration is closed, only
the **first user** can sign up (bootstrapping the instance); after that, new
accounts can be created **only by accepting a project invitation**. Existing
users always sign in normally.

Remove the now-redundant `BILLING_ENABLED` and `ROVI_UNLIMITED` env vars; both
behaviors fold into `HOST_MODE`.

## Goals

- One env var (`HOST_MODE`) decides self vs cloud; no scattered flags.
- Self-host: billing disabled, Rovi unlimited, bring-your-own-key (BYOK) enabled,
  registration closed after the first user (invite-only thereafter).
- Cloud: billing on (Stripe), Rovi tier quotas enforced, operator-funded AI, open
  registration.
- Fail safe for `docker compose up` users: the default (`self`) never exposes
  billing or open registration.

## Non-goals

- No global super-admin / account-admin role. The first user is simply the
  founding account and owns whatever project they create; project-level roles and
  the existing `members:manage` capability govern who can invite.
- No new public/runtime config endpoint. The dashboard reads mode from build-time
  `VITE_*` vars (a published image is built per mode, consistent with today's
  `VITE_SELF_HOSTED`).
- No change to the project-invitation data model or the invite-acceptance UX.

## Decisions (locked during brainstorming)

1. **`ALLOW_REGISTRATION` semantics — derived default + override.**
   `registrationOpen = ALLOW_REGISTRATION ?? (HOST_MODE === "cloud")`.
   - `false` → only the first user may register; afterwards open signup is
     blocked, invite-backed signup still works.
   - `true` → anyone may register via OAuth.
2. **`HOST_MODE=self` is a master override** for billing/limits — it does not
   merely change defaults; in self mode billing is off and quotas are unlimited
   unconditionally.
3. **Dashboard learns mode at build time** via `VITE_HOST_MODE` /
   `VITE_ALLOW_REGISTRATION` (no new API endpoint).
4. **`BILLING_ENABLED` and `ROVI_UNLIMITED` are removed**; billing and unlimited
   Rovi derive from `HOST_MODE`.
5. **Rovi BYOK (adding a provider key) is self-host-only.**
6. **`HOST_MODE` defaults to `self`.** The managed cloud sets `HOST_MODE=cloud`
   explicitly.

## Architecture

### 1. Env schema (`apps/api/src/lib/env.ts`)

Add:

```ts
HOST_MODE: z.enum(["self", "cloud"]).default("self"),
// optional: when unset, defaults are derived from HOST_MODE (see host-mode.ts).
ALLOW_REGISTRATION: z.enum(["true", "false"]).optional()
  .transform((v) => (v === undefined ? undefined : v === "true")),
```

Remove:
- `BILLING_ENABLED` (lines ~116–119).
- `ROVI_UNLIMITED` (lines ~170–174 region; keep `ROVI_TIER`).

`.superRefine` production validation:
- The Stripe-keys requirement (currently triggered by `BILLING_ENABLED === true`)
  now triggers on `HOST_MODE === "cloud"` in production: require
  `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`,
  `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID`.

Kept as-is: `STRIPE_BILLING_*`, `ROVI_TIER`, `ROVI_DEFAULT_*`,
`ROVI_RATE_LIMIT_PER_USER`, `ROVI_MESSAGE_RETENTION_DAYS`.

### 2. Resolved-mode helper (`apps/api/src/lib/host-mode.ts`)

Replace `apps/api/src/lib/billing-flags.ts` with a single module that all callers
read from. It is the only place that interprets `HOST_MODE`/`ALLOW_REGISTRATION`:

```ts
export const isCloud = () => env.HOST_MODE === "cloud";
export const isSelfHosted = () => env.HOST_MODE === "self";

// billing is cloud-only
export const isBillingEnabled = () => isCloud();
// self → unlimited Rovi
export const quotasUnlimited = () => isSelfHosted();
// adding a provider key (BYOK) is self-host-only
export const isByokAllowed = () => isSelfHosted();
// open signup: explicit ALLOW_REGISTRATION wins, else derived from mode
export const registrationOpen = () =>
  env.ALLOW_REGISTRATION ?? isCloud();
```

`billing-flags.ts` is deleted; its `isBillingEnabled` importers repoint to
`host-mode.ts` (re-export a shim only if churn is large, but prefer updating
imports).

### 3. Registration gate (`apps/api/src/lib/auth.ts`)

Add `databaseHooks.user.create.before` to the Better Auth config. It runs on
**every** user creation (OAuth callback and dev-only email/password) and decides
whether to allow it. Order:

1. **Bootstrap.** `SELECT COUNT(*) FROM "user"` — if `0`, allow. The first user
   founds the instance.
2. **Open.** If `registrationOpen()`, allow.
3. **Invited.** If a `project_invitations` row exists for `lower(email)` that is
   pending (`acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()`),
   allow. The existing dashboard `/invitations/:token` page then auto-accepts and
   links membership (no change needed there).
4. **Otherwise reject.** Throwing in the before-hook fails the OAuth callback;
   the dashboard surfaces it (see §5) via redirect to
   `/login?error=registration_closed`.

Properties:
- Fires only on **creation**, so existing users are never blocked at sign-in.
- The "invited" signal is email-match against `project_invitations`, the same
  email equality the accept endpoint already enforces
  (`inv.email === user.email`, case-insensitive).
- No new endpoint, no global admin role.

The count + invite lookup use existing Drizzle repositories (add a
`countUsers()` and a `findPendingInvitationByEmail(email)` helper if not already
present). Both run inside the hook against the request's connection.

### 4. Billing / Rovi wiring

- **Billing routes** (`routes/dashboard/.../billing/*`, `routes/billing/webhook.ts`)
  keep calling `isBillingEnabled()` — now `=== isCloud()`. In self mode they
  return their existing "disabled" response (404), and `getPlatformStripe()`
  returns `null` so Stripe never initializes.
- **Rovi quotas** (`services/copilot/quota.ts:resolveTier`): replace
  `args.env.ROVI_UNLIMITED` reads with `quotasUnlimited()`. Logic becomes:
  `tier = metaTier ?? (quotasUnlimited() ? "enterprise" : (env.ROVI_TIER ?? "free"))`;
  `unlimited = quotasUnlimited()`.
- **Rovi BYOK** (`routes/dashboard/copilot/credentials.ts`): `PUT` and
  `POST .../test` reject with `403` (`{ error: { code: "byok_not_allowed" } }`)
  when `!isByokAllowed()`. `GET` (masked credential status) stays readable so the
  UI can render state. Cloud projects rely on operator-funded `ROVI_DEFAULT_*`.

### 5. Dashboard (`apps/dashboard`)

Build-time config helper reading `import.meta.env.VITE_HOST_MODE` (default
`"self"`) and `VITE_ALLOW_REGISTRATION`. Centralize into a small
`src/lib/host-mode.ts` (mirror of the API helper's booleans) and replace the
ad-hoc `IS_SELF_HOSTED` constant in `components/dashboard/topbar.tsx`.

- **Billing UI** (billing/upgrade/plan pages, nav entries, upgrade prompts) is
  hidden when `hostMode === "self"`.
- **Rovi settings** (`routes/_authed/projects/$projectId/settings/rovi.tsx`): the
  key-entry form is shown only in self mode; in cloud, show a brief "managed AI"
  note instead of the BYOK form. `rovi-missing-config.tsx` only links to the key
  page in self mode.
- **Login page** (`routes/login.tsx`): when registration is not open, show
  "Registration is closed — ask a project owner for an invite" copy, and render
  the `registration_closed` error returned via the OAuth `errorCallbackURL`.
  (OAuth's sign-in button doubles as sign-up, so there is no separate register
  button to hide; the first-user bootstrap is enforced server-side regardless of
  what the client shows.)
- **Invite page** (`routes/invitations.$token.tsx`): unchanged — it already
  drives anonymous → OAuth signup → auto-accept for invited users.

### 6. `.env.example`

- New "Deployment mode" section near the top:
  ```
  # ---- Deployment mode -------------------------------------------------
  # "self"  = self-hosted single tenant: no billing, Rovi unlimited + BYOK,
  #           registration closed after the first user (invite-only).
  # "cloud" = managed cloud: Stripe billing, Rovi tier quotas, open signup.
  HOST_MODE=self
  # Override open-registration policy. Unset = derived from HOST_MODE
  # (self -> false, cloud -> true). true = anyone may sign up.
  # ALLOW_REGISTRATION=
  ```
- Dashboard (Vite) section: add `VITE_HOST_MODE=self` and
  `# VITE_ALLOW_REGISTRATION=`.
- Remove the `BILLING_ENABLED` line and the `ROVI_UNLIMITED` line; annotate the
  remaining `STRIPE_BILLING_*` block as "cloud only" and the `ROVI_TIER` line as
  "cloud only".

## Data flow

```
OAuth callback (new email) ──▶ Better Auth user.create.before hook
  ├─ users == 0?                         ──▶ allow (founding user)
  ├─ registrationOpen()?                 ──▶ allow
  ├─ pending invite for lower(email)?    ──▶ allow ─▶ /invitations/:token auto-accepts ─▶ project_members
  └─ else                                ──▶ throw ─▶ callback fails ─▶ /login?error=registration_closed

existing email ──▶ no creation ──▶ hook not invoked ──▶ normal sign-in
```

## Error handling

- Gate rejection: throw a typed error in the hook; map to the OAuth
  `errorCallbackURL` so the dashboard shows `registration_closed`. Do not leak
  whether an email exists.
- BYOK in cloud: `403 { error: { code: "byok_not_allowed", message } }`.
- Billing in self: existing disabled-billing response (404) is preserved.
- Env: in production, `HOST_MODE=cloud` without the required Stripe keys fails
  `superRefine` at boot (fast, explicit).

## Testing

**Unit**
- `host-mode.ts` resolution matrix: `{self, cloud} × {ALLOW_REGISTRATION unset,
  true, false}` → expected `registrationOpen / isBillingEnabled / quotasUnlimited
  / isByokAllowed`.
- `resolveTier`: self → `{tier: enterprise, unlimited: true}`; cloud → tier from
  metadata ?? `ROVI_TIER` ?? `free`, `unlimited: false`.

**Integration (testcontainers Postgres)**
- First user: created on empty `user` table regardless of mode → allowed.
- Open mode (`cloud` / `ALLOW_REGISTRATION=true`): second new user allowed.
- Closed mode (`self`): second new user with **no** invite → rejected.
- Closed mode: second new user **with** a pending invite (email match) → allowed;
  expired/revoked invite → rejected.
- Existing user sign-in in closed mode → never blocked (hook not invoked).
- BYOK: `PUT credentials` returns 403 in cloud, succeeds in self.
- Billing route returns disabled-response in self, live in cloud.

**Test migration (from flag removal)**
- Tests that set `BILLING_ENABLED=true` → set `HOST_MODE=cloud`.
- Tests asserting "billing 404 when disabled" → set `HOST_MODE=self`.
- Tests setting `ROVI_UNLIMITED` → set `HOST_MODE` accordingly.
- Integration tests mutate `env` per the project convention (the CH/service
  clients read frozen env parsed at import; follow existing
  `mutate env` pattern).

## Migration / rollout notes

- No DB migration required (no schema change; reuses `user` and
  `project_invitations`).
- Breaking env change for existing deployments: anyone currently relying on
  `BILLING_ENABLED=true` must set `HOST_MODE=cloud`; anyone on
  `ROVI_UNLIMITED=true` is now covered by the default `HOST_MODE=self`. Document
  in the changelog / upgrade notes.
- Default `self` means a fresh `docker compose up` instance is invite-only after
  the first sign-in — call this out in deploy docs so operators expect it.

## Open questions

None. (Resolved: default mode, flag removal, BYOK scope, registration semantics,
config delivery, no global admin.)
