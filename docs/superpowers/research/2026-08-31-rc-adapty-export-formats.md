# RevenueCat & Adapty: export/import surface for a self-hosted migration tool

Research date: 2026-08-31. Time-boxed (~20 min, ~15 fetches). First-party sources only unless
explicitly labeled "third-party" or "community". Anything not directly confirmed is marked
**unconfirmed** rather than guessed.

---

## 1. Export mechanisms

### RevenueCat

| Mechanism | Self-serve? | Plan gate | Notes |
|---|---|---|---|
| **Scheduled Data Exports** | Yes, fully self-serve from the dashboard | "Pro integration — available to all users signed up after September '23, the legacy Grow and Pro plans, and Enterprise plans." Legacy Free/Starter must migrate pricing plans first. | Destinations: S3, GCS, Azure Blob, or **Email**. Format: CSV or Parquet. Built from **feeds** (datasets), each with its own selectable **column catalog** — you pick which columns land in the file. Default cadence: once/day. Enterprise-only: incremental feeds can run every 4/6/8/12/24h; anything outside those cadences requires contacting your CSM. Source: https://www.revenuecat.com/docs/integrations/scheduled-data-exports |
| **Feeds available** | — | — | Confirmed feeds: **Transactions** (incremental, supports "new & updated rows only"), **Virtual Currency** (full-snapshot only, re-exports entire ledger every run, no incremental mode). A Subscriber-level feed also exists per the docs' "Available feeds" framing but its full column table wasn't retrievable this session (see gaps). |
| **REST API** (`GET /subscribers/{app_user_id}`) | Self-serve (API key) | Not verified this session whether the API itself is plan-gated | **No bulk "list all customers" endpoint exists.** It's single-customer lookup only — confirmed via RevenueCat's own community forum threads (third-party/community-sourced, but consistent with the absence of any such endpoint in RC's API reference): "RevenueCat does not currently have an API endpoint to retrieve all customers... to enumerate all customers you would need to make individual API calls for each user ID." RC's own recommended workaround for bulk data is the Scheduled Data Export, not the API. Source (community, labeled as such): https://community.revenuecat.com/general-questions-7/single-api-get-request-for-the-current-full-list-of-subscribers-1166 |
| **Webhooks** | Self-serve | Not re-verified this session | RC has a documented Webhooks integration with lifecycle event types (INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION, BILLING_ISSUE, etc.) and an `aliases` array in the payload. This is well-established from RC's public docs but I did not re-fetch the webhooks page this session — treat the exact event list as **unconfirmed** for this report and re-verify before building an importer against it. |
| **"Export everything" / GDPR self-service** | **Not found** | — | I did not locate a documented single "export all my account data" button or GDPR data-export flow in the pages I could reach this session. Absence is **unconfirmed** (not exhaustively searched) — worth a direct check of RC's privacy/trust-center pages before telling users this doesn't exist. |
| **Dashboard one-off CSV** | Not separately confirmed | — | The dashboard's "Customer Lists" feature can filter subscribers by attributes and export a list (mentioned in community sourcing only, not fetched first-party this session) — treat as **unconfirmed** detail, not a verified mechanism. |

### Adapty

| Mechanism | Self-serve? | Plan gate | Notes |
|---|---|---|---|
| **Amazon S3 export** | Self-serve to configure (dashboard integration) | Not confirmed which plan tier gates it this session | Delivers CSV files daily at 4:00 UTC, one file per previous UTC calendar day, to a customer's own S3 bucket. Also supports a **manual one-off export** for an arbitrary date range (from Date A 00:00:00 UTC to Date B 23:59:59 UTC). Configurable toggles: "Exclude Historical Events" (events before the user installed the app with Adapty SDK), "Include events without profile" (purchases made before SDK install, or store-server-notification transactions Adapty can't yet tie to a profile). Source: https://adapty.io/docs/s3-exports |
| **Analytics Export API** | Self-serve, authenticated API | Not confirmed | A dedicated "Analytics Export API" (distinct from S3) exports analytics data as CSV or JSON on demand. Source: https://adapty.io/docs/api-export-analytics, https://adapty.io/docs/export-analytics-api |
| **Server-side API v2** | Self-serve | Not confirmed | Adapty has a documented Server-Side API v2 (auth, requests, guides for "sync purchases between web and mobile," "sync transactions from custom stores," "grant access levels manually"). This is a live read/write API against current state, not a bulk historical export mechanism per se. |
| **Historical-data import (inbound, not outbound)** | **Not self-serve** — requires contacting Adapty support | — | See §4. Relevant here because Adapty explicitly documents accepting a RevenueCat export CSV as-is for this purpose. |
| **Webhooks** | Presumed to exist (Adapty markets integrations broadly) | Not verified this session | Not directly confirmed via a fetched Adapty webhooks doc this session — mark **unconfirmed**, re-check before relying on it. |

---

## 2. Export schema — field-level detail

### RevenueCat — Transactions feed (Scheduled Data Exports, confirmed live from docs)

Source: https://www.revenuecat.com/docs/integrations/scheduled-data-exports (fetched 2026-08-31). This
is the column table for the **Transactions** feed specifically — I could not retrieve the full
Subscriber-feed column table this session (gap, see §"What I could not confirm").

| Column | Meaning (quoted/paraphrased from docs) | Type | Nullable |
|---|---|---|---|
| `rc_original_app_user_id` | Canonical (post-merge) app user ID for the subscriber/transaction. | string | — |
| `rc_last_seen_app_user_id_alias` | Most recent alias seen for this app user ID; used together with `rc_original_app_user_id` to match against your own system's identifiers. | string | — |
| `country` | Store country of the transaction when known, else an IP-based estimate. | string | ✅ |
| `country_source` | `from_sdk` (known) or `estimated` (IP-based). | string | ✅ |
| `product_identifier` | Product purchased. **Stripe caveat:** can be a Stripe Price ID (`price_...`), a legacy Stripe Product ID (`prod_...`), or a manually-specified string, depending on how/when the Stripe product was created/imported — RC does **not** auto-migrate old mappings, so a single export can contain a mix of `prod_...`/`price_...`/custom values, and there is **no separate column for the parent Stripe Product ID** when a Price ID is used. | string | — |
| `product_display_name` | Display name set for the product, if any. | string | ✅ |
| `product_duration` | Standard duration of the product (ISO-8601 period, e.g. `P1M`) — **not** the trial/intro length. | string | ✅ |
| `start_time` | Purchase time of the transaction. UTC, e.g. `2023-01-01 08:27:06`. | datetime | — |
| `end_time` | Expected expiration time. Null if `is_auto_renewable = false`. **Google quirk:** can be *before* `start_time` — this is Google's mechanism for invalidating a transaction (e.g. failed billing); doesn't happen on iOS. | datetime | ✅ |
| `grace_period_end_time` | Grace-period expiration, if applicable; stays set even after exiting the grace period without renewing. Null if never in a grace period. | datetime | ✅ |
| `effective_end_time` | Single normalized reference point for "when does this subscriber lose access" — accounts for each store's own refund/grace-period logic. Recommended field for computing "Active Subscriptions." | datetime | ✅ |
| `store` | `app_store`, `play_store`, `stripe`, or `promotional`. | string | — |
| `is_auto_renewable` | true/false. | boolean | — |
| `is_trial_period` | true if this transaction was a trial. | boolean | — |
| `is_in_intro_offer_period` | true if in an introductory-offer period. | boolean | — |
| `is_sandbox` | true if a sandbox/test transaction. | boolean | — |
| `is_trial_conversion` | true if this row is the paid conversion following a trial (used to distinguish "new" vs "resubscribe" cohorts in RC's own sample MRR queries). | boolean | — |
| `renewal_number` | Sequence number of this transaction within a subscription chain; **starts at 1 even for trials**; a trial→paid conversion still increments it. | integer | — |
| `ownership_type` | Distinguishes e.g. `FAMILY_SHARED` transactions (used in RC's own sample queries to exclude family-shared access from MRR/active-sub counts). | string | — |
| `refunded_at` | When a refund was detected; null if none. | datetime | ✅ |
| `unsubscribe_detected_at` | Non-null once RC detects the user has turned off auto-renew (used to derive "set to cancel" vs "set to renew" state). | datetime | ✅ |
| `price_in_usd` | Revenue converted to USD. | decimal | — |
| `custom_subscriber_attributes` / `reserved_subscriber_attributes` | JSON blobs (curly-brace format) of developer-set / RC-reserved subscriber attributes. | json string | ✅ |
| `updated_at` | Last time this transaction row's data changed — recommended anchor for reconciling multiple deliveries of the same transaction (export is a snapshot, so the same logical transaction can appear differently across deliveries if e.g. refunded later). | datetime | — |

Additional confirmed facts about this feed, not columns:
- Because Stripe doesn't guarantee a unique `store_transaction_id` per transaction, RC's own guidance is to treat **`store_transaction_id` + `renewal_number`** as the unique key.
- **Timestamps are UTC** ("All dates and times are provided in UTC" — stated explicitly for the Virtual Currency feed and consistent with the datetime examples shown for Transactions).
- Refund fields seen on the **Virtual Currency** feed (and presumably applicable to Transactions too, unconfirmed there): `refund_amount_usd`, `refund_amount_in_purchased_currency`, `refund_type` — populated only on refund-type rows.
- `entitlement_identifiers`: exists as an export field (confirmed via RC's own changelog referencing "Data Export Version 4"), delivered as an array. **Version-dependent format**: changed from a different bracket convention in earlier versions to `[ ]` (square brackets) in Version 4, while `reserved_subscriber_attributes`/`custom_subscriber_attributes` remain `{ }` JSON objects. I could not retrieve the full column table this session to confirm whether it's a single array column or one row per entitlement — **unconfirmed, verify against v4/v5 docs directly**.
- **Export schema is versioned**: RevenueCat documents at least Data Export Version 3, 4, and — per search results — a **Version 5** exists as of this writing. This is explicitly **version-dependent**; an importer must pin to (or detect) a specific export version rather than assume one fixed schema.
- Google Play purchase tokens are **not** a column in the standard Transactions export (see §3 — this is the most important gap for an importer).

### RevenueCat identity fields recap (also appear on Subscriber-type feeds per the docs' framing)
`rc_original_app_user_id` (canonical ID) and `rc_last_seen_app_user_id_alias` (most recent alias) are the two identity columns actually shipped in exports — see §5 for the full identity model.

### Adapty — S3 export

Source: https://adapty.io/docs/s3-exports (fetched 2026-08-31). **Gap:** the page's configuration
options (event/tag toggles) were retrievable, but the literal per-file column table was not
recovered in the content I could pull this session — treat the column list below as directional,
not verified, and re-fetch this page directly before building a parser:

- Qualitatively documented: "a table to store historical data for transaction events and paywall
  visits, which contains information about the **user profile, revenue and proceeds, and the
  origin store**, among other data points" (from search-engine summary of Adapty's docs, not a
  direct quote I could re-verify against the fetched page content — **label this claim as
  lower-confidence**).
- Delivery: daily at 4:00 UTC, one file per previous UTC day; manual export supports an arbitrary
  UTC date range.

### Adapty — historical-data **import** file schema (this is the one Adapty schema I got field-level detail on)

Source: https://adapty.io/docs/importing-historical-data-to-adapty (fetched 2026-08-31). This is
technically Adapty's *inbound* CSV contract (what they'll accept to backfill history), but since
Adapty explicitly says a RevenueCat export can be sent to satisfy it unchanged, it's the closest
thing to a documented field mapping between the two vendors:

Required fields per platform:

| Platform | Required columns |
|---|---|
| iOS | `user_id`, `apple_original_transaction_id` (StoreKit 2 Original Transaction ID; multiple OTIDs per user are fine — one row each) |
| Android | `user_id`, `google_product_id`, `google_purchase_token`, `google_is_subscription` |
| Stripe | `user_id`, `stripe_token` |

Rules: one CSV per platform (don't mix iOS/Android/Stripe in one file), headers must exactly match
Adapty's documented column names, no extra columns, values are comma-separated and **not**
quote-enclosed, and multiple `apple_original_transaction_id`s for one user must be separate rows
(otherwise consumable purchases may fail to restore). `created_at` is optional but recommended for
correct cohort/install-date attribution (falls back to first-purchase date if omitted). Apple
import additionally requires the customer's In-App Purchase API key to already be uploaded in the
Adapty dashboard.

Fields also mentioned as part of what Adapty ingests per transaction during an RC-sourced import
(from the RC-migration doc's table, not the general CSV-import doc): `user_id` (Customer User ID),
`apple_original_transaction_id`, `google_product_id`, `google_purchase_token`, `created_at`,
`subscription_expiration_date`, `email`, `phone_number`, `idfa`, `idfv`.

---

## 3. What is NOT exportable / NOT preserved

### RevenueCat
- **Google Play purchase tokens are not in the standard Scheduled Data Export.** Direct quote (from Adapty's own migration doc, describing RC's export): *"The Google Purchase Token is a unique identifier provided by Google Play... This information is **not included in the standard export file**."* To get it you must separately contact RevenueCat support (via `app.revenuecat.com/settings/support`) for a **support-mediated CSV** containing exactly three columns: `user_id`, `google_purchase_token`, `google_product_id`. This is a self-serve export with a support-gated exception for one specific, migration-critical field. Source: https://adapty.io/docs/migration-from-revenuecat
- **No raw Apple/Google store receipt blob** is documented as exportable — RC's exports are normalized/derived fields, not the original JWS/receipt payloads. (Not explicitly stated as "you cannot get this" in the docs I reached — **unconfirmed by omission**, but there is no column or mechanism described for it anywhere in the Scheduled Data Exports docs.)
- **No bulk customer-list REST endpoint** — API is one-customer-at-a-time (see §1).
- **Historical depth caveat, not an export limitation but a data-completeness one**: "If you migrated to RevenueCat, Google subscriptions that were expired for more than 60 days before being migrated will not have transaction histories in export files" — i.e. if a customer's data already passed through a lossy migration into RC from some earlier system, that loss propagates into what you can get out of RC. Source: https://www.revenuecat.com/docs/integrations/scheduled-data-exports
- **Paywall/experiment/audience configuration**: no export mechanism for these was found anywhere in the docs reached this session. The only documented feeds are Transactions, Virtual Currency, and (per the page's framing) a Subscriber feed — paywall builder JSON, experiment definitions, and offering/audience configuration are not among them. Treat as **not exportable via any documented self-serve mechanism** unless proven otherwise.
- Snapshot semantics: transaction rows reflect "a snapshot of the current receipt state," so a delivered row can retroactively look different from an earlier delivery (e.g., after a refund) — there is no durable, immutable append-only event log exposed by this mechanism, only current-state snapshots keyed by `updated_at`.

### Adapty
Adapty is unusually explicit about this in its own migration doc — direct quote, "What doesn't
come across" (when importing RC data into Adapty), source
https://adapty.io/docs/migration-from-revenuecat:
- *"Every transaction is re-validated with the store during import, so rows the store no longer recognizes are dropped."*
- *"Rows without a real store transaction ID — for example, RevenueCat promotional or manually granted entitlements — import as profiles without transactions."* (Must be re-granted manually via Adapty's server-side `grantAccessLevel` API afterward.)
- *"Refund and billing-issue history isn't carried over verbatim: a refund keeps only its cancellation date, and a subscription's billing-issue state is recorded as of the import, not with the historical dates."*

Additional Adapty-side import limitations (from the general historical-import doc, "Known
limitations for Android"):
- *"Only active subscriptions will be restored; expired transactions will not be."*
- *"Only the latest renewals in a subscription will be restored; the entire chain of purchases will not be."*
- *"If the product price has changed since the purchase, the current price will be used, which may result in incorrect pricing."*
- Large Android transaction volumes may need a Google Play Developer API quota increase before import.

These are import-side limits (what Adapty can rebuild from someone else's data), which is exactly
the failure mode a Rovenue importer needs to warn users about symmetrically: **event history,
original historical pricing, and full renewal chains are not guaranteed to survive any
migration in either direction** — this looks like an industry-wide limitation driven by store
re-validation at import time, not an Adapty-specific gap.

- No documented mechanism for exporting Adapty's own paywall/A-B-test/experiment configuration was found this session (not searched directly — **unconfirmed**, worth a dedicated check against Adapty's Paywall Builder docs).

---

## 4. Each vendor's own migration story (the parity bar)

### Adapty → "Migrate from RevenueCat to Adapty" (official, ~20 min guide)
Source: https://adapty.io/docs/migration-from-revenuecat (fetched 2026-08-31)

1. Configure Adapty dashboard, install Adapty SDK, swap RC SDK calls for Adapty equivalents (e.g.
   `Purchases.shared.getCustomerInfo` → `Adapty.getProfile`).
2. Switch App Store/Play server-side notifications to point at Adapty instead of RC (optionally
   keep forwarding raw events to RevenueCat during the transition).
3. Release the new app version. **All users who have ever activated a subscription move to Adapty
   automatically the moment they open the new version** — because Adapty's SDK reads current
   entitlements directly from StoreKit/Play Billing on `activate()` and syncs them to a new Adapty
   profile; this is a live-entitlement resync, not a data migration, so it only recovers *currently
   active* access, not history.
4. **Historical data is a separate, manual, support-mediated step**: "Write us to import your
   historical data" — email/messenger `support@adapty.io` with the CSV (an RC scheduled-export CSV
   works as-is), plus a separately-requested RC "Google Purchase Tokens" CSV if you need Android
   history, and you must tell Adapty support which field to key identity on
   (`rc_original_app_user_id` or `rc_last_seen_app_user_id_alias`). A human at Adapty runs the
   import; there is **no self-serve/authenticated bulk-import API** for this documented.
5. Test in sandbox, release.

Adapty's FAQ within that doc explicitly says you don't need to rush the historical-data hand-off —
you can ship the SDK swap first and send data later.

### RevenueCat → "Migrate to RevenueCat" (official, generic — not Adapty-specific)
Source: https://www.revenuecat.com/docs/migrating-to-revenuecat/migration-paths (fetched 2026-08-31)

Much thinner than Adapty's competitor-specific guide — it's a generic "bring your subscriptions
into RC as source-of-truth" overview, not a step-by-step from a named competitor. Key line: *"There
are mobile SDK methods to migrate customers or REST APIs and bulk scripts to perform server-side
migrations."* This implies RC does offer some import-side API/bulk-script tooling for bringing
subscriber data in, but the specific endpoint(s) were not retrieved this session (time-boxed) —
**unconfirmed at the field/endpoint level**, would need a follow-up fetch of the linked sub-pages
(e.g. "migrating existing subscriptions").

### Parity takeaway for the Rovenue guide
Neither vendor's inbound path is a pure, authenticated, self-serve bulk-import API against
arbitrary historical data:
- RevenueCat's *outbound* export is fully self-serve (Scheduled Data Exports); its *inbound*
  migration path is thin docs pointing at SDK methods + unspecified "bulk scripts."
- Adapty's *outbound* exports (S3, Analytics API) are self-serve; its *inbound* historical-data path
  for competitor migrations is explicitly **support-mediated, not self-serve** (email a human a CSV).
- Both vendors re-validate against the store at import/restore time and both drop or degrade
  refund/cancellation history and full renewal chains in that process.
- **This sets a low, easily-beatable parity bar**: a Rovenue importer that accepts a RC Scheduled
  Data Export CSV/Parquet directly (which Adapty already treats as a de facto interchange format)
  and does its own store re-validation would already match or exceed both vendors' documented
  self-serve capability.

---

## 5. Identity model

### RevenueCat
- **`app_user_id`** is the primary identifier: either a developer-supplied custom ID, or an
  auto-generated anonymous ID of the form `$RCAnonymousID:<hex>` if none is set.
- **Merging/aliases**: anonymous and custom App User IDs can be merged over time (e.g. on login, or
  on a "restore purchases" action), per the project's configured restore behavior. After a merge,
  there is exactly **one** canonical ID left in the `original_app_user_id` field; the other,
  now-historical IDs are exposed as an **`aliases` array** on Webhook payloads. Any of the merged
  IDs, looked up via SDK or API, resolves to the same `CustomerInfo` (same subscription status,
  attributes, history). Source: https://www.revenuecat.com/docs/customers/identifying-customers
- **In exports**, this collapses to two columns: `rc_original_app_user_id` (canonical/merged ID) and
  `rc_last_seen_app_user_id_alias` (most recently seen alias) — "used together to match ... with
  user identifiers in your systems." There is **no full alias-history array** in the export schema
  as documented (only "last seen"), which means an importer reconstructing a subscriber's full
  historical alias chain from exports alone may be lossy — the full chain would need the Webhooks
  payload's `aliases` array captured live, not the batch export.

### Adapty
- Adapty auto-creates an **internal `profile_id`** for every user on SDK activation — this is
  Adapty's own opaque row identifier, roughly analogous to RC's internal customer row (not
  developer-facing as a primary key in normal use).
- **`customer_user_id` (CUID)** is the developer-supplied external identity key, set via
  `Adapty.identify()` — this is the one meant to map onto a customer's own backend user ID, and it's
  what Adapty matches profiles on for cross-device continuity.
- **Identity continuity depends entirely on what you use as the CUID** (direct quote,
  https://adapty.io/docs/identifying-users):
  - CUID = raw `device_id` and no login → a new device gets a *different* CUID → a *different*
    profile. The active subscription still syncs onto the new profile via an "Access level updated"
    event (because Adapty reads current entitlements from StoreKit/Play Billing directly), but
    `subscription_started` does **not** re-fire, so analytics keyed on that event undercounts
    returning users, and the new profile is only an "inheritor" of the original purchase, not a
    unified identity.
  - CUID = a stable account ID set on every device/login → `identify()` matches the existing
    profile automatically; both identity and subscription state resolve correctly.
- **Mapping ambiguity when migrating in**: Adapty's own RC-migration doc makes the customer choose
  which RC field becomes the Adapty CUID — `rc_original_app_user_id` or
  `rc_last_seen_app_user_id_alias` — i.e., even Adapty doesn't treat this as a solved 1:1 mapping;
  it's a judgment call surfaced to the person doing the migration.

### Implication for Rovenue's own subscriber identity
For an importer, the natural mapping key is:
- RevenueCat: `rc_original_app_user_id` (the canonical, merged ID) — **not**
  `rc_last_seen_app_user_id_alias`, since the "original" field is what RC itself treats as the
  durable canonical key across merges.
- Adapty: `customer_user_id` when the source app actually set one (check for empty/absent CUID,
  which would mean the source app relied on Adapty's auto device-scoped identity and per-device
  fragmentation should be expected); fall back to `profile_id` only as a last resort per-installation
  key, understanding it will not survive a user's device change the way `customer_user_id` would.

---

## What I could not confirm (be honest about these before shipping the guide)

- Full **Subscriber-feed** column catalog for RevenueCat (I got Transactions + partial Virtual
  Currency; the docs reference a Subscriber-type feed too, but I did not retrieve its table this
  session).
- Exact **currency** column name/format (e.g., ISO 4217 code column alongside `price_in_usd`) for
  RC's Transactions feed — I saw the USD-converted field but not a raw local-currency + currency-code
  pair explicitly, though the docs strongly imply one exists given "price fields" is referenced as
  plural.
- The literal **Adapty S3 export column table** (I have the config/toggle semantics, not the column
  names) — re-fetch https://adapty.io/docs/s3-exports directly (my session's fetch of it returned
  the integration-settings section, not the schema table) before building a parser.
- Whether RevenueCat's REST API access itself is plan-gated, and the exact contents of RC's
  Webhooks event-type catalog — both plausible from general RC knowledge but not re-verified
  against a live fetch this session.
- Any documented GDPR/"export everything" self-service flow for either vendor — not found, but not
  exhaustively searched either.
- RevenueCat's own inbound "REST APIs and bulk scripts" migration tooling, at the endpoint level —
  the overview page names its existence but I didn't follow the linked sub-pages this session.
- Adapty paywall/experiment configuration exportability — not investigated this session.
- Differences between RevenueCat Data Export **v3 vs v4 vs v5** beyond the one bracket-format change
  noted for `entitlement_identifiers` — treat the schema as versioned and re-check whichever version
  a given customer's export was generated with.

## Sources consulted (first-party unless labeled)

- https://www.revenuecat.com/docs/integrations/scheduled-data-exports (RC, first-party)
- https://www.revenuecat.com/docs/customers/identifying-customers (RC, first-party)
- https://www.revenuecat.com/docs/migrating-to-revenuecat/migration-paths (RC, first-party)
- https://www.revenuecat.com/changelog/release/select-columns-and-use-secure-cloud-auth-in-scheduled-data-exports-2026-06-03 (RC, first-party, referenced via search only)
- https://www.revenuecat.com/docs/data-export-version-4 / .../data-export-version-5 (RC, first-party — page existence/version confirmed via search, full content not retrievable this session)
- https://community.revenuecat.com/general-questions-7/single-api-get-request-for-the-current-full-list-of-subscribers-1166 (community — labeled)
- https://adapty.io/docs/s3-exports (Adapty, first-party)
- https://adapty.io/docs/migration-from-revenuecat (Adapty, first-party)
- https://adapty.io/docs/importing-historical-data-to-adapty (Adapty, first-party)
- https://adapty.io/docs/identifying-users (Adapty, first-party)
- https://adapty.io/docs/api-export-analytics (Adapty, first-party)
