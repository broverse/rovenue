# Project Members + Invite Flow — Design

**Date:** 2026-05-26
**Author:** Rovenue team
**Status:** Draft (pending implementation plan)

## Goals

1. Replace the `MemberRole` enum (`OWNER / ADMIN / VIEWER`) with the five-role
   model the team actually needs: `OWNER, ADMIN, DEVELOPER, GROWTH,
   CUSTOMER_SUPPORT`. Existing `VIEWER` rows migrate to
   `CUSTOMER_SUPPORT`. `OWNER` exists in the enum but is never directly
   assignable via the UI (it's the project creator, or it changes through
   ownership transfer).
2. Wire up the missing member-management API endpoints. The dashboard
   already calls `/dashboard/projects/:id/members` but no route exists yet.
3. Add an end-to-end invitation flow: an OWNER/ADMIN creates an invitation
   for an email address, the invitee receives an Amazon-SES-sent link,
   signs in with OAuth, and is automatically added to the project with
   the assigned role.
4. Ship the SES transport as a reusable mailer + bounce/complaint handler.
   Other flows (password reset, alerting) will reuse it.

## Non-goals

- Cross-organisation directory features (SSO groups, SCIM provisioning).
- Per-member feature-flag overrides.
- Custom role definitions. Roles are hardcoded.
- An audit row for `email_delivery_failed`. Logger-only.

## Architecture overview

```
Dashboard UI                API (Hono)                   AWS
────────────                ──────────                   ───
Members page  ───POST───►  /dashboard/projects/:id/      project_invitations
                            invitations  ──tx──┐         ┌─────────────────┐
                                                ▼         │ id              │
                                          insert row      │ tokenHash       │
                                                ▲         │ deliveryStatus  │
                            BullMQ email queue──┘         └─────────────────┘
                                  │
                                  ▼
                            mailer.send() ──► AWS SES ──► invitee inbox
                                                │
                                                ▼
                                       SNS bounce/complaint
                                                │
                            POST /webhooks/ses-events ──► patch invitation row

Invitee inbox ──link──► /invitations/:token landing
                            │
                            ▼ OAuth sign-in (Better Auth)
                            │
                            ▼ POST /invitations/:token/accept
                            │
                            ▼ tx: insert project_members + mark invitation accepted
                            │
                            ▼ redirect /projects/:projectId
```

The two new long-lived pieces are:

- A new `project_invitations` Postgres table.
- A new `apps/api/src/lib/mailer.ts` transport abstraction plus a
  template layer under `apps/api/src/lib/email-templates/`.

Both are designed to be reusable. The mailer doesn't know what an
invitation is; the invitation flow doesn't know what SES is.

## Roles & permissions

### Enum

```ts
// packages/db/src/drizzle/enums.ts
export const memberRole = pgEnum("MemberRole", [
  "OWNER",
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
]);
```

`packages/shared/src/dashboard.ts`:

```ts
export type MemberRoleName =
  | "OWNER"
  | "ADMIN"
  | "DEVELOPER"
  | "GROWTH"
  | "CUSTOMER_SUPPORT";

/** Roles a user can be invited or reassigned to via the UI. */
export const ASSIGNABLE_ROLES = [
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
] as const satisfies ReadonlyArray<MemberRoleName>;
```

### Capability matrix

| Capability                          | OWNER | ADMIN | DEVELOPER | GROWTH | CUSTOMER_SUPPORT |
|-------------------------------------|:-----:|:-----:|:---------:|:------:|:----------------:|
| Delete project                      |  ✓    |       |           |        |                  |
| Manage members (non-OWNER targets)  |  ✓    |  ✓    |           |        |                  |
| Transfer ownership                  |  ✓    |       |           |        |                  |
| Edit project settings, API keys     |  ✓    |  ✓    |           |        |                  |
| Products, SDK config, webhooks (W)  |  ✓    |  ✓    |  ✓        |        |                  |
| Experiments, feature flags (W)      |  ✓    |  ✓    |  ✓        |  ✓     |                  |
| Audiences, leaderboards (W)         |  ✓    |  ✓    |  ✓        |  ✓     |                  |
| Subscribers, credits, refunds (W)   |  ✓    |  ✓    |  ✓        |        |  ✓               |
| Read everything in the project      |  ✓    |  ✓    |  ✓        |  ✓     |  ✓               |

The matrix is encoded in `apps/api/src/lib/project-access.ts`. The
existing `assertProjectAccess(projectId, userId, minRole)` helper is
replaced by a capability-based check:

```ts
// New API:
assertProjectCapability(projectId, userId, "members:manage");
assertProjectCapability(projectId, userId, "subscribers:write");

// Internally:
const CAPABILITY_ROLES: Record<Capability, ReadonlyArray<MemberRoleName>> = {
  "project:delete":       ["OWNER"],
  "project:transfer":     ["OWNER"],
  "project:settings:write": ["OWNER", "ADMIN"],
  "members:manage":       ["OWNER", "ADMIN"],
  "products:write":       ["OWNER", "ADMIN", "DEVELOPER"],
  "sdk:write":            ["OWNER", "ADMIN", "DEVELOPER"],
  "webhooks:write":       ["OWNER", "ADMIN", "DEVELOPER"],
  "experiments:write":    ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "flags:write":          ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "audiences:write":      ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "leaderboards:write":   ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "subscribers:write":    ["OWNER", "ADMIN", "DEVELOPER", "CUSTOMER_SUPPORT"],
  "credits:write":        ["OWNER", "ADMIN", "DEVELOPER", "CUSTOMER_SUPPORT"],
  "project:read":         ["OWNER", "ADMIN", "DEVELOPER", "GROWTH", "CUSTOMER_SUPPORT"],
};
```

The existing call sites that pass `MemberRole.VIEWER` for "any member can
read" become `assertProjectCapability(..., "project:read")`. Sites that
pass `MemberRole.ADMIN` map to the most specific capability available at
that route (e.g. `webhooks:write`, `flags:write`). A keep-it-simple
fallback: when the route is generic ("project admin actions"), use
`"project:settings:write"`.

## Schema

### Enum rewrite

Postgres can't drop enum values in place, so the migration follows the
canonical "swap the type" recipe in one transaction:

```sql
-- 0037_member_role_rewrite.sql

-- 1. Add new variants alongside the existing ones (these are immediate).
ALTER TYPE "MemberRole" ADD VALUE 'DEVELOPER';
ALTER TYPE "MemberRole" ADD VALUE 'GROWTH';
ALTER TYPE "MemberRole" ADD VALUE 'CUSTOMER_SUPPORT';

-- ADD VALUE cannot run inside a tx alongside other DDL that uses the
-- value. Drizzle migrations split DDL per file already; we run the
-- backfill + type swap in a second migration file.
```

```sql
-- 0038_member_role_drop_viewer.sql

BEGIN;

-- 2. Backfill: all existing VIEWERs become CUSTOMER_SUPPORT.
UPDATE project_members SET role = 'CUSTOMER_SUPPORT' WHERE role = 'VIEWER';

-- 3. Recreate enum without VIEWER.
CREATE TYPE "MemberRole_new" AS ENUM (
  'OWNER', 'ADMIN', 'DEVELOPER', 'GROWTH', 'CUSTOMER_SUPPORT'
);

ALTER TABLE project_members
  ALTER COLUMN role TYPE "MemberRole_new"
  USING role::text::"MemberRole_new";

DROP TYPE "MemberRole";
ALTER TYPE "MemberRole_new" RENAME TO "MemberRole";

COMMIT;
```

The schema regen via `pnpm db:migrate:generate` produces a no-op (the
generator can't infer the swap); the two files above are committed
by hand alongside the regen.

### `project_invitations` table

```ts
// packages/db/src/drizzle/schema.ts
export const invitationDeliveryStatus = pgEnum("InvitationDeliveryStatus", [
  "PENDING",
  "DELIVERED",
  "BOUNCED",
  "COMPLAINED",
  "SUPPRESSED",
]);

export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // always lowercased before insert
    role: memberRole("role").notNull(),
    tokenHash: text("tokenHash").notNull(), // sha256 hex of plaintext token
    invitedByUserId: text("invitedByUserId")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("acceptedAt", { withTimezone: true }),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    deliveryStatus: invitationDeliveryStatus("deliveryStatus")
      .notNull()
      .default("PENDING"),
    deliveryError: text("deliveryError"),
    lastSentAt: timestamp("lastSentAt", { withTimezone: true }),
    sesMessageId: text("sesMessageId"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Only one pending invite per (project, email). "Pending" means:
    // acceptedAt IS NULL AND revokedAt IS NULL.
    pendingUniq: uniqueIndex("project_invitations_pending_uniq")
      .on(t.projectId, t.email)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
    tokenHashUniq: uniqueIndex("project_invitations_token_hash_key").on(
      t.tokenHash,
    ),
    expiresAtIdx: index("project_invitations_expiresAt_idx").on(t.expiresAt),
    sesMessageIdIdx: index("project_invitations_sesMessageId_idx").on(
      t.sesMessageId,
    ),
    projectIdEmailIdx: index("project_invitations_projectId_email_idx").on(
      t.projectId,
      t.email,
    ),
  }),
);
```

`InvitationStatus` is derived in code, not stored:

```ts
type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

function statusOf(row: ProjectInvitation): InvitationStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= new Date()) return "expired";
  return "pending";
}
```

## API surface

All routes mounted under `apps/api/src/routes/dashboard/members.ts` and
`apps/api/src/routes/dashboard/invitations.ts` (new files). Public
acceptance routes live in `apps/api/src/routes/public/invitations.ts`.

### Member management

```
GET    /dashboard/projects/:id/members
       Auth: project:read
       → { members: ProjectMemberRow[] }

PATCH  /dashboard/projects/:id/members/:userId
       Auth: members:manage
       Body: { role: MemberRoleName }
       Rules:
         - role MUST NOT be OWNER (use the transfer endpoint).
         - Cannot modify an OWNER row.
         - Cannot change own role (self-lockout guard).
       Audit: member.role_changed { targetUserId, from, to }

DELETE /dashboard/projects/:id/members/:userId
       Auth: members:manage
       Rules:
         - Cannot remove an OWNER (transfer first).
         - Cannot remove self via this endpoint (use leave).
       Audit: member.removed { targetUserId, role }

POST   /dashboard/projects/:id/members/leave
       Auth: project:read  (caller is the target)
       Rules:
         - OWNER: 409 LAST_OWNER unless ≥ 1 other OWNER exists.
       Audit: member.left { userId, role }
       Response: { left: true }

POST   /dashboard/projects/:id/members/transfer
       Auth: project:transfer  (OWNER only)
       Body: { toUserId: string }
       Rules:
         - Target must already be a member of this project.
         - Target MUST NOT already be OWNER (409 ALREADY_OWNER).
         - toUserId !== caller.id (409 SELF_TRANSFER).
         - Atomic tx: target → OWNER, caller → ADMIN.
       Audit: member.ownership_transferred { fromUserId, toUserId }
```

### Invitations

```
GET    /dashboard/projects/:id/invitations
       Auth: members:manage
       Returns: pending invitations + invitations with terminal status
                (accepted/revoked/expired/bounced) created within last 30d.
       → { invitations: InvitationRow[] }

POST   /dashboard/projects/:id/invitations
       Auth: members:manage
       Body: { email: string, role: MemberRoleName }
       Validation:
         - role ∈ ASSIGNABLE_ROLES (i.e. not OWNER).
         - email is RFC 5322-ish via Zod; normalized to lowercase.
         - email !== caller.email.
       Behaviour:
         - 409 ALREADY_MEMBER if email matches an existing project_member.
         - If pending invitation exists for (projectId, email): mark it
           revoked and insert a new one in the SAME tx. Return
           201 with a header `X-Rovenue-Refreshed: true` so the UI can
           show "Existing invite replaced" toast.
       Response: 201 { invitation, inviteUrl }
                 inviteUrl is `${DASHBOARD_URL}/invitations/${plaintextToken}`
                 and is returned EXACTLY ONCE — never by GET.
       Side effects:
         - SES suppression pre-check (see Mailer / Cross-project
           suppression below). May immediately mark the new invitation
           SUPPRESSED, in which case no email is queued.
         - Otherwise enqueues BullMQ `email` job.
       Audit: invitation.created { email, role, invitationId }

DELETE /dashboard/projects/:id/invitations/:invitationId
       Auth: members:manage
       Sets revokedAt = now(). 404 if invitation belongs to another project.
       Audit: invitation.revoked { invitationId, email }

POST   /dashboard/projects/:id/invitations/:invitationId/resend
       Auth: members:manage
       Rules:
         - Must be pending.
         - Rate limit: 1 resend per 60s per invitation (Redis key
           `invite:resend:{invitationId}`).
       Uses the same tokenHash (the plaintext token is regenerated only
       by creating a new invitation). Enqueues a new email job.
       Audit: invitation.resent { invitationId }
       Response: { resent: true }
```

### Public acceptance

```
GET    /invitations/:token
       Public. Looks up by sha256(token).
       Returns minimal preview:
         { projectName, projectId, inviterName, role, email, status,
           expiresAt }
       Always returns 200 with the status field — never 404 unless the
       token format is malformed (so probing is harder).

POST   /invitations/:token/accept
       Requires Better Auth session.
       Validates:
         - Token matches a pending invitation.
         - lower(session.user.email) === lower(invitation.email).
       Atomic tx:
         - Look up project_members by (projectId, userId).
           - If exists: 409 ALREADY_MEMBER (admin can change role manually).
           - Else: insert project_members with invitation.role.
         - SET invitation.acceptedAt = now().
       Audit: invitation.accepted { invitationId, userId }
       Response: { projectId, role }
```

### Wire types

```ts
// packages/shared/src/dashboard.ts (additions)
export interface ProjectMemberRow {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: MemberRoleName;
  createdAt: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: MemberRoleName;
  status: "pending" | "accepted" | "revoked" | "expired";
  deliveryStatus:
    | "PENDING"
    | "DELIVERED"
    | "BOUNCED"
    | "COMPLAINED"
    | "SUPPRESSED";
  deliveryError: string | null;
  invitedByName: string | null;
  expiresAt: string;
  lastSentAt: string | null;
  createdAt: string;
}

export interface CreateInvitationRequest {
  email: string;
  role: Exclude<MemberRoleName, "OWNER">;
}

export interface CreateInvitationResponse {
  invitation: InvitationRow;
  /** Returned exactly once on create. Never returned by subsequent reads. */
  inviteUrl: string;
}

export interface InvitationPreviewResponse {
  projectId: string;
  projectName: string;
  inviterName: string | null;
  role: MemberRoleName;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
}
```

## Mailer infrastructure

### Transport (`apps/api/src/lib/mailer.ts`)

```ts
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  correlationId?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<{ messageId: string }>;
}
```

Two implementations:

- `SesMailer` — wraps `@aws-sdk/client-sesv2`'s `SendEmailCommand`.
  Reads region + from-address + (optional) configuration-set from env.
  AWS credentials come from the default SDK provider chain so IAM roles
  attached to EC2/ECS/Fargate work without explicit secret env vars.
- `NoopMailer` — used when `AWS_SES_FROM_EMAIL` is unset. Logs at warn
  level and returns a fake `messageId: "noop"`. Keeps local dev frictionless
  and ensures invitation creation never blocks on missing SES config.

A `__setMailerForTests(m)` export allows unit/integration tests to inject
a `RecordingMailer`.

### Templates (`apps/api/src/lib/email-templates/`)

```
base.ts          — shared HTML shell (header, body, footer). No env reads.
invitation.ts    — exports renderInvitationEmail(params) → { subject, html, text }
index.ts         — barrel.
```

Each template is a pure function. No SDK access. Trivially unit-testable
via snapshot tests on the returned `{ subject, html, text }`.

Template params for invitations:

```ts
renderInvitationEmail({
  inviterName: string;       // "Veyis Furkan Güner"
  projectName: string;
  role: MemberRoleName;
  inviteUrl: string;         // ${DASHBOARD_URL}/invitations/${plaintextToken}
  expiresAt: Date;
}): { subject: string; html: string; text: string }
```

### Async delivery (`apps/api/src/queues/email.ts`)

A new BullMQ queue `email` with a single job type today:

```ts
interface InvitationEmailJob {
  type: "invitation.send";
  invitationId: string;
}
```

The worker:

1. Loads the invitation by id. If not pending → no-op.
2. Loads project + inviter for template params.
3. Renders the template.
4. Calls `mailer().send(...)`.
5. Patches the invitation row: `lastSentAt = now()`, `sesMessageId = <response>`.

Retries: BullMQ default exponential backoff, 5 attempts. After
exhaustion: `logger.error` (no audit row, per scope decision).

Job ID = `inv-${invitationId}-${createdAtMs}` so resends produce a new
job rather than colliding with the original send.

### Cross-project SES suppression

Before enqueuing a send, the API checks whether the recipient email has
ever resulted in `deliveryStatus IN ('BOUNCED','COMPLAINED','SUPPRESSED')`
on a previous invitation, across all projects. If yes:

- The new invitation is created in the SAME tx with
  `deliveryStatus = 'SUPPRESSED'` and `deliveryError = 'cross-project
  suppression: prior <BOUNCED|COMPLAINED|SUPPRESSED>'`.
- No email job is enqueued.
- The API still returns `inviteUrl` (the inviter can still manually
  share the link).

Rationale: a single hard-bounced address that we keep emailing puts the
operator's entire SES sending domain at risk. The information leakage to
the inviter is minimal — they only learn that *this* invitation is
suppressed, not anything about other projects.

### SNS bounce/complaint webhook

```
POST /webhooks/ses-events
```

Handler in `apps/api/src/routes/webhooks/ses-events.ts`, parsing/dispatch
logic in `apps/api/src/lib/ses-events.ts` so the parser is testable
without Hono.

Behaviour:

- `SubscriptionConfirmation` payloads → fetch `SubscribeURL` once to
  confirm. (One-shot bootstrap.)
- `Notification` payloads — verify SNS signature (X.509 cert from
  `SigningCertURL`, host pinned to `*.amazonaws.com`, SHA-1 over the
  canonical string-to-sign), then patch the invitation:
  - Look up by `mail.messageId` → invitation row's `sesMessageId`.
  - `Bounce` (Permanent) → `BOUNCED`. Transient bounces → ignore (SES
    handles re-delivery on its own).
  - `Complaint` → `COMPLAINED`.
  - `Delivery` → `DELIVERED`.
  - `Reject` → `BOUNCED` with `deliveryError = 'rejected'`.
- Configuration-set check: if the inbound event's
  `mail.tags['ses:configuration-set']` doesn't match
  `env.AWS_SES_CONFIGURATION_SET`, reject the event. Prevents a leaked
  webhook URL from being abused.
- If no matching invitation found by `sesMessageId`: ack 200 (event may
  belong to a different flow added later).

The handler is idempotent: each event is a last-write-wins UPDATE on
`(deliveryStatus, deliveryError)`. SES delivers events in causal order
per message so this is safe.

### Env additions

`.env.example` and `apps/api/src/lib/env.ts`:

```
AWS_SES_REGION=us-east-1
AWS_SES_FROM_EMAIL=
AWS_SES_CONFIGURATION_SET=
AWS_SES_EVENTS_VERIFY_SIGNATURE=true
```

`AWS_SES_FROM_EMAIL` is the toggle: unset → NoopMailer + all invitations
work locally without SES.

### Operator setup (documented in `docs/operations/email.md` — out of scope here)

1. Verify a sending identity in SES.
2. Create a Configuration Set with an SNS event destination for
   `bounce`, `complaint`, `delivery`, `reject`.
3. Subscribe SNS to `https://<api-host>/webhooks/ses-events`.
4. Set `AWS_SES_FROM_EMAIL` + `AWS_SES_CONFIGURATION_SET` env vars and
   restart the API.

## Dashboard UI

### Members page rewrite

`apps/dashboard/src/routes/_authed/projects/$projectId/settings/members.tsx`
becomes three stacked sections:

```
┌─ Members ─────────────────────────────────────────────────┐
│ Project access roster. Every project must keep at least   │
│ one OWNER.                                                 │
│                                                            │
│ [ + Invite member ]   ← visible to OWNER+ADMIN             │
└───────────────────────────────────────────────────────────┘

┌─ Active members ──────────────────────────────────────────┐
│ USER             │ ROLE        │ MEMBER SINCE │ ⋯          │
│ Veyis Furkan G.  │ [OWNER]     │ 5/25/2026   │ ⋯          │
│ Jane Doe         │ [ADMIN ▾]   │ 5/12/2026   │ ⋯          │
└───────────────────────────────────────────────────────────┘

┌─ Pending invitations ─────────────────────────────────────┐
│ EMAIL            │ ROLE      │ EXPIRES   │ STATUS │ ⋯     │
│ alex@example.com │ DEVELOPER │ in 6 days │ Sent   │ ⋯     │
│ sam@example.com  │ GROWTH    │ in 2 days │ Bounced│ ⋯     │
└───────────────────────────────────────────────────────────┘
```

The "Pending invitations" section is hidden if there are zero invitations
and the caller can't manage members anyway.

### Invite dialog (`InviteMemberDialog.tsx` — new)

Form fields:

- `Email` — required; lowercased on submit.
- `Role` — select with options `ADMIN / DEVELOPER / GROWTH /
  CUSTOMER_SUPPORT`. OWNER not in the list.

Submit → `POST /dashboard/projects/:id/invitations`.

On success, dialog body replaced with a success state:

> **Invitation sent**
>
> We've emailed `alex@example.com`. The invite link is below if you want
> to share it directly. The link expires in 7 days.
>
> `https://dashboard.rovenue.io/invitations/rov_inv_…`     [ Copy link ]

If the response carried `X-Rovenue-Refreshed: true`, the success state
shows a banner: "Replaced an existing pending invite."

On `409 ALREADY_MEMBER`: inline error under the email field.

### Per-row actions (kebab menu)

For an **active member** row, with caller permissions:

- OWNER+ADMIN caller, target is NOT OWNER and NOT self:
  - Change role → submenu of `ASSIGNABLE_ROLES`.
  - Remove from project (confirmation dialog).
- OWNER caller, target is another OWNER (currently the only way to have
  two OWNERs is mid-transfer, but the UI should handle it gracefully):
  - Transfer ownership… → confirmation dialog.
- OWNER caller, target is non-OWNER member:
  - Change role…
  - Transfer ownership… → confirmation dialog with current/target details
    and warning "You will be demoted to ADMIN."
  - Remove from project.
- Caller views their OWN row:
  - "Leave project" (non-OWNER), or
  - "Transfer ownership…" then "Leave" (OWNER) — leave is hidden until
    they're no longer the last OWNER.

For a **pending invitation** row (OWNER+ADMIN only):

- Copy invite link — only available **immediately after creation** (we
  only have the plaintext token in memory once). For older invites this
  action is hidden.
- Resend email (rate-limit toast if too soon).
- Revoke.

### New hooks (`apps/dashboard/src/lib/hooks/useProjectAdmin.ts`)

```
useUpdateMemberRole()
useRemoveMember()
useLeaveProject()         // onSuccess: navigate("/projects")
useTransferOwnership()
useProjectInvitations(projectId)
useCreateInvitation()     // returns CreateInvitationResponse incl. inviteUrl
useRevokeInvitation()
useResendInvitation()
```

All mutations invalidate `["members", projectId]` and `["invitations",
projectId]` on success.

### Acceptance landing page

New public route `apps/dashboard/src/routes/invitations/$token.tsx`
(outside the `_authed` group):

```
┌─────────────────────────────────────────────────────────┐
│ You're invited to join {projectName}                    │
│                                                          │
│ {inviterName} invited {email} to join {projectName} as  │
│ a {role}.                                                │
│                                                          │
│ ──────────────────────────────────────────────          │
│                                                          │
│ [ Sign in with GitHub ]  [ Sign in with Google ]        │
│                                                          │
│ After you sign in we'll add you to the project.          │
└─────────────────────────────────────────────────────────┘
```

Flow logic:

1. On mount, `GET /invitations/:token`. Render based on `status`:
   - `pending` and unauthenticated → show sign-in buttons (OAuth providers
     return to this same URL).
   - `pending` and signed in with matching email → auto `POST
     /invitations/:token/accept`, then redirect to `/projects/:projectId`.
   - `pending` and signed in with DIFFERENT email → show "You're signed in
     as {currentEmail}, but this invite is for {invitedEmail}. [Sign
     out]".
   - `accepted` → "This invite has already been accepted." with link to
     the project (if signed in) or sign-in.
   - `revoked` / `expired` → static state with a polite explanation and a
     link to the dashboard homepage.

### i18n

All new strings keyed under `members.*` and `invitations.*` in
`apps/dashboard/src/i18n/locales/en.json`. No TR locale updates.

## Audit logs

New audit event types registered with the hash chain:

- `member.role_changed`
- `member.removed`
- `member.left`
- `member.ownership_transferred`
- `invitation.created`
- `invitation.revoked`
- `invitation.resent`
- `invitation.accepted`

Email delivery failures are NOT audited (logger-only, per scope decision).

## Testing

### Unit

- Permission matrix: snapshot of `CAPABILITY_ROLES`.
- `statusOf()` against synthetic invitation rows.
- Token generation: `generateInviteToken()` returns a `rov_inv_…` shape
  and `sha256(plaintext)` matches `tokenHash`.
- Template renderer: snapshot `subject/html/text` for invitation email
  with a stable date.
- SNS signature verifier: valid cert, expired cert, wrong host, wrong
  signature, mismatched configuration-set.
- `parseSesEvent()` for each event type (bounce/complaint/delivery/reject).

### Integration (`*.integration.test.ts`, testcontainers)

- POST invitation → invitation row exists, BullMQ job enqueued, mailer
  recorded one send.
- POST invitation when prior pending exists → old revoked, new created,
  response header `X-Rovenue-Refreshed: true`.
- POST invitation for an email that previously BOUNCED in another project
  → new invitation is created with deliveryStatus=SUPPRESSED, no email
  job enqueued, the standard `invitation.created` audit row still fires.
- Acceptance: signed-in user with matching email → project_members row
  appears, invitation.acceptedAt set.
- Acceptance: signed-in user with mismatched email → 403.
- Acceptance: token reuse → 409.
- Transfer ownership: target becomes OWNER, caller becomes ADMIN.
- Leave: last OWNER cannot leave (409). With second OWNER present they can.
- SES event POST with a Bounce notification → invitation row flips to
  BOUNCED, deliveryError populated.

### E2E (dashboard)

- Smoke flow: log in → settings/members → invite → copy link → log out →
  open invite link → log in with same email → land on project page with
  correct role.

## Rollout

The enum migration is split into two Drizzle migration files so the
`ADD VALUE` and the type-swap don't share a transaction. There's no
brown-field data risk because no production data uses VIEWER in a way
that distinguishes it from CUSTOMER_SUPPORT.

For SES: the project ships with `AWS_SES_FROM_EMAIL` unset by default,
so existing self-hosters keep working — invitations still create rows
and the UI still shows the one-time copyable link. Operators opt into
email sending by setting the env var and following the operator setup
steps.

## Open questions left for the implementation plan

- Where exactly to place `members.ts` / `invitations.ts` routers
  (sibling files vs nested under projects) — both are valid; writing-
  plans skill will pick based on existing patterns.
- Whether to expose a `lastResentAt` column to enforce the 60s rate limit
  in Postgres rather than Redis. Redis is simpler; column is more
  durable. Pick during implementation.
- BullMQ queue concurrency / worker placement.
