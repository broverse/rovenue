# Notifications Infrastructure — Design

**Date:** 2026-05-26
**Author:** Rovenue team
**Status:** Draft (pending implementation plan)

## Goals

1. Stand up an end-to-end operational notification pipeline for dashboard
   users: email (Amazon SES) + mobile push (APNs + FCM) + in-app feed
   (bell icon dropdown + `/account/notifications/inbox`).
2. Persist user preferences in a two-tier model: per-user global channel
   toggles + per-user × per-project event toggles, with project-level
   defaults that new members inherit.
3. Define a v1 catalog of 16 notification events covering revenue,
   billing, integration health, team, and security categories.
4. Route everything through the existing outbox → Kafka pattern so the
   pipeline is replayable, idempotent, and consistent with CLAUDE.md's
   "no dual-writes" rule.
5. Ship a reusable React-Email template package (`packages/email-templates`)
   that backs both email and push body rendering, with `tr` + `en` i18n.
6. Wire the existing dashboard bell icon, restructure the existing
   `/account/notifications` preferences page, add a per-project defaults
   page (`/projects/:id/settings/notifications`), and a public
   `/unsubscribe` page that satisfies RFC 8058 one-click.

## Non-goals

- Web Push (browser Push API + service worker). Mobile only.
- Slack / Discord / Teams transports. (The existing `slack` toggle in
  `user_preferences.notifications` is removed.)
- Marketing / product-news emails (the `marketing` and `product_news`
  toggles in the existing prefs page). Operational only; the marketing
  pipeline is a separate project.
- The Rovenue mobile dashboard app itself. The backend assumes one will
  exist (push token registration endpoint is shipped), but the iOS/Android
  app is out of scope.
- The detector workers that emit the actual revenue notifications
  (`revenue.anomaly.detected`, `revenue.churn.spike`,
  `revenue.milestone.hit`). Those are emitted by separate workers that
  are out of scope. This spec covers the notification *infrastructure*
  that consumes such emissions.

## Dependencies

This design depends on two in-flight specs in this repo:

- **`2026-05-26-project-members-invite-design.md`** ships:
  - `apps/api/src/lib/mailer.ts` — the SES email transport abstraction
    with a `Mailer` interface. **Reused as the email transport here.**
  - `apps/api/src/lib/email-templates/` — the initial template layer
    (invitation template only). **This spec lifts these templates into
    a new `packages/email-templates` workspace package** (see §5.3) and
    re-points the invite flow at the new package; the invite spec's
    template directory becomes a temporary home that migrates on first
    notifications PR.
  - SES bounce/complaint suppression list + SNS feedback webhook handler.
    **Reused; this spec consumes the same suppression list before send.**
  - The five-role `MemberRole` enum (`OWNER, ADMIN, DEVELOPER, GROWTH,
    CUSTOMER_SUPPORT`). **Required; recipient resolution per event uses
    the new roles.**
- A separate Amazon SES infrastructure setup session (configuration set
  `rovenue-notifications`, SNS feedback topic, IAM role). The endpoint
  receiver and template usage are covered here; the AWS-side
  provisioning is out of scope.

If those land first, this spec slots in cleanly. If notifications lands
first, the email transport and suppression list need to be lifted out of
the invite spec; in practice we sequence invite first.

## High-level architecture

```
   ┌───────────────────────────────────────────────────────────────┐
   │ Domain code / detector workers / digest scheduler             │
   │ (anomaly, churn, refund, invite, security, digest, …)         │
   └────────────────────┬──────────────────────────────────────────┘
                        │ INSERT outbox_events
                        │ (aggregateType='NOTIFICATION', same tx)
                        ▼
              ┌────────────────────────┐
              │ outbox-dispatcher      │  (existing)
              │ per-topic backoff      │
              └─────────┬──────────────┘
                        │ produce
                        ▼
            ┌──────────────────────────┐
            │ Kafka: rovenue.notifications │
            └──────────────────────────┘
                        │ consume
                        ▼
              ┌────────────────────────┐
              │ notifier-worker        │  (NEW — separate process)
              │ - resolve recipients   │
              │ - eval prefs (cascade) │
              │ - render templates     │
              │ - insert notifications │
              │ - insert deliveries    │
              │ - enqueue BullMQ jobs  │
              └─────────┬──────────────┘
                        │
        ┌───────────────┼────────────────┬───────────────┐
        ▼               ▼                ▼               ▼
  notifier:           notifier:        notifications    audit_logs
  send-email          send-push        table (inapp)    (hash chain)
  (BullMQ)            (BullMQ)
        │               │
        ▼               ▼
  Mailer (SES /    ApnsPushTransport
  SMTP fallback)   FcmPushTransport
```

## 1. Event catalog (v1)

The catalog lives in code at
`packages/shared/src/notifications/event-catalog.ts` as a typed object;
this table is the source of truth.

| Event key | Trigger | Recipients (role-based) | Default channels | Default on? | Forced channels |
|---|---|---|---|---|---|
| `revenue.digest.daily` | Cron @ user TZ 09:00 | self (per-user, scope=user) | email + inapp | yes | — |
| `revenue.digest.weekly` | Cron @ user TZ Mon 09:00 | self | email + inapp | yes | — |
| `revenue.anomaly.detected` | Anomaly detector | OWNER + ADMIN + GROWTH | email + push + inapp | yes | — |
| `revenue.milestone.hit` | Milestone watcher | All project members | email + inapp | no | — |
| `revenue.churn.spike` | Churn detector | OWNER + ADMIN + GROWTH | email + push + inapp | yes | — |
| `billing.refund.detected` | Refund webhook → high-value or burst | OWNER + ADMIN | email + inapp | yes | — |
| `billing.credit.low_balance` | Credit ledger threshold | OWNER + ADMIN | email + push + inapp | yes | — |
| `billing.invoice.failed` | Rovenue SaaS billing (Stripe) | Project OWNER (placeholder; see §11) | email + push + inapp | yes | **email** |
| `billing.invoice.paid` | Rovenue SaaS billing (Stripe) | Project OWNER (placeholder; see §11) | email | no | **email** |
| `integration.store_credential.expired` | Receipt-verify worker | OWNER + ADMIN + DEVELOPER | email + push + inapp | yes | **email** |
| `integration.webhook.failing` | Outgoing-webhook worker (3+ 5xx) | OWNER + ADMIN + DEVELOPER | email + inapp | yes | — |
| `team.member.invited` | Invitation created | invitee (the email being invited; not yet a user — handled by invite spec) | email | yes | **email** |
| `team.member.role_changed` | Role update | affected user (self) | email + inapp | yes | — |
| `team.member.removed` | Member removed | removed user (self) | email | yes | **email** |
| `security.signin.new_device` | Better Auth new session, unknown fingerprint | self | email + push + inapp | yes | **email** |
| `security.oauth.account_linked` | OAuth link | self | email + inapp | yes | **email** |

Notes:

- Forced channels bypass user preferences. `team.member.invited`,
  `team.member.removed`, all `security.*`, and `billing.invoice.*`
  cannot be opted out of email. UI shows them as locked toggles.
- "Self" recipients: the user is supplied in payload.recipients
  explicitly by the producer. Role-based scopes are resolved by the
  notifier worker via `project_members` join.
- Project-scoped events with `projectId` resolve recipients via
  `SELECT userId FROM project_members WHERE projectId = ? AND role = ANY($roles)`.
- The `digest.*` events are scoped per-user but cover multiple projects
  in a single email (see §4).

## 2. Data model

### 2.1 Modifications to existing tables

`user_preferences.notifications` JSONB is restructured:

```jsonc
// Old
{ "email": true, "slack": true, "push": true,
  "anomaly": true, "churn_spike": true, ... }

// New
{
  "channels": { "email": true, "push": true },
  "muted_until": null  // forward-compat; not used in v1
}
```

The per-event toggles move to a separate table (§2.2). Slack is dropped.

`user_preferences` also gains two columns:

- `locale text NOT NULL DEFAULT 'en'`
- `timezone text NOT NULL DEFAULT 'UTC'`

These already exist conceptually in the General Settings UI but aren't
persisted; this design wires them.

A one-off migration:

1. For every existing `user_preferences` row, lift the old keys
   (`anomaly`, `daily_digest`, `weekly_summary`, `milestone`,
   `churn_spike`, `invoice`, `refund_alert`, `low_balance`) and write
   them into `user_project_notification_prefs` for every project the
   user is a member of.
2. Replace the JSONB with the new `channels` shape derived from the old
   top-level `email` / `push` keys (slack discarded). `product_news` and
   `marketing` are dropped entirely (out of v1 scope).

### 2.2 New tables

```ts
// user_project_notification_prefs
{
  id: uuid pk,
  userId: uuid -> user.id,
  projectId: uuid -> projects.id,
  overrides: jsonb,            // { 'revenue.anomaly.detected': false, ... }
  createdAt, updatedAt
}
UNIQUE (userId, projectId)
INDEX (userId), INDEX (projectId)
```

```ts
// project_notification_defaults
{
  projectId: uuid pk -> projects.id,
  defaults: jsonb,              // event_key -> boolean
  updatedAt
}
```

Resolution order (in `resolvePrefs`):
1. Code-level seed default from `event-catalog.ts`.
2. `project_notification_defaults.defaults[eventKey]` if present.
3. `user_project_notification_prefs.overrides[eventKey]` if present.
4. If the event is in the user's forced list, return `true` regardless.

```ts
// notifications (in-app feed; hot table, declarative range partition by createdAt month)
{
  id: uuid pk,
  userId: uuid -> user.id,
  projectId: uuid? -> projects.id,    // null for account-scoped events
  eventKey: text,
  eventId: text,                      // mirrors outbox event_id
  title: text,                        // rendered, locale-aware
  body: text,                         // rendered markdown
  data: jsonb,                        // deep-link payload
  readAt: timestamptz?,
  createdAt: timestamptz default now()
}
UNIQUE (userId, eventId)              -- idempotency
INDEX (userId, readAt NULLS FIRST, createdAt DESC)
```

`notifications` is a declarative `RANGE (createdAt)` partition table
managed by `pg_partman` with monthly partitions, 6-month retention —
mirroring the pattern used by `revenue_events` and `credit_ledger`.

```ts
// notification_deliveries (hot table, monthly partitions, 90-day retention)
{
  id: uuid pk,
  notificationId: uuid -> notifications.id,
  channel: enum('email','push','inapp'),
  status: enum('queued','sent','delivered','bounced','failed','suppressed'),
  providerMessageId: text?,
  providerResponse: jsonb?,
  attempts: int default 0,
  lastAttemptAt: timestamptz?,
  createdAt: timestamptz default now()
}
INDEX (notificationId), INDEX (status, createdAt)
```

```ts
// push_devices
{
  id: uuid pk,
  userId: uuid -> user.id,
  platform: enum('ios','android'),
  token: text,                        // plaintext: APNs/FCM tokens are not secrets
  appBundleId: text,                  // 'com.rovenue.dashboard'
  locale: text,                       // 'tr-TR'
  timezone: text,                     // 'Europe/Istanbul'
  lastSeenAt: timestamptz,
  revokedAt: timestamptz?,
  createdAt: timestamptz default now()
}
UNIQUE (platform, token)
INDEX (userId) WHERE revokedAt IS NULL
```

`notification_suppression_list` is owned by the invite spec; this design
reuses it. PK is the plaintext lowercased email. New entries created
here come from SES bounce/complaint events.

### 2.3 Outbox event shape

New `aggregateType` value: `NOTIFICATION`. New Kafka topic:
`rovenue.notifications`. `AGGREGATE_TO_TOPIC` in
`apps/api/src/workers/outbox-dispatcher.ts` gains one entry.

Outbox payload (`outbox_events.payload`) for any notification:

```ts
{
  eventKey: string,                  // 'revenue.anomaly.detected'
  eventId: string,                   // deterministic per producer
  projectId?: string,                // null for account-scoped events
  recipients?: string[],             // override; else role-based via project_members
  context: Record<string, unknown>   // event-specific (amount, threshold, productId, ...)
}
```

Producers always call `emitNotification(tx, input)` inside the same
Drizzle transaction as the domain write — never outside.

## 3. Outbox + notifier worker

### 3.1 Producer helper

```ts
// apps/api/src/services/notifications/emit.ts
export async function emitNotification(
  tx: DrizzleTx,
  input: EmitNotificationInput
): Promise<void> {
  await tx.insert(outboxEvents).values({
    aggregateType: 'NOTIFICATION',
    aggregateId: input.projectId ?? 'account',
    eventType: input.eventKey,
    eventId: input.eventId,
    payload: input,
  });
}
```

Each producer (anomaly detector, refund webhook, team API handler, etc.)
calls this. The producer is responsible for choosing a deterministic
`eventId` so retries are idempotent at the outbox layer (e.g.,
`anomaly:${projectId}:${YYYY-MM-DD}` for a once-per-day-per-project
event).

### 3.2 Notifier worker (separate Node process)

`apps/api/src/workers/notifier.ts` is a new long-running process with
its own entrypoint and Docker service. It consumes
`rovenue.notifications` and, for each message:

1. Parse and validate the payload (Zod).
2. Resolve recipients:
   - if `payload.recipients` is set → use as-is;
   - else if event is account-scoped → workspace owner;
   - else → `SELECT userId FROM project_members WHERE projectId = ? AND role = ANY($eventCatalog[key].recipientRoles)`.
3. For each recipient, evaluate `resolvePrefs(userId, projectId, eventKey)`.
4. Compute `enabledChannels` from default channels filtered by user's
   channel toggles, then unioned with forced channels.
5. If `enabledChannels` is empty, skip the recipient.
6. Render `title / body / pushTitle / pushBody` via the template
   registry, using the recipient's locale.
7. In a single transaction:
   - `INSERT notifications (...) ON CONFLICT (userId, eventId) DO NOTHING RETURNING id`
   - If no row returned, skip (already processed; idempotent path).
   - For each `enabledChannels` ch other than `'inapp'`: `INSERT notification_deliveries (status='queued')`. For `'inapp'`: `INSERT … (status='delivered')`.
8. After commit, enqueue BullMQ jobs (`notifier:send-email` /
   `notifier:send-push`) referencing the delivery row IDs.
9. Commit the Kafka offset (manual commit per message batch).

### 3.3 Cache strategy

Per-worker LRU caches with 60-second TTL, invalidated via Redis pub/sub
on preference / membership writes:

- `userPrefs(userId)` — channels, locale, timezone.
- `projectDefaults(projectId)`.
- `projectMembers(projectId, roles[])`.

60-second eventual consistency on preference changes is acceptable.

### 3.4 Idempotency layers

1. Outbox table `UNIQUE (aggregateType, eventId)` — producers can call
   `emitNotification` twice safely; only one row exists.
2. `notifications` table `UNIQUE (userId, eventId)` — Kafka redelivery
   produces no duplicate inapp rows or duplicate delivery jobs.

### 3.5 DLQ

A separate Kafka topic `rovenue.notifications.dlq` holds messages that
the notifier could not parse or resolve recipients for. Replay is
manual via an admin script. The notifier never retries individual
messages at the consumer layer; transport-layer retries live in BullMQ.

## 4. Digest pipeline

### 4.1 Schedulers

Two BullMQ cron jobs in `apps/api/src/workers/digest-scheduler.ts`:

```ts
queue.add('digest.daily',  null, { repeat: { pattern: '0 * * * *' } });
queue.add('digest.weekly', null, { repeat: { pattern: '0 * * * 1' } });
```

Each job runs hourly, computes which IANA timezones currently align with
local 09:00 (or Monday 09:00), and processes all users in those
timezones.

### 4.2 Per-user digest emission

For each user in a matching timezone:

1. Skip if `user.channels.email` is false (digests are email-only +
   inapp; push intentionally not used).
2. Find the user's projects where the digest event toggle is enabled
   (one query joining `project_members`,
   `user_project_notification_prefs`, `project_notification_defaults`).
3. For each project, fetch yesterday's (or last week's) KPIs from
   ClickHouse materialized views: `mrr_daily`, `subscriptions_daily`,
   `refunds_daily`, `revenue_events_summary_daily`.
4. Drop projects with no activity ("all KPIs zero"). If all projects
   drop, skip the entire digest — no empty digest emails.
5. `emitNotification` with one outbox row covering all non-empty
   projects in `context.sections`.

The digest is a single account-scoped notification (`projectId: null`)
with multiple project sections; the user receives one email and one
inapp row.

### 4.3 Timezone enumeration

A runtime helper `enumerateTimezonesAtLocalHour(utcNow, 9)` iterates
the IANA tz database (via Luxon) and returns the set of tz names whose
local hour matches. Cached per-hour. DST transitions are handled
automatically by Luxon. At v1 scale (small user count) this is
acceptable; if it becomes hot, denormalize a generated column on
`user_preferences` for `digest_send_hour_utc`.

### 4.4 Digest hour and empty-skip policy

- Daily hour is fixed at **09:00 user local**. User-configurable hour
  is deferred to v1.1.
- Empty digest (no project activity) is always skipped; no opt-in to
  receive zero-activity emails.

## 5. Transports and templating

### 5.1 Email transport

The `Mailer` interface and `SesMailer` impl ship in the invite spec
under `apps/api/src/lib/mailer.ts`. This spec uses it as-is. A
`SmtpMailer` impl is added for self-hosters (nodemailer-backed) selected
via `EMAIL_PROVIDER=ses|smtp` env. The `Mailer` interface is preserved.

Required env additions:

```
EMAIL_PROVIDER=ses|smtp
EMAIL_FROM_ADDRESS=notifications@rovenue.io
EMAIL_FROM_NAME=Rovenue
SES_CONFIGURATION_SET=rovenue-notifications   # for notifications-specific feedback routing
# SMTP
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE
```

Suppression list pre-check (owned by invite spec, here we just call it)
is invoked before every send. Suppression hits write a delivery row
with `status='suppressed'`, no audit log noise.

### 5.2 Push transports

Two transports under
`apps/api/src/lib/push/`:

- `ApnsPushTransport` (`@parse/node-apn`-compatible client). Token-based
  auth (.p8 + key id + team id). `apns-topic` header = bundle ID.
- `FcmPushTransport` (Firebase Admin SDK v1 HTTP API). Service account
  JSON from env.

Required env:

```
APNS_KEY_ID
APNS_TEAM_ID
APNS_KEY_P8                # PEM contents (multiline)
APNS_BUNDLE_ID             # 'com.rovenue.dashboard'
APNS_ENVIRONMENT=production|sandbox

FCM_SERVICE_ACCOUNT_JSON   # single-line JSON
```

If env is missing for a transport, the notifier worker boots with that
transport disabled and the channel is silently dropped from
`enabledChannels`. Email-only mode therefore works without push setup.

Permanent error responses (`BadDeviceToken`, `Unregistered`, `410 Gone`,
`UNREGISTERED`, `INVALID_ARGUMENT` for the token field) mark the
`push_devices.revokedAt` timestamp and never retry. Other errors retry
per BullMQ exponential-backoff config.

### 5.3 Template engine

A new pnpm workspace package `packages/email-templates` houses all
templates. Reasons for splitting it out of `apps/api`:

- The React-Email preview server (`react-email dev`) wants a separate
  package to run.
- The dashboard may import a subset (e.g., test-send previews,
  unsubscribe success page) without pulling in API deps.
- Locales live alongside templates and version together.

Package contents:

```
packages/email-templates/
├── package.json
├── src/
│   ├── layouts/
│   │   └── base-layout.tsx      # header, logo, footer, List-Unsubscribe
│   ├── revenue/
│   │   ├── digest-daily.tsx
│   │   ├── digest-weekly.tsx
│   │   ├── anomaly-detected.tsx
│   │   ├── churn-spike.tsx
│   │   └── milestone-hit.tsx
│   ├── billing/
│   │   ├── refund-detected.tsx
│   │   ├── credit-low-balance.tsx
│   │   ├── invoice-failed.tsx
│   │   └── invoice-paid.tsx
│   ├── integration/
│   │   ├── store-credential-expired.tsx
│   │   └── webhook-failing.tsx
│   ├── team/
│   │   ├── invited.tsx           # initially owned by invite spec; lift here
│   │   ├── role-changed.tsx
│   │   └── removed.tsx
│   ├── security/
│   │   ├── signin-new-device.tsx
│   │   └── oauth-account-linked.tsx
│   └── registry.ts               # { render(eventKey, ctx, locale) }
└── locales/
    ├── en/
    │   ├── revenue.anomaly-detected.json
    │   └── ...
    └── tr/
        └── ...
```

Each template file exports the React component, a `subject(ctx, t)`
function, and `pushTitle(ctx, t)` / `pushBody(ctx, t)` for push payload
text. The registry's `render()` returns:

```ts
{
  subject: string;
  html: string;
  text: string;
  pushTitle: string;
  pushBody: string;
}
```

i18n is via `i18next` with a manual `Trans`-compatible helper that
works server-side (no React context required at runtime). Locale
fallback chain: `user.locale → 'en'`.

`turbo.json` and `pnpm-workspace.yaml` gain this package. The API
declares it as a dependency.

### 5.4 Unsubscribe / List-Unsubscribe

Every non-forced email includes:

```
List-Unsubscribe: <https://app.rovenue.io/unsubscribe?token=JWT>, <mailto:unsub@rovenue.io>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

JWT payload (`UNSUB_SIGNING_KEY` env, HMAC-SHA256):

```ts
{
  userId: string,
  scope: 'channel:email' | `event:${string}`,
  projectId?: string,
  exp: number      // 30 days
}
```

Email body also includes a per-event "manage preferences" link pointing
into the dashboard (`/account/notifications`); the List-Unsubscribe
header drives the broader channel-level unsubscribe.

Forced events ship without the `List-Unsubscribe` header so Gmail
doesn't surface the one-click button. The body still includes a
"manage preferences" link, but the relevant toggle is locked.

### 5.5 SES feedback

`POST /v1/internal/ses-feedback` (no Better Auth) receives SNS
notifications for the `rovenue-notifications` configuration set. The
handler:

1. Verifies SNS signature (`aws-sns-message-validator`).
2. On `Bounce` + `Permanent`: insert into
   `notification_suppression_list` with reason `hard_bounce`.
3. On `Complaint`: insert with reason `complaint`. Additionally, set
   `user_preferences.notifications.channels.email = false` for the
   matching user (KVKK: complainant should not receive further mail).
4. On `Bounce` + `Transient` (soft bounce): record nothing; rely on
   BullMQ retry already in flight.
5. Cross-reference `notification_deliveries.providerMessageId` to
   mark the corresponding delivery `status='bounced'`.

### 5.6 BullMQ queues

```ts
new Worker('notifier:send-email', processEmailJob, {
  concurrency: 10,
  limiter: { max: 14, duration: 1_000 },   // SES production default
});
new Worker('notifier:send-push', processPushJob, {
  concurrency: 50,
  limiter: { max: 1_000, duration: 1_000 },
});
```

Job options:

- `send-email`: `attempts: 4`, exponential backoff base 1s.
- `send-push`: `attempts: 3`, exponential backoff base 0.5s.
- `digest.daily/weekly`: `attempts: 5`, exponential backoff base 60s
  (room for ClickHouse to recover).

## 6. API endpoints

All endpoints use the `{ data: T } | { error: { code, message } }` shape,
Zod validation, and the existing rate-limit middleware unless specified.

### 6.1 Dashboard (Better Auth session)

| Method & path | Purpose |
|---|---|
| `GET /api/dashboard/notifications` | In-app feed list. Query: `unread`, `projectId`, `cursor`, `limit` (max 50). Cursor: base64-encoded `(createdAt, id)`. |
| `GET /api/dashboard/notifications/unread-count` | `{ total, byProject: Record<projectId, number> }`. 5s `Cache-Control: private`. |
| `POST /api/dashboard/notifications/:id/read` | `readAt = now()` (idempotent). |
| `POST /api/dashboard/notifications/read-all` | Body `{ projectId?: string }`. Single UPDATE. |
| `GET /api/dashboard/notifications/preferences?projectId=` | Resolved prefs. Without `projectId`: channels + locale + timezone. With: channels + event toggles for that project. |
| `PATCH /api/dashboard/notifications/preferences` | Body discriminated union: `{ scope: 'global', channels?, locale?, timezone? }` or `{ scope: 'project', projectId, overrides }`. Forced-event overrides → 400 `FORCED_EVENT`. |
| `GET /api/dashboard/push-devices` | List user's active devices (`revokedAt IS NULL`). |
| `POST /api/dashboard/push-devices` | Upsert by `(platform, token)`. Conflict transfers ownership and clears `revokedAt`. |
| `DELETE /api/dashboard/push-devices/:id` | Set `revokedAt = now()`. |
| `GET /api/dashboard/projects/:projectId/notification-defaults` | Read project default toggles. Any member. |
| `PATCH /api/dashboard/projects/:projectId/notification-defaults` | OWNER + ADMIN only. Body `{ defaults: Record<eventKey, boolean> }`. |

Rate limits:

- `POST /api/dashboard/push-devices` → 10/min/user.
- Others use the standard 60/min/user.

### 6.2 Public (signed token)

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /unsubscribe?token=` | SPA landing page (dashboard route). Never changes state. | Token-bearing URL is its own auth signal for the SPA; the API call is what writes state. |
| `POST /unsubscribe` | One-click unsubscribe (RFC 8058). Body or query `token`. | JWT signature. 30/min/IP. |

The SPA route loads the dashboard, parses the token, shows a Confirm
button. Gmail's one-click button issues `POST` directly. The endpoint
sets the relevant pref to `false` and writes an audit row.

### 6.3 Internal

| Method & path | Purpose | Auth |
|---|---|---|
| `POST /v1/internal/ses-feedback` | SNS webhook. | SNS signature verification middleware. 1000/min from AWS IPs (allowlist). |
| `POST /v1/internal/notification-test` | Send a test notification to caller's email + push (smoke test). | Better Auth session, restricted to OWNER role; staging/prod only. |

These mount under a separate Hono router (`/v1/internal/*`) without the
Better Auth middleware.

### 6.4 Audit log entries

- `notification.preferences.updated` (scope, before/after diff).
- `notification.defaults.updated` (projectId, before/after diff, actor).
- `notification.unsubscribed` (scope, IP).
- `push_device.registered`, `push_device.revoked`.
- `notification.sent`, `notification.failed`, `notification.suppressed`
  (from the notifier worker, inside the delivery insert tx).

Mark-as-read / list / unread-count endpoints do **not** audit.

## 7. Frontend touch points

Backend lands first; dashboard work is sequenced after.

1. **Topbar bell (`apps/dashboard/src/components/dashboard/topbar.tsx`)**
   - Replace the static red dot with a live unread count
     (`useQuery(['notifications', 'unread-count'])`, 30s refetch).
   - On click, show a dropdown with the latest 10 notifications, a
     "Mark all as read" button, and a "View all" link to
     `/account/notifications/inbox`.

2. **`/account/notifications/inbox`** (new full-page feed)
   - Infinite scroll via `useInfiniteQuery` with cursor pagination.
   - Filters: unread-only, by project, by category.
   - Row click navigates to the deep-link in `notification.data`.

3. **`/account/notifications`** (existing prefs page; restructure)
   - Section 1: **Channels** — email + push master toggles, locale +
     timezone selects (link to General Settings to avoid duplication).
   - Section 2: **Devices** — list of registered push devices,
     last-seen, revoke button.
   - Section 3: **Per-project events** — one card per project the user
     is a member of, with event toggles. Forced events render as locked
     with a lock icon and tooltip. Overrides display `(custom)` with a
     "Reset to default" link; unset shows `(default)`.

4. **`/projects/:id/settings/notifications`** (new, OWNER + ADMIN)
   - Same category/event layout as the per-project section above, but
     editing the project defaults instead of the user override.

5. **`/unsubscribe`** (new public SPA route)
   - Decodes token client-side, shows a confirmation page, calls
     `POST /unsubscribe` on confirm. Handles expired / invalid tokens
     with a "Sign in to manage preferences" CTA.

6. **i18n keys** under `apps/dashboard/src/i18n/locales/{en,tr}/account.notifications.*`
   are expanded to cover all v1 event keys; event titles/descriptions
   are sourced from the shared `event-catalog.ts` via key mapping.

## 8. Error handling, retries, observability

### 8.1 Error classification

| Category | Examples | Behaviour |
|---|---|---|
| Transient | SES 5xx, APNs 500, FCM `UNAVAILABLE`, ClickHouse timeout, Kafka rebalance | BullMQ exponential-backoff retry, max 4 attempts. |
| Permanent (recipient) | SES `MessageRejected`, APNs `BadDeviceToken`/`Unregistered`/410, FCM `UNREGISTERED` | No retry; delivery `status='failed'`; push token revoked. |
| Permanent (systemic) | SES `AccountSendingPausedException`, APNs auth key invalid, FCM service account expired | No retry; queue paused; alert. |
| Validation | Template render error, missing context field | No retry; delivery `status='failed'`; Sentry. |
| Suppression hit | Email in `notification_suppression_list` | No send; delivery `status='suppressed'`. |

Kafka consumer errors (unparseable payloads, recipient resolution
failures) → DLQ topic `rovenue.notifications.dlq`. No in-consumer retry.

### 8.2 Circuit breaker

Per-channel: 5+ consecutive 5xx in 60s pauses the queue for 5 minutes
and fires a Sentry/PagerDuty alert. The outbox dispatcher's existing
per-topic backoff already protects `rovenue.notifications` independently.

### 8.3 Metrics

```
notifier_dispatched_total{event_key, channel, status}    counter
notifier_render_duration_seconds{event_key}              histogram
notifier_recipient_count{event_key}                      histogram
notifier_pref_cache_hit_total{cache}                     counter
notifier_queue_depth{queue, state}                       gauge
notifier_suppression_hits_total{reason}                  counter
notifier_push_token_revoked_total{platform, reason}      counter
email_send_duration_seconds{provider}                    histogram
push_send_duration_seconds{platform}                     histogram
digest_skipped_total{reason}                             counter
```

### 8.4 Alerts

| Alert | Threshold | Severity |
|---|---|---|
| Email circuit open | 1 min | Page |
| SES bounce rate > 5% (rolling 1h) | sustained 10 min | Page |
| SES complaint rate > 0.1% | sustained 10 min | Page |
| Push token revoke spike | rate > 50/5min | Warn |
| Notifier consumer lag > 5k | sustained 5 min | Warn |
| BullMQ failed queue > 100 | sustained 5 min | Warn |
| Digest skipped > 90% of users in 1h | systemic data pipeline failure | Warn |

### 8.5 Runbook stubs

- Email queue paused → check SES console reputation dashboard, unpause.
- Push circuit open → validate APNs key / FCM SA + egress.
- DLQ growing → replay via admin script.
- Bounce rate spike → suppression-list audit + recent-recipients check.

## 9. Security and privacy

- **Push payload contents**: full financial values (e.g., refund amount
  and currency) are permitted. Accepted lock-screen leakage risk.
- **PII in Sentry**: never includes email addresses or auth tokens —
  only `userId` and event metadata.
- **Suppression list retention**: permanent. Even if a user is deleted,
  the suppressed email stays (KVKK right-not-to-be-emailed; protects
  the address from reuse).
- **Unsubscribe tokens**: 30-day expiry, HMAC-signed, scoped. Not
  single-use; idempotent.
- **SPF / DKIM / DMARC**: configured at the SES domain level
  (infrastructure session).
- **`UNSUB_SIGNING_KEY`** is a new 32-byte hex env, separate from
  `ENCRYPTION_KEY` to avoid key reuse across cryptographic purposes.

## 10. Testing

### 10.1 Unit

- `resolvePrefs` cascade (12+ cases incl. forced, missing rows,
  non-member, channel-off + forced channel).
- Template registry: render snapshot per event, locale fallback,
  missing-context error.
- Event-catalog invariants: every `forcedChannels` value is a subset of
  `defaultChannels`; every event has unique key.
- Unsubscribe JWT round-trip; expiry; scope mismatch.
- `enumerateTimezonesAtLocalHour` across DST boundaries
  (US, EU, AU spring-forward / fall-back).

### 10.2 Integration (`*.integration.test.ts`, testcontainers)

- `notifier-worker.integration.test.ts`: outbox → Kafka → consume →
  insert. Idempotency. Forced channels override. Cache invalidation.
- `digest-scheduler.integration.test.ts`: ClickHouse fixture → digest
  emission. Zero-activity skip. All-muted skip.
- `unsubscribe.integration.test.ts`: valid/expired token, forced-event
  scope rejection, audit log.
- `ses-feedback.integration.test.ts`: SNS signature verification,
  bounce + complaint suppression list inserts, delivery row updates.
- `push-device-revoke.integration.test.ts`: mock APNs `BadDeviceToken`
  → revoke + failed delivery.

### 10.3 Contract tests

Each transport (Mailer, ApnsPushTransport, FcmPushTransport) has a
shared `*.contract.test.ts` suite the mock and real impls both pass.
Live tests run manually in sandbox env, not in CI.

### 10.4 Template visual regression

`packages/email-templates` snapshot tests commit rendered HTML to
`__snapshots__/`. PRs diff visually. Future: Percy / Chromatic.

### 10.5 Load (one-off, pre-release)

- 10k users × 5 projects → digest scheduler one-tick budget < 30s.
- 1k events/s notifier consume → end-to-end p95 < 5s.

### 10.6 Smoke (post-deploy)

`POST /v1/internal/notification-test` (OWNER-restricted) emits a test
event to the caller's email + push, exercising the full pipeline.

## 11. Open questions / v1.1

- User-configurable digest hour and timezone (UI dropdown).
- "Snooze for 24 hours" per-event mute.
- Web Push for users without the mobile app.
- Notification grouping (digest preview for triggered events).
- Per-event delivery channel override (e.g., "anomaly via push only,
  not email") — currently all-or-nothing per channel.
- Slack / Discord re-introduction as integration apps, not a hard-coded
  channel.
- **Rovenue's own SaaS billing model**: the schema has no
  `workspace` / `organization` layer above projects. `billing.invoice.*`
  events are currently routed to the project OWNER as a placeholder; if
  Rovenue ships per-organization billing in a future spec, the recipient
  resolution for these two events shifts to the org's billing contact
  and the event catalog updates accordingly. Until then this is a
  one-line change isolated to `event-catalog.ts`.

## 12. Implementation surface summary

New code surfaces:

- `packages/db/src/drizzle/schema.ts`: new tables, migration to drop
  slack + restructure JSONB + add locale/timezone columns.
- `packages/db/clickhouse/migrations/`: no changes (digest reads
  existing MVs).
- `packages/email-templates/`: new package.
- `packages/shared/src/notifications/`: event catalog, API schemas,
  shared types.
- `apps/api/src/services/notifications/`: `emit.ts`, `resolve-prefs.ts`,
  `event-catalog-runtime.ts`.
- `apps/api/src/workers/notifier.ts`: new process.
- `apps/api/src/workers/digest-scheduler.ts`: new worker.
- `apps/api/src/lib/push/`: `apns.ts`, `fcm.ts`, `transport.ts`.
- `apps/api/src/routes/dashboard/notifications/`: API routes.
- `apps/api/src/routes/internal/`: SES feedback, test-send.
- `apps/api/src/workers/outbox-dispatcher.ts`: add `NOTIFICATION`
  aggregate type and topic mapping.
- `apps/dashboard/src/components/dashboard/topbar.tsx`: wire bell.
- `apps/dashboard/src/routes/_authed/account/notifications.tsx`:
  restructure.
- `apps/dashboard/src/routes/_authed/account/notifications/inbox.tsx`:
  new.
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/notifications.tsx`:
  new.
- `apps/dashboard/src/routes/unsubscribe.tsx`: new public route.
- `deploy/docker-compose.yml`: new `notifier-worker` service.

Env additions: `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`,
`SES_CONFIGURATION_SET`, `SMTP_*`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_KEY_P8`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`,
`FCM_SERVICE_ACCOUNT_JSON`, `UNSUB_SIGNING_KEY`.

Touched code surfaces:

- All producers (anomaly/churn/refund/credit-ledger/store-credential/
  webhook/team API/Better Auth hooks) gain `emitNotification(tx, ...)`
  calls inside their existing transactions. These are line-level edits;
  the producers themselves remain owned by their respective features.
