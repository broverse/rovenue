// Row normalizer for the data-import tool (spec §4.3, §4.4).
//
// This is the module where a migration is right or wrong: it decides
// what status a real customer's subscription gets and how much revenue
// their dashboard reports afterwards. Every rule below traces to a
// specific line in the design spec or a specific production incident in
// this repo — see the comment next to each one.
//
// Pure and synchronous by design: no catalog lookups, no subscriber
// resolution, no store calls. Those all need project scope and a real
// database (they live in later tasks — the dry-run planner and the
// writer). This module only ever sees one CanonicalRow (the Task 1
// contract) and a clock.
import type { CanonicalField, CanonicalRow } from "./canonical";

// =============================================================
// Store mapping
// =============================================================

export type StoreValue = "APP_STORE" | "PLAY_STORE" | "STRIPE" | "MANUAL";

/** Source `store` column values this importer recognizes, mapped onto
 *  our `Store` enum (packages/db/src/drizzle/enums.ts). `promotional`
 *  maps to MANUAL because it has no real store transaction behind it —
 *  see the "anchorless rows" handling in normalizeRow below. */
export const STORE_VALUE_MAP: Record<string, StoreValue> = {
  app_store: "APP_STORE",
  play_store: "PLAY_STORE",
  stripe: "STRIPE",
  promotional: "MANUAL",
};

// =============================================================
// Status
// =============================================================

/** Subset of the `PurchaseStatus` db enum an import can ever produce.
 *  REVOKED and PAUSED are operator actions taken inside this app after
 *  the fact; nothing in a vendor export maps to them. */
export type PurchaseStatusName = "TRIAL" | "ACTIVE" | "EXPIRED" | "REFUNDED" | "GRACE_PERIOD";

export type NormalizedDates = {
  effectiveEndDate: Date | null;
  expiresDate: Date | null;
  gracePeriodEndDate: Date | null;
  refundedAt: Date | null;
};

/**
 * Status precedence (binding — task-3 controller context, ruling 2):
 *  1. `refundedAt` set → REFUNDED, unconditionally.
 *  2. An OPEN grace window (`end <= now < gracePeriodEndDate`) → GRACE_PERIOD.
 *  3. No end date at all (lifetime) → live (TRIAL if isTrial, else ACTIVE).
 *  4. `effectiveEndDate ?? expiresDate` in the future → live.
 *  5. Otherwise → EXPIRED.
 *
 * `effective_end_time` is preferred over `end_time` because RevenueCat
 * documents it as the normalized "when does access end" value that
 * already accounts for each store's own refund/grace-period logic.
 *
 * `unsubscribeDetectedAt` never appears here — it is NOT a status input.
 * It only sets `autoRenewStatus = false` and `cancellationDate` in
 * normalizeRow. A cancelled-but-unexpired subscription is still ACTIVE;
 * getting this backwards would revoke access from paying customers on
 * import day.
 *
 * Google's `end_time` before `start_time` is real data (how Play
 * invalidates a transaction), not corruption — this function never
 * compares against a purchase/start date, so it naturally resolves such
 * a row to EXPIRED via rule 5 rather than rejecting it.
 */
export function deriveStatus(r: NormalizedDates & { isTrial: boolean }, now: Date): PurchaseStatusName {
  if (r.refundedAt) return "REFUNDED";

  const end = r.effectiveEndDate ?? r.expiresDate;
  const nowMs = now.getTime();

  if (end && r.gracePeriodEndDate && end.getTime() <= nowMs && nowMs < r.gracePeriodEndDate.getTime()) {
    return "GRACE_PERIOD";
  }

  if (!end || end.getTime() > nowMs) {
    return r.isTrial ? "TRIAL" : "ACTIVE";
  }

  return "EXPIRED";
}

// =============================================================
// Money (spec §4.4 — hard rules)
// =============================================================

export type NormalizedMoney = {
  priceAmount: string | null;
  priceCurrency: string | null;
};

/** A bare, optionally-signed decimal. Rejects anything that isn't
 *  confidently a plain number (currency symbols, thousands separators,
 *  scientific notation) rather than passing it through as if it were
 *  trustworthy money. */
const DECIMAL_AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * `price_in_usd` is documented as USD-converted, so mapping it to
 * `priceAmount` with `priceCurrency = "USD"` states a known fact, not an
 * assumption (spec §4.4). Any amount that doesn't parse as a plain
 * decimal is dropped rather than passed through — `purchases.priceAmount`
 * and `priceCurrency` are both nullable, so "no trustworthy money on
 * this row" is representable and is the correct output. There is
 * deliberately no local-currency parameter here: whether RC ships a raw
 * local-currency + ISO-4217 pair at all is unconfirmed research, and
 * stamping a guessed currency on an amount of unknown denomination is
 * exactly what this function must never do.
 *
 * Refund amounts are stored POSITIVE, matching the repo-wide convention
 * (a negated refund once overflowed `toUInt64` in a ClickHouse view and
 * inflated net MRR/LTV) — a negative source value is normalized to its
 * absolute value, never passed through signed.
 */
export function normalizeMoney(p: { priceUsd?: string | null }): NormalizedMoney {
  const raw = p.priceUsd?.trim();
  if (!raw || !DECIMAL_AMOUNT_PATTERN.test(raw)) {
    return { priceAmount: null, priceCurrency: null };
  }
  const positiveAmount = raw.startsWith("-") ? raw.slice(1) : raw;
  return { priceAmount: positiveAmount, priceCurrency: "USD" };
}

// =============================================================
// Timestamps
// =============================================================

/** RevenueCat's documented export shape: `YYYY-MM-DD HH:MM:SS`, space-
 *  separated, UTC. A `T` separator and/or a trailing `Z` are accepted
 *  too (both are unambiguously the same shape); optional fractional
 *  seconds are preserved. Anything else is rejected outright — this
 *  parser states its UTC assumption and refuses to guess a zone for a
 *  format it doesn't recognize (spec §4.4). */
const SOURCE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z?$/;

export function parseSourceTimestamp(value: string): Date {
  const trimmed = value.trim();
  const match = SOURCE_TIMESTAMP_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(
      `cannot parse "${value}" as a source timestamp: expected RevenueCat's ` +
        `"YYYY-MM-DD HH:MM:SS" (UTC) shape; refusing to guess a time zone ` +
        `for an unrecognized format`,
    );
  }
  const [, year, month, day, hour, minute, second, fraction] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ?? ""}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`cannot parse "${value}" as a source timestamp: not a valid calendar date`);
  }
  return date;
}

/** Parses an optional canonical timestamp cell: absent/blank → null,
 *  present-but-unparseable → throws (caller turns that into a row-level
 *  NormalizeError; we never silently drop a timestamp that was actually
 *  populated). */
function parseOptionalTimestamp(value: string | undefined): Date | null {
  if (value === undefined || value.trim() === "") return null;
  return parseSourceTimestamp(value);
}

// =============================================================
// Booleans
// =============================================================

/** RC's documented boolean columns are `true`/`false`. Absent or blank
 *  is treated as false rather than unknown — every one of these fields
 *  (isTrial, isIntroOffer, isSandbox) is optional in CANONICAL_FIELDS,
 *  and "we don't know" is not a meaningful state for a yes/no flag that
 *  drives status derivation. */
function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/** Same parsing rule as parseBoolean, but preserves "column wasn't
 *  mapped at all" as null rather than collapsing it to false — used
 *  only for isAutoRenewable, which is informational passthrough rather
 *  than a status input. */
function parseOptionalBoolean(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === "") return null;
  return parseBoolean(value);
}

// =============================================================
// Row normalization
// =============================================================

export type NormalizeErrorCode =
  | "MISSING_REQUIRED_FIELD"
  | "UNKNOWN_STORE_VALUE"
  | "INVALID_TIMESTAMP"
  | "MISSING_STORE_TRANSACTION_ID";

export type NormalizeError = {
  code: NormalizeErrorCode;
  message: string;
  field?: CanonicalField;
};

export type NormalizedRow = {
  subscriberExternalId: string;
  subscriberAliasId: string | null;
  store: StoreValue;
  /** Null only for anchorless (MANUAL) rows — the writer (task 7) fills
   *  this in via buildSyntheticTransactionId, which needs the project
   *  scope this pure function deliberately doesn't have. */
  storeTransactionId: string | null;
  originalTransactionId: string | null;
  googlePurchaseToken: string | null;
  stripeSubscriptionId: string | null;
  productIdentifier: string;
  productDisplayName: string | null;
  purchaseDate: Date;
  expiresDate: Date | null;
  effectiveEndDate: Date | null;
  gracePeriodEndDate: Date | null;
  refundedAt: Date | null;
  /** Set from unsubscribeDetectedAt. Never a status input — see deriveStatus. */
  cancellationDate: Date | null;
  /** false when unsubscribeDetectedAt is present; otherwise the source
   *  is_auto_renewable value, or null when neither is known. */
  autoRenewStatus: boolean | null;
  priceAmount: string | null;
  priceCurrency: string | null;
  isTrial: boolean;
  isIntroOffer: boolean;
  isSandbox: boolean;
  isAutoRenewable: boolean | null;
  renewalNumber: string | null;
  ownershipType: string | null;
  /** true for ownershipType === "FAMILY_SHARED" (spec §4.3 / RC's own
   *  sample queries exclude family-shared access from revenue). */
  excludeFromRevenue: boolean;
  /** Raw passthrough — validation input for the catalog resolver (a
   *  later task), never authority. Left unparsed: entitlement_identifiers'
   *  delimiter/bracket format is version-dependent and unconfirmed by
   *  research; parsing it here would be guessing at a format, the same
   *  mistake §4.4 forbids for currency. */
  entitlementIdentifiers: string | null;
  country: string | null;
  /** Raw passthrough (RC ships this as a JSON object); not parsed here. */
  customAttributes: string | null;
  updatedAt: Date | null;
  status: PurchaseStatusName;
  /** True for rows with no real store transaction (RC `promotional`).
   *  These are counted in their own outcome bucket downstream and are
   *  never sent to Phase B verification (spec §4.3). */
  isAnchorless: boolean;
};

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function missingFieldError(field: CanonicalField, label: string): { error: NormalizeError } {
  return {
    error: {
      code: "MISSING_REQUIRED_FIELD",
      message: `row is missing a value for required field "${label}"`,
      field,
    },
  };
}

/**
 * Normalizes one canonical row into the shape the writer persists, or
 * returns a `NormalizeError` for a row that cannot be trusted at all
 * (missing required identity, an unrecognized store, an unparseable
 * timestamp). It never fabricates a value to paper over a gap — see the
 * per-field comments on NormalizedRow for what "unknown" looks like for
 * money, entitlements and auto-renew status.
 *
 * Consumes ONLY canonical field names (CanonicalRow from Task 1's
 * contract) — never source column names. The mapping layer (Task 2) is
 * the only place source column names exist; by the time a row reaches
 * this function it has already been rewritten onto canonical keys.
 */
export function normalizeRow(
  raw: CanonicalRow,
  ctx: { now: Date },
): NormalizedRow | { error: NormalizeError } {
  const subscriberExternalId = emptyToNull(raw.subscriberExternalId);
  if (!subscriberExternalId) {
    return missingFieldError("subscriberExternalId", "Subscriber ID");
  }

  const sourceStore = emptyToNull(raw.store);
  if (!sourceStore) {
    return missingFieldError("store", "Store");
  }
  const store = STORE_VALUE_MAP[sourceStore];
  if (!store) {
    return {
      error: {
        code: "UNKNOWN_STORE_VALUE",
        message: `unrecognized store value "${sourceStore}"`,
        field: "store",
      },
    };
  }
  const isAnchorless = store === "MANUAL";

  const productIdentifier = emptyToNull(raw.productIdentifier);
  if (!productIdentifier) {
    return missingFieldError("productIdentifier", "Product identifier");
  }

  const rawPurchaseDate = emptyToNull(raw.purchaseDate);
  if (!rawPurchaseDate) {
    return missingFieldError("purchaseDate", "Purchase date");
  }

  const storeTransactionIdRaw = emptyToNull(raw.storeTransactionId);
  if (!isAnchorless && !storeTransactionIdRaw) {
    // A real store row with nothing to key on can't be deduplicated or
    // upserted safely; report it rather than inventing an identifier
    // that would look like a real store transaction id (spec §4.3's
    // "we never invent a value that claims to be a real store
    // transaction identifier").
    return {
      error: {
        code: "MISSING_STORE_TRANSACTION_ID",
        message: "non-anchorless row has no store transaction id to key on",
        field: "storeTransactionId",
      },
    };
  }

  let purchaseDate: Date;
  let expiresDate: Date | null;
  let effectiveEndDate: Date | null;
  let gracePeriodEndDate: Date | null;
  let refundedAt: Date | null;
  let unsubscribeDetectedAt: Date | null;
  let updatedAt: Date | null;
  try {
    purchaseDate = parseSourceTimestamp(rawPurchaseDate);
    expiresDate = parseOptionalTimestamp(raw.expiresDate);
    effectiveEndDate = parseOptionalTimestamp(raw.effectiveEndDate);
    gracePeriodEndDate = parseOptionalTimestamp(raw.gracePeriodEndDate);
    refundedAt = parseOptionalTimestamp(raw.refundedAt);
    unsubscribeDetectedAt = parseOptionalTimestamp(raw.unsubscribeDetectedAt);
    updatedAt = parseOptionalTimestamp(raw.updatedAt);
  } catch (err) {
    return {
      error: {
        code: "INVALID_TIMESTAMP",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const isTrial = parseBoolean(raw.isTrial);
  const ownershipType = emptyToNull(raw.ownershipType);

  const status = deriveStatus(
    { effectiveEndDate, expiresDate, gracePeriodEndDate, refundedAt, isTrial },
    ctx.now,
  );

  const money = normalizeMoney({ priceUsd: raw.priceUsd });

  return {
    subscriberExternalId,
    subscriberAliasId: emptyToNull(raw.subscriberAliasId),
    store,
    storeTransactionId: isAnchorless ? null : storeTransactionIdRaw,
    originalTransactionId: emptyToNull(raw.originalTransactionId),
    googlePurchaseToken: emptyToNull(raw.googlePurchaseToken),
    stripeSubscriptionId: emptyToNull(raw.stripeSubscriptionId),
    productIdentifier,
    productDisplayName: emptyToNull(raw.productDisplayName),
    purchaseDate,
    expiresDate,
    effectiveEndDate,
    gracePeriodEndDate,
    refundedAt,
    cancellationDate: unsubscribeDetectedAt,
    autoRenewStatus: unsubscribeDetectedAt ? false : parseOptionalBoolean(raw.isAutoRenewable),
    priceAmount: money.priceAmount,
    priceCurrency: money.priceCurrency,
    isTrial,
    isIntroOffer: parseBoolean(raw.isIntroOffer),
    isSandbox: parseBoolean(raw.isSandbox),
    isAutoRenewable: parseOptionalBoolean(raw.isAutoRenewable),
    renewalNumber: emptyToNull(raw.renewalNumber),
    ownershipType,
    excludeFromRevenue: ownershipType === "FAMILY_SHARED",
    entitlementIdentifiers: emptyToNull(raw.entitlementIdentifiers),
    country: emptyToNull(raw.country),
    customAttributes: emptyToNull(raw.customAttributes),
    updatedAt,
    status,
    isAnchorless,
  };
}
