# Resend Email Provider (SES kept as fallback)

**Date:** 2026-07-21
**Status:** Approved

## Goal

Add Resend as an email provider and make it the active/default one. The existing
AWS SES client (and SMTP path) stay fully functional and selectable via
`EMAIL_PROVIDER`. Delivery-status tracking (DELIVERED / BOUNCED / COMPLAINED)
continues to work under Resend via a new signed webhook endpoint.

## Non-goals

- Removing or deprecating the SES / SMTP mailers.
- Renaming `invitations.sesMessageId` (it stores an opaque provider message id;
  a rename migration is not worth it — documented with a code comment).
- Open/click analytics (Resend `email.opened` / `email.clicked` events are ignored).

## Approach

Zero new dependencies:

- `ResendMailer` calls `https://api.resend.com/emails` with plain `fetch`,
  matching the push transports (`lib/push/fcm.ts`, `lib/push/apns.ts`).
- Svix webhook signature verification is hand-rolled in `lib/svix-signature.ts`,
  mirroring the existing hand-rolled `lib/sns-signature.ts`. The scheme is
  HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` with the base64
  portion of the `whsec_…` secret, compared constant-time against the
  space-separated `v1,<sig>` list in the `svix-signature` header, with a
  5-minute timestamp tolerance.

The official `resend` + `svix` npm packages were considered and rejected: two
dependencies for one HTTP POST and one HMAC check, diverging from codebase
patterns.

## 1. Send path

### `apps/api/src/lib/mailer-resend.ts`

`ResendMailer implements Mailer`:

- `POST https://api.resend.com/emails`, `Authorization: Bearer <RESEND_API_KEY>`.
- Body: `{ from, to: [msg.to], subject, html, text, headers }` where `headers`
  is the existing `combineHeaders` merge (includes `X-Rovenue-Id` correlation).
- 2xx → `{ messageId: <resend email id> }`.
- Non-2xx → throw `Error` including status + response body, so the existing
  BullMQ retry / `failed`-status handling in `send-email-worker.ts` works
  unchanged.

### Provider selection (`lib/mailer.ts` + `lib/env.ts`)

- `EMAIL_PROVIDER: z.enum(["resend", "ses", "smtp"]).default("resend")` —
  default flips from `ses` to `resend`.
- New env: `RESEND_API_KEY` (optional string).
- `createMailerFromEnv` rules:
  - `smtp` → unchanged.
  - `ses` → unchanged.
  - `resend` → requires `RESEND_API_KEY` + a from address
    (`EMAIL_FROM ?? AWS_SES_FROM_EMAIL`). If the key is missing but SES is
    configured (from address present), **fall back to `SesMailer` with an
    info log** — existing SES deployments upgrading past the default flip keep
    sending. Otherwise `NoopMailer` (dev convenience), as today.

### Metrics provider label

`Mailer` gains `readonly provider: string` (`"resend" | "ses" | "smtp" | "noop"`).
`send-email-worker.ts` replaces the hardcoded `observeSendDuration("email", "ses", …)`
with the active mailer's `provider`.

## 2. Delivery events webhook

### `apps/api/src/lib/svix-signature.ts`

`verifySvixSignature(headers, rawBody, secret)` — throws on: missing headers,
timestamp outside ±5 min, no matching signature. Constant-time comparison
(`crypto.timingSafeEqual`).

### `apps/api/src/lib/resend-events.ts`

Pure parser, same shape philosophy as `lib/ses-events.ts`:

| Resend event            | Mapped status | Notes                                        |
| ----------------------- | ------------- | -------------------------------------------- |
| `email.delivered`       | `DELIVERED`   |                                              |
| `email.bounced`         | `BOUNCED`     | permanent bounces only; transient → ignored  |
| `email.complained`      | `COMPLAINED`  |                                              |
| `email.sent`, `email.opened`, `email.clicked`, `email.delivery_delayed`, unknown | ignored (return `null`) | |

Output patch: `{ providerMessageId (data.email_id), status, error, recipients }`
(recipients lowercased from `data.to`).

### `apps/api/src/routes/webhooks/resend-events.ts`

Mounted in `routes/webhooks/index.ts` at `/resend-events` with its own
rate-limit bucket (`storeLimit("resend")`), mirroring `ses-events`:

1. **Signature check, fail-closed:** mandatory when `NODE_ENV === "production"`
   or `RESEND_EVENTS_VERIFY_SIGNATURE` (default `true`); bad/missing signature
   → 403. Requires `RESEND_WEBHOOK_SECRET`; unset in production → 403 + warn.
   Verification uses the **raw request body** (read text first, parse after).
2. **Dedup:** Redis `SET NX EX 3600` on `resend:seen:<svix-id>`; fail-open on
   Redis error (same rationale as SES: better a rare double-apply than a
   dropped delivery event).
3. **Side effects — identical flow to ses-events:**
   - `invitationRepo.setDeliveryStatus(db, providerMessageId, status, error)`
   - `notificationDeliveryRepo.findDeliveryByProviderMessageId` →
     `markDeliveryStatus` (`delivered` / `bounced` with providerResponse)
   - BOUNCED / COMPLAINED → `notificationSuppressionRepo.add` per recipient
     with `reason: "hard_bounce" | "complaint"`, `source: "resend"`
     (column is free text — no migration)
   - COMPLAINED → flip the notification owner's email master switch, same
     query as ses-events.

## 3. Env & docs

`.env.example`:

- `EMAIL_PROVIDER=resend` documented as the default; selection comment updated
  to list `resend | ses | smtp` and the SES fallback behavior.
- New block: `RESEND_API_KEY=`, `RESEND_WEBHOOK_SECRET=`,
  `RESEND_EVENTS_VERIFY_SIGNATURE=true`.
- SES and SMTP blocks unchanged.

`lib/env.ts` additions: `RESEND_API_KEY` (optional), `RESEND_WEBHOOK_SECRET`
(optional), `RESEND_EVENTS_VERIFY_SIGNATURE` (boolean-ish string, default true —
same coercion style as `AWS_SES_EVENTS_VERIFY_SIGNATURE`).

## 4. Tests (Vitest, existing patterns)

- `mailer-resend.test.ts` — mocked fetch: success returns id; non-2xx throws
  with body; header merge includes `X-Rovenue-Id` + extra headers.
- `svix-signature.test.ts` — valid signature accepts; tampered body rejects;
  expired timestamp rejects; multiple `v1,` entries where only the second
  matches accepts; malformed secret rejects.
- `resend-events.test.ts` — mapping table above, incl. transient bounce and
  unknown type → null.
- `mailer.test.ts` (extend) — provider selection: resend happy path; resend
  without key + SES configured → SesMailer fallback; resend without anything →
  Noop.
- `resend-events` route test mirroring the ses-events route tests: 403 on bad
  signature, dedup short-circuit, suppression rows written, master switch
  flipped on complaint.

## Ops checklist (deploy-time, outside code)

1. Set `RESEND_API_KEY` and `EMAIL_FROM` (verified domain in Resend).
2. In the Resend dashboard, add a webhook endpoint →
   `https://<api-host>/webhooks/resend-events`, subscribe to
   `email.delivered`, `email.bounced`, `email.complained`; copy the signing
   secret into `RESEND_WEBHOOK_SECRET`.
