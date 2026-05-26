# Onboarding Funnel Core — Design

**Date:** 2026-05-26
**Status:** Draft
**Scope:** Sub-project A of the web-to-app onboarding feature. Covers the funnel data model, builder API, public runtime API, branching engine, claim token / SDK hand-off, and cold-install (deferred deep link) handling. Stripe Connect integration is sub-project **B**; templates marketplace and analytics are sub-project **C**.

## 1. Goals

Let Rovenue customers build Typeform-style card-based onboarding flows that collect answers, charge subscriptions on the web, and hand the resulting entitlement (plus answers) to their mobile app — including when the user installs the app fresh from the store.

Sub-project A delivers everything except the actual Stripe Connect integration and the analytics/templates marketplace, but the schema and APIs anticipate both so that B and C plug in without schema churn.

## 2. Architecture

Three API surfaces share the same data model. Each has different auth, lifecycle, and rate-limit characteristics.

### 2.1 Builder API — dashboard-facing

- Path prefix: `/v1/projects/:pid/funnels/*`, `/v1/funnel-templates/*`.
- Auth: Better Auth session + project-member middleware (existing pattern). Mutations audited via `audit()` inside the caller's Drizzle tx.
- Role gate: admin/editor can publish, viewer is read-only.

### 2.2 Public Runtime API — end-user browser

- Path prefix: `/public/funnels/*`, `/public/funnel-sessions/*`, `/universal/*`, `/public/magic/*`.
- Auth: none. CORS open. Per-funnel rate limit via Redis (60 req/min/IP, burst 20).
- Session identity: `rv_funnel_sid` cookie (HttpOnly, SameSite=Lax, 30 days). Cookie value is `funnel_sessions.id`.

### 2.3 SDK Claim API — mobile app

- Path prefix: `/v1/sdk/*`, `/v1/subscribers/claim-funnel-token`.
- Auth: project public API key (Bearer) — existing SDK pattern.

### 2.4 Cross-cutting

- ClickHouse mirror via outbox events (`funnel.session.*`, `funnel.claim_token.*`); dispatcher already exists. Materialised views are sub-project C.
- All mutations on `funnels`, `funnel_versions`, and `funnel_claim_tokens` write audit rows (per-project hash chain).
- Runtime config (`GET /public/funnels/:slug`) cached in Redis keyed by `funnel_id`; cache value is the rendered config for the current published version. On publish, the cache key is deleted so the next read fetches the new `version_id`. TTL 5 minutes as a safety net.

## 3. Data model

Eight new tables. All IDs are cuid2; all timestamps `timestamptz` UTC. Project-scoped tables carry `project_id` with FK + index.

### 3.1 `funnels`

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 |
| project_id | text FK | `projects.id`, indexed |
| slug | text | unique per project (`slugify(name)-<4 char nanoid>`) |
| name | text | editor display name |
| status | enum | `draft` \| `published` \| `archived` |
| current_version_id | text FK nullable | `funnel_versions.id`; null until first publish |
| draft_pages_json | jsonb | editor working state, see §4 |
| draft_theme_json | jsonb | colors, fonts, logo URL |
| draft_settings_json | jsonb | success URL, deep link scheme, App/Play Store URLs, Universal Link domain, dev_mode flag |
| created_at | timestamptz | |
| updated_at | timestamptz | |
| created_by | text FK | `user.id` |

Indexes: `(project_id, status)`, `unique(project_id, slug)`.

### 3.2 `funnel_versions`

Immutable snapshots produced by `publish`. Sessions are bound to a specific version so a republish never invalidates in-flight users.

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 |
| funnel_id | text FK | indexed |
| version_no | int | 1..n, monotonic per funnel |
| pages_json | jsonb | validated snapshot of `funnels.draft_pages_json` |
| theme_json | jsonb | |
| settings_json | jsonb | |
| published_at | timestamptz | |
| published_by | text FK | `user.id` |

Indexes: `unique(funnel_id, version_no)`.

### 3.3 `funnel_templates`

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 |
| name | text | |
| category | text | `fitness`, `productivity`, `ai`, `wellness`, … |
| description | text | |
| preview_image_url | text | |
| pages_json | jsonb | |
| theme_json | jsonb | |
| settings_json | jsonb | |
| scope | enum | `system` (only one used in A) \| `user` (added in C) |
| project_id | text FK nullable | required when `scope='user'` (C) |
| created_at | timestamptz | |

Indexes: `(scope, category)`, `(project_id)` partial where `scope='user'`.

System templates are seeded via migration; A ships with 6–10 categories.

### 3.4 `funnel_sessions`

One row per visitor session. Range-partitioned by `started_at` (monthly) via `pg_partman`, mirroring the existing `revenue_events` pattern.

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 (also used as cookie value) |
| funnel_id | text FK | indexed |
| funnel_version_id | text FK | immutable bind |
| project_id | text | denormalised for fast lookup |
| anon_id | text | cuid2; SDK matches with its local id post-claim |
| state | enum | `in_progress` \| `paid` \| `completed` \| `abandoned` |
| current_page_id | text | page id from `pages_json` |
| started_at | timestamptz | partition key |
| last_activity_at | timestamptz | updated on every `/answers` and `/advance` |
| completed_at | timestamptz nullable | |
| utm_json | jsonb | utm_*, referrer, gclid |
| ip_hash | text | sha256(ip + project-scoped salt) |
| user_agent | text | raw, truncated to 256 |

Indexes: `(funnel_id, started_at)`, `(state, last_activity_at)`, `(project_id, started_at)`.

### 3.5 `funnel_answers`

Range-partitioned by `answered_at` (monthly).

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 |
| session_id | text FK | |
| page_id | text | from `pages_json` |
| question_id | text | from page config |
| answer_json | jsonb | `{ "type": "single", "value": "lose_weight" }` etc. |
| answered_at | timestamptz | partition key |

Indexes: `unique(session_id, question_id)` — re-answer overwrites via UPSERT; `(session_id)`.

### 3.6 `funnel_purchases`

A creates rows in dev mode (stub paywall); B's Stripe webhook does it for real.

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 |
| session_id | text FK | unique (one purchase per session) |
| project_id | text | denormalised |
| product_id | text FK | `products.id` (existing) |
| stripe_checkout_session_id | text nullable | populated in B |
| stripe_customer_id | text nullable | |
| stripe_subscription_id | text nullable | |
| amount_cents | int nullable | |
| currency | char(3) nullable | |
| status | enum | `pending` \| `paid` \| `failed` \| `refunded` |
| paid_at | timestamptz nullable | |
| raw_payload | jsonb | webhook payload (B) or dev stub marker (A) |

Indexes: `(project_id, status, paid_at)`, `(stripe_subscription_id)`.

### 3.7 `funnel_claim_tokens`

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 |
| token_hash | bytea | sha256(plaintext); unique |
| session_id | text FK | unique |
| project_id | text | denormalised |
| email_hash | bytea nullable | sha256(lower(email)); set if funnel collected email |
| created_at | timestamptz | |
| expires_at | timestamptz | default `created_at + interval '7 days'` |
| claimed_at | timestamptz nullable | |
| claimed_by_subscriber_id | text FK nullable | `subscribers.id` |

Indexes: `unique(token_hash)`, `(email_hash) where email_hash is not null`, `(expires_at)`.

Atomic claim: `UPDATE funnel_claim_tokens SET claimed_at = now(), claimed_by_subscriber_id = $1 WHERE id = $2 AND claimed_at IS NULL RETURNING *;` — exactly-once guarantee even under concurrent claims.

### 3.8 `funnel_deferred_claims`

iOS cold-install fingerprint matching.

| Column | Type | Notes |
|---|---|---|
| id | text PK | cuid2 |
| token_id | text FK | `funnel_claim_tokens.id` |
| platform | enum | `ios` (Android uses Install Referrer instead) |
| ip_hash | bytea | |
| user_agent | text | truncated |
| locale | text | `en-US`, `tr-TR` |
| timezone | text | IANA `Europe/Istanbul` |
| screen_dims | text | `390x844` |
| device_model | text nullable | |
| created_at | timestamptz | |
| expires_at | timestamptz | default `created_at + interval '1 hour'` |
| matched_at | timestamptz nullable | |
| matched_install_id | text nullable | SDK-provided install identifier |

Indexes: `(ip_hash, expires_at) where matched_at is null`, `(token_id)`.

## 4. Pages JSON schema

Stored in `funnel_versions.pages_json` (and the editor mirror `funnels.draft_pages_json`). Validated with Zod on read and on publish.

```ts
type Page =
  | QuestionSinglePage | QuestionMultiPage | TextInputPage | NumberInputPage
  | DatePage | SliderPage | RatingPage
  | InfoPage | LoadingPage | ResultPage | PaywallPage | SuccessPage;

interface BasePage {
  id: string;                  // cuid2, stable across edits
  type: PageType;
  next_rules?: NextRule[];     // branching, see §5
  default_next?: string | 'paywall' | 'end';
}

interface QuestionSinglePage extends BasePage {
  type: 'question_single';
  config: {
    question_id: string;       // stable; answers reference this
    title: string;
    subtitle?: string;
    options: Array<{ id: string; label: string; value: string; icon?: string }>;
    required?: boolean;
  };
}

// QuestionMultiPage: same shape, type 'question_multi', answer is value[].
// TextInputPage.config: { question_id, title, placeholder, validation: 'email'|'text'|'url' }
// NumberInputPage.config: { question_id, title, min?, max?, step?, suffix? }
// DatePage.config: { question_id, title, min_date?, max_date? }
// SliderPage.config: { question_id, title, min, max, step, label_format? }
// RatingPage.config: { question_id, title, scale: 5|10, icon: 'star'|'heart' }
// InfoPage.config: { title, body_markdown, image_url?, cta_label? }    // no answer
// LoadingPage.config: { title, duration_ms, steps?: string[] }          // no answer; auto-advance
// ResultPage.config: { title_template, body_template }                  // {{answers.goal}} placeholders
// PaywallPage.config: { product_id, trial?: { days: 3|7 }, headline, bullets[] }
// SuccessPage.config: { headline, body, open_app_label }               // triggers claim_token fetch
```

Builder must guarantee `question_id` uniqueness across a funnel; publish validation rejects duplicates.

## 5. Branching engine

Each page carries `next_rules: NextRule[]`. First matching rule wins; if none match, `default_next` is used; if absent, the next sequential page.

```ts
interface NextRule {
  id: string;
  condition: { op: 'all' | 'any'; clauses: Clause[] };
  goto: string | 'paywall' | 'end';
}

interface Clause {
  question_id: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
     | 'in' | 'not_in' | 'contains'
     | 'is_answered' | 'is_not_answered';
  value?: unknown;             // type depends on op
}
```

### 5.1 Evaluator

Pure function over `(page, answers, pagesById)`. No I/O, no global state. Server-side only — clients never see `next_rules`. `GET /public/funnels/:slug` strips `next_rules` from the returned payload.

### 5.2 Publish-time validation

`POST /v1/projects/:pid/funnels/:fid/publish` runs:

1. **Zod schema check** on every page (type-discriminated union).
2. **Question id uniqueness** across pages.
3. **Reference integrity**: every `clauses[].question_id` resolves to some page's `config.question_id` that appears earlier or on the same level.
4. **Graph validation** (DFS from the entry page):
   - No cycles (detect via gray-stack).
   - At least one path reaches a terminal (`end` or success page after `paywall`).
   - Unreachable pages → warning (not error).
5. **At least one paywall page** and **at least one success page**. Multiple success pages are allowed (e.g. different copy per branch) — each must be reachable.

Failure response: `400 { error: { code: 'FUNNEL_VALIDATION', issues: [{ path, message }] } }`.

### 5.3 Back-edit semantics

When a user goes back and changes an answer, then advances forward:

- The answer is overwritten in `funnel_answers` (UPSERT).
- The branching evaluator re-runs from the edited page.
- Subsequent answers for pages that are no longer on the path are kept in DB (for analytics) but ignored when reconstructing the visible page sequence.
- `funnel_sessions.current_page_id` is updated to the new evaluator output.

## 6. API surfaces

### 6.1 Builder API

```
GET    /v1/projects/:pid/funnels                   list (?status=)
POST   /v1/projects/:pid/funnels                   create blank or fromTemplate
GET    /v1/projects/:pid/funnels/:fid              detail (draft + published meta)
PATCH  /v1/projects/:pid/funnels/:fid              update name/slug/draft_*
DELETE /v1/projects/:pid/funnels/:fid              soft-archive

POST   /v1/projects/:pid/funnels/:fid/publish      snapshot draft -> funnel_versions
POST   /v1/projects/:pid/funnels/:fid/duplicate    copy as new funnel
POST   /v1/projects/:pid/funnels/:fid/revert/:vid  copy version into draft
GET    /v1/projects/:pid/funnels/:fid/versions     list published versions

GET    /v1/funnel-templates                        system templates (and user-saved in C)
GET    /v1/funnel-templates/:tid                   template detail

GET    /v1/projects/:pid/funnels/:fid/sessions     paginated session list (basic; C extends)
GET    /v1/projects/:pid/funnels/:fid/sessions/:sid  session + answers
```

Envelope: `{ data: T }` on success, `{ error: { code, message, ... } }` on failure (existing pattern).

### 6.2 Public Runtime API

```
GET    /public/funnels/:slug
  -> { data: { id, version_id, pages, theme, settings } }  // pages have next_rules stripped

POST   /public/funnels/:slug/sessions
  body: { utm?: object, referrer? }
  -> { data: { session_id, first_page_id } }
  Set-Cookie: rv_funnel_sid=<session_id>; HttpOnly; SameSite=Lax; Max-Age=2592000

POST   /public/funnel-sessions/:sid/answers
  body: { page_id, question_id, answer }
  -> { data: { ok: true } }

POST   /public/funnel-sessions/:sid/advance
  body: { from_page_id }
  -> { data: { next: 'page' | 'paywall' | 'end', page_id?: string } }

GET    /public/funnel-sessions/:sid/state
  -> { data: { current_page_id, state, has_claim_token } }

POST   /public/funnel-sessions/:sid/claim-token
  -> { data: { token, deep_link_url, universal_link_url } }
  409 if state not in {paid, completed}
```

### 6.3 Universal Link landing (cold install)

```
GET    /universal/funnels/open/:token
  - User-Agent sniffing + Apple AASA / Android App Links handling
  - If app installed: OS intercepts before this endpoint is reached
  - Android: 302 to Play Store with referrer encoding token id
  - iOS: write funnel_deferred_claims row from request headers, 302 to App Store URL from settings_json
  - Fallback: simple HTML page with manual store buttons
```

The token in the URL is the same plaintext returned by `/claim-token`. Token does not appear in logs after this point (server logs token id, not plaintext).

### 6.4 SDK API

```
POST   /v1/subscribers/claim-funnel-token
  Authorization: Bearer <project_public_key>
  body: { token, anon_id }
  -> {
       data: {
         subscriber_id,
         entitlements: Entitlement[],
         funnel_answers: { [question_id: string]: unknown }
       }
     }
  - Atomic claim (UPDATE ... WHERE claimed_at IS NULL).
  - Idempotent: same anon_id reclaim returns 200; different anon_id returns 409.
  - 410 if expired; 404 if hash not found (constant-time compare).

POST   /v1/sdk/claim-install
  Authorization: Bearer <project_public_key>
  body: {
    platform: 'ios' | 'android',
    locale, timezone, screen_dims, device_model,
    install_referrer?: string,        // Android Play Install Referrer raw
    install_id: string                 // SDK-generated; idempotency key
  }
  -> { data: { token } } | 404
  - Android: parse install_referrer, extract token id, return token.
  - iOS: fingerprint match against funnel_deferred_claims
        (ip_hash exact + locale + timezone + screen approx, within 1h).
  - On match: mark deferred_claim row matched_at + matched_install_id.

POST   /v1/sdk/claim-via-email
  Authorization: Bearer <project_public_key>
  body: { email, install_id }
  -> 202 (magic-link email queued via SES)
  - Looks up funnel_claim_tokens by email_hash (most recent unclaimed).

GET    /public/magic/:nonce
  - Mail link target. Constructs deep link with token; if app present opens it,
    otherwise renders an "Open in App" page.
```

## 7. Session & purchase lifecycle

```
created (POST /sessions)
   |
   v
in_progress  -- /advance, /answers --
   |     \
   |      \-- timeout 24h --> abandoned
   |
   |  (paywall reached)
   |
   v
[Stripe Checkout (B) or dev stub (A)]
   |
   v
paid          (funnel_purchases.status='paid', funnel_claim_tokens row created)
   |
   |  (runtime calls /claim-token, success page rendered)
   v
completed    (set when user taps "Open App" OR SDK claims token)
```

Background jobs (BullMQ):

| Job | Cadence | Effect |
|---|---|---|
| `funnel-session-abandoner` | hourly | `state='in_progress' AND last_activity_at < now() - 24h` -> `abandoned` |
| `funnel-token-expirer` | daily | log + telemetry for tokens past `expires_at` without claim |
| `funnel-deferred-claim-cleanup` | every 5m | DELETE expired `funnel_deferred_claims` |

## 8. Claim token security

- Plaintext token: 32 random bytes, base64url-encoded (43 chars).
- DB stores `sha256(plaintext)` only — DB compromise does not yield usable tokens (existing `api_keys` pattern).
- Lookup uses `crypto.timingSafeEqual` against the hashed value via parametric query — Postgres `bytea` compare is constant-time at the page level.
- Deep link URLs containing the plaintext are not logged. Application logs reference `token_id` only.
- Cross-project enumeration: requests must include the project public API key (Bearer); the token row is also bound to a `project_id`. Mismatch returns 404 (not 403) to avoid revealing existence.

## 9. Cold-install handling (3 layers)

| Layer | Platform | Reliability | Mechanism |
|---|---|---|---|
| 1 | Android | ~95% | Play Install Referrer API; landing redirects to Play Store with `referrer=rovenue_funnel_token%3D<token>`; SDK reads on first launch, calls `/v1/sdk/claim-install` with `install_referrer`. |
| 2 | iOS | ~75-85% | Server-side fingerprint match; landing writes `funnel_deferred_claims` row, redirects to App Store; SDK calls `/v1/sdk/claim-install` with `{ platform, locale, timezone, screen_dims, device_model }`; server matches within 1h window. |
| 3 | Either | ~100% with friction | Email magic link; funnel must include an email step before paywall; `funnel_claim_tokens.email_hash` is populated; SDK calls `/v1/sdk/claim-via-email`; user clicks mail link to surface token in app. |

SDK should run layers in order on first launch:

1. If platform Android and Install Referrer present and parseable → layer 1.
2. Else call `/v1/sdk/claim-install` with fingerprint → layer 2.
3. If still no token after, e.g., 2 seconds → show email entry UI → layer 3.

Builder UX (handled by design side):

- Funnel settings require **App Store URL**, **Play Store URL**, **Universal Link domain**, **deep link scheme**.
- Builder warns when no email page exists before paywall: "Without an email step, ~15-25% of cold-install conversions may be lost."

## 10. Paywall page in sub-project A (stub mode)

Sub-project A schema is fully Stripe-aware (all `stripe_*` columns exist on `funnel_purchases`) but does not integrate Stripe.

Dev-mode is read from the **published** `settings_json.dev_mode` flag (copied from draft on publish), not from drafts directly. This means the runtime check is identical for draft preview (via a builder "Preview" route that serves the draft) and published serving.

- **Dev mode** (`settings_json.dev_mode === true` AND server `NODE_ENV !== 'production'`): paywall page renders a "Skip payment (dev)" button. Tap → backend writes a `funnel_purchases` row with `status='paid'`, `raw_payload={ stub: true }`, then writes the `funnel_claim_tokens` row and transitions session to `paid`. End-to-end flow works without Stripe.
- **Production server** (`NODE_ENV === 'production'`): the dev_mode flag is ignored. Paywall page renders a "Payment provider not configured" message until sub-project B lands. The publish validator additionally rejects (in production deployments) funnels containing a paywall page when the project has no Stripe Connect link — sub-project B adds that link and lifts the rejection.

## 11. Outbox events (for sub-project C)

A writes outbox rows; the existing dispatcher routes them to Kafka. C consumes them into ClickHouse.

| Event | Trigger |
|---|---|
| `funnel.session.started` | `POST /sessions` |
| `funnel.session.advanced` | `POST /advance` (debounced — only on next-page change) |
| `funnel.session.paid` | dev stub paywall OR Stripe webhook (B) |
| `funnel.session.completed` | claim token first claimed |
| `funnel.session.abandoned` | abandoner job |
| `funnel.claim_token.issued` | row created |
| `funnel.claim_token.claimed` | atomic claim |

Payload includes `funnel_id`, `version_id`, `session_id`, `project_id`, `at`, plus event-specific fields. Existing audit infrastructure remains separate (project-scoped hash chain).

## 12. Testing

| Layer | Coverage |
|---|---|
| Unit | Branching evaluator (operator matrix, missing/null answers, type coercion); publish validator (cycles, orphans, missing terminal, duplicate question_id); token hash + constant-time compare; fingerprint normalisation. |
| Repository | Funnel CRUD; draft → publish → versions immutability; session lifecycle transitions; claim atomicity (concurrent claim → one success); deferred claim TTL. |
| Integration (`*.integration.test.ts`, testcontainers) | Real Postgres + Redis; funnel create → publish → public GET → session create → answers → advance → dev-stub paywall → claim token → SDK claim. Separate suite for cold-install: landing → deferred row → SDK fingerprint claim. |
| Contract | Zod schemas exported as OpenAPI; consumed by SDK team. |
| Load | `GET /public/funnels/:slug` and `POST /advance` baselined at 5k rps; published version cache in Redis (TTL 5 min, invalidated on publish). |

## 13. Out of scope (handed to B / C)

**Sub-project B — Stripe Connect & paywall integration**

- Stripe Connect OAuth onboarding for the project (`project_stripe_connections` table).
- Checkout Session creation tied to `funnel_purchases`.
- Webhooks: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, refunds.
- Replace dev-stub paywall path with real Stripe flow.
- Refund + dispute handling on `funnel_purchases` and downstream `subscriber_access`.

**Sub-project C — Templates & analytics**

- User-saved templates (`funnel_templates.scope='user'` + project_id), "Save as template" UI.
- Template marketplace (v3, deferred).
- ClickHouse materialised views: `funnel_sessions_mv`, `funnel_answers_mv`, `funnel_conversion_mv`, `funnel_revenue_mv`.
- Dashboard analytics panel: drop-off per page, RPV, conversion to paid, time-to-completion, A/B comparison.

## 14. Open questions

- **Plan quota**: how many funnels per project at each pricing tier? Coordinate with billing spec.
- **i18n**: MVP supports a single language per funnel (the language the customer authored in). Multi-locale funnels (locale switcher, per-locale page copy) deferred.
- **Custom domain**: not in A; future feature behind a flag, requires DNS verification + Let's Encrypt.
- **GDPR / KVKK**: `funnel_answers` may contain PII. Extend the existing anonymize/export endpoints to include funnel data — handled in C alongside analytics, but the work could be pulled into A if compliance ships sooner.
- **Resume across devices**: the cookie scopes resume to a single browser. Cross-device resume (login or email) is out of scope for MVP; document as a known limitation.

## 15. Data ownership split (UX vs BE)

- **Backend (this spec)**: data model, all API surfaces, branching evaluator, publish validator, claim flow, cold-install service, background jobs, outbox events, tests.
- **Design / frontend (separate plan)**: builder UI (drag-drop pages, page editor panels, branching rule editor, theme editor, publish button, preview), public runtime renderer per page type, success page deep-link button, dashboard funnel list page, session detail panel.

The interface between the two is the JSON shape in §4 and the API surfaces in §6. Both sides can develop in parallel against the published Zod/OpenAPI schema.
