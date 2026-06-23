# Enriched `StoreProduct` — RevenueCat-parity product schema

**Date:** 2026-06-23
**Status:** Approved design, pre-implementation
**Scope:** SDK only (Swift / Kotlin / React Native façades + native hydration + docs). Rust core (`librovenue`) **unchanged**.

## 1. Problem

Today the SDK returns a deliberately minimal product object:

```
StoreProduct { id, type, displayName, priceString, price, currencyCode }
```

This cannot drive a real paywall. There is no free-trial / introductory-offer data, no
subscription period, no per-unit pricing, no escape hatch to the native product. RevenueCat
and Adapty both return far richer objects, and any serious paywall UI depends on that data.

**Goal:** mirror RevenueCat's *cross-platform* (react-native-purchases / Flutter) unified
`StoreProduct` shape — a single type carrying both the iOS-style `introPrice` + `discounts`
and the Android-style `subscriptionOptions` / `pricingPhases`, with the platform-irrelevant
fields left `null`/empty. This is the right precedent because Rovenue's architecture (Rust
core + native façades + one shared public type across Swift/Kotlin/RN) is structurally
identical to RC's hybrid SDK layer.

## 2. Key architectural fact

All new fields are populated **entirely in the native hydration layer** (StoreKit 2 /
Google Play Billing). The Rust core already returns config only (product id + store ids); it
does not even know prices — those are filled natively. Therefore:

- **`packages/core-rs` is NOT touched.** `librovenue.udl` is unchanged, `npm run sdk:bindings`
  is **not** rerun, no uniffi regeneration.
- Changed layers: `sdk-swift` (public types + AppleStore hydration), `sdk-kotlin`
  (public types + PlayBillingStore + OfferingsHydration), `sdk-rn` (native bridge DTO + TS
  types), `apps/docs`.

## 3. Final public schema (identical shape across Swift / Kotlin / RN)

Types below are written language-neutrally. Per-language concrete types in §4.

```
StoreProduct {
  id: String
  type: ProductType                       // existing: subscription | consumable | nonConsumable
  productCategory: ProductCategory         // NEW (derived): subscription | nonSubscription
  displayName: String                      // existing (RC "title"/"localizedTitle")
  description: String?                     // NEW

  // base / full price (existing fields, unchanged semantics)
  priceString: String?
  price: <Decimal | Double | number>?
  currencyCode: String?

  // subscription metadata (null for non-subscriptions)
  subscriptionPeriod: Period?              // NEW
  subscriptionGroupIdentifier: String?     // NEW (iOS only; null on Android)
  isFamilyShareable: Bool                  // NEW (iOS; false on Android)

  // offers — cross-platform normalized
  introPrice: IntroPrice?                  // NEW (iOS introductoryDiscount; Android free/intro phase)
  discounts: [Discount]                    // NEW (iOS promotional offers; empty [] on Android)
  isEligibleForIntroOffer: Bool?           // NEW (iOS real; Android derived; null if N/A)

  // Android-native offer detail (null on iOS)
  subscriptionOptions: [SubscriptionOption]?   // NEW
  defaultOption: SubscriptionOption?           // NEW

  // computed per-unit pricing (RC parity)
  pricePerWeek:  <decimal>?                // NEW
  pricePerMonth: <decimal>?                // NEW
  pricePerYear:  <decimal>?                // NEW
  pricePerWeekString:  String?             // NEW
  pricePerMonthString: String?             // NEW
  pricePerYearString:  String?             // NEW

  // escape hatch (Swift/Kotlin only — NOT present in RN)
  rawStoreProduct: <StoreKit.Product | ProductDetails>?   // NEW
}

Period {
  value: Int
  unit: PeriodUnit                         // day | week | month | year
  iso8601: String                          // e.g. "P1M", "P1Y"
}

IntroPrice {                               // single most-relevant intro/free-trial offer
  price: <decimal>?
  priceString: String?
  currencyCode: String?
  period: Period                           // length of one cycle
  cycles: Int                              // number of billing cycles (RC "numberOfPeriods")
  paymentMode: PaymentMode                 // freeTrial | payAsYouGo | payUpFront
}

Discount {                                 // iOS promotional/intro offers (StoreProductDiscount)
  identifier: String?                      // offer id
  price: <decimal>?
  priceString: String?
  currencyCode: String?
  period: Period
  numberOfPeriods: Int
  paymentMode: PaymentMode
  type: DiscountType                       // introductory | promotional | winBack
}

SubscriptionOption {                       // Android base plan / offer (Play Billing)
  id: String                               // basePlanId or "{basePlanId}:{offerId}"
  basePlanId: String?
  offerId: String?
  tags: [String]
  isBasePlan: Bool
  isPrepaid: Bool
  pricingPhases: [PricingPhase]
  freePhase: PricingPhase?                 // convenience: phase with paymentMode == freeTrial
  introPhase: PricingPhase?                // convenience: discounted finite phase
  fullPricePhase: PricingPhase?            // convenience: the recurring base phase
}

PricingPhase {
  price: <decimal>?
  priceString: String?
  currencyCode: String?
  billingPeriod: Period
  billingCycleCount: Int?                  // null when infinite / non-recurring
  recurrenceMode: RecurrenceMode           // infiniteRecurring | finiteRecurring | nonRecurring
  paymentMode: PaymentMode?
}

// Enums
ProductCategory : subscription | nonSubscription
PeriodUnit      : day | week | month | year
PaymentMode     : freeTrial | payAsYouGo | payUpFront
DiscountType    : introductory | promotional | winBack
RecurrenceMode  : infiniteRecurring | finiteRecurring | nonRecurring
```

### Package / Offering — RC parity additions

```
Package {
  identifier: String                       // existing (slot id, e.g. "$rov_monthly")
  packageType: PackageType                 // NEW (derived from identifier slot)
  product: StoreProduct                    // existing
}

PackageType : unknown | custom | lifetime | annual | sixMonth | threeMonth | twoMonth | monthly | weekly

Offering {
  identifier: String                       // existing
  isDefault: Bool                          // existing
  packages: [Package]                      // existing
  // NEW convenience accessors (mirror RC), each returns Package?:
  monthly, annual, weekly, sixMonth, threeMonth, twoMonth, lifetime
  package(identifier:) -> Package?
}
```

`packageType` is derived from the canonical Rovenue slot identifiers (`$rov_monthly`,
`$rov_annual`, `$rov_weekly`, `$rov_two_month`, `$rov_three_month`, `$rov_six_month`,
`$rov_lifetime`); unrecognized slots → `custom`.

## 4. Per-language concrete types

- **Swift** (`packages/sdk-swift/Sources/Rovenue/Types.swift`): `<decimal>` = `Decimal`.
  `rawStoreProduct: StoreKit.Product?`. New structs/enums added in the same file; all
  `Sendable, Equatable` (raw `Product` is `Sendable`).
- **Kotlin** (`packages/sdk-kotlin/.../Types.kt`): `<decimal>` = `Double`.
  `rawStoreProduct: ProductDetails?` (com.android.billingclient). New `data class`/`enum class`.
- **React Native** (`packages/sdk-rn/src/types.ts`): `<decimal>` = `number`. **No
  `rawStoreProduct`** (cannot cross the bridge). All other fields present.

Existing fields (`id`, `type`, `displayName`, `priceString`, `price`, `currencyCode`) keep
their current names and types — **no breaking renames**. Everything else is additive.

## 5. Platform → field mapping

### 5.1 iOS — StoreKit 2 (`Product` / `Product.SubscriptionInfo`)

| Target field | Source |
|---|---|
| `description` | `Product.description` |
| `subscriptionPeriod` | `Product.subscription.subscriptionPeriod` → {value, unit, iso8601} |
| `subscriptionGroupIdentifier` | `Product.subscription.subscriptionGroupID` |
| `isFamilyShareable` | `Product.isFamilyShareable` |
| `introPrice` | `Product.subscription.introductoryOffer` (paymentMode: `.freeTrial/.payAsYouGo/.payUpFront`; `cycles` = `periodCount`) |
| `discounts` | `Product.subscription.promotionalOffers` → `Discount(type: .promotional)` (+ intro mapped with `type: .introductory`) |
| `isEligibleForIntroOffer` | `await Product.subscription.isEligibleForIntroOffer` (per subscription group; resolved during hydration) |
| `pricePerX` | computed from `price` ÷ normalized period |
| `subscriptionOptions` / `defaultOption` | `nil` (iOS) |
| `rawStoreProduct` | the `Product` itself |

### 5.2 Android — Play Billing 5+ (`ProductDetails`)

| Target field | Source |
|---|---|
| `description` | `ProductDetails.description` |
| `subscriptionOptions` | each `ProductDetails.subscriptionOfferDetails` entry → `SubscriptionOption` |
| `SubscriptionOption.id/basePlanId/offerId/tags` | `offerToken`-bearing offer: `basePlanId`, `offerId`, `offerTags` |
| `pricingPhases` | `offer.pricingPhases.pricingPhaseList` → `PricingPhase` |
| `PricingPhase.paymentMode` | `priceAmountMicros == 0` → `freeTrial`; `recurrenceMode FINITE` → `payAsYouGo`; else base/full |
| `PricingPhase.billingPeriod` | `pricingPhase.billingPeriod` (ISO-8601 parsed into Period) |
| `PricingPhase.recurrenceMode` | `pricingPhase.recurrenceMode` |
| `freePhase/introPhase/fullPricePhase` | derived from the phase list |
| `defaultOption` | selected base-plan option (see §6.1) |
| `subscriptionPeriod` | `defaultOption.fullPricePhase.billingPeriod` |
| `price/priceString/currencyCode` | `defaultOption.fullPricePhase.price` (full recurring price) |
| `introPrice` | `defaultOption.freePhase ?? defaultOption.introPhase` mapped into `IntroPrice` |
| `isEligibleForIntroOffer` | derived: `true` if a free/intro phase is present, else `false` (see §6.2) |
| `discounts` | `[]` (Play has no flat promotional-discount concept; offers live in `subscriptionOptions`) |
| `isFamilyShareable` | `false`; `subscriptionGroupIdentifier` | `null` |
| `rawStoreProduct` | the `ProductDetails` itself |

INAPP (consumable/non-consumable) products: only `oneTimePurchaseOfferDetails` →
`price/priceString/currencyCode`; all subscription fields null/empty.

## 6. Two resolved technical points

### 6.1 Android base-plan selection
A Play subscription product id can expose multiple base plans + offers, but Rovenue maps one
package slot → one `googleProductId`. **Resolution:** populate the full
`subscriptionOptions` list (lossless), and choose `defaultOption` = the base-plan offer
(`isBasePlan`) with the lowest full price; if an offer carries a free trial / intro phase,
prefer it for `introPrice`. The flat `price`/`subscriptionPeriod` reflect `defaultOption`.
Per-base-plan selection by the app remains possible via `subscriptionOptions`. (Adding a
`basePlanId`/`offerId` to *server* product config is explicitly out of scope here.)

### 6.2 Android eligibility
Play exposes no direct eligibility flag (it enforces at purchase). `isEligibleForIntroOffer`
is **derived**: `true` when the chosen option has a free/intro phase, else `false`. iOS uses
the real StoreKit `isEligibleForIntroOffer`. This platform difference is documented in the
SDK reference.

## 7. Resilience / backward compatibility

- Existing behavior preserved: if the native store query fails, offerings still render
  config-only — all new fields become `null` / empty, `discounts`/`subscriptionOptions` are
  `[]`/`null`. No new field blocks an existing flow.
- No existing field renamed or removed → no breaking change for current SDK consumers.
- `rawStoreProduct` is optional and absent in RN, keeping the RN public type fully
  serializable.

## 8. Testing

- **Swift:** unit tests with a mock `AppleStore` (and/or a `.storekit` config) covering:
  free-trial intro mapping, pay-up-front intro, promotional `discounts`, `subscriptionPeriod`
  + `iso8601`, `pricePerMonth` computation, `isEligibleForIntroOffer` resolution, INAPP
  (no subscription fields).
- **Kotlin** (`testDebugUnitTest`): `PlayBillingStore` parsing from fake `ProductDetails` —
  free-trial phase detection, intro phase, multi-base-plan `defaultOption` selection,
  `RecurrenceMode` mapping, Period ISO-8601 parsing, derived eligibility, INAPP path.
- **RN:** bridge DTO round-trip type test ensuring every field (minus `rawStoreProduct`)
  serializes/deserializes; `packageType` derivation; Offering convenience accessors.
- **Parity check:** a table test asserting field names line up with the documented schema.

## 9. Out of scope

- Server-side product config changes (e.g. `basePlanId`/`offerId` in the catalog).
- iOS promotional-offer **purchase** signing (`PromotionalOffer.SignedData` server endpoint).
  We *expose* promo offers in `discounts` but purchasing a signed promo offer is a separate
  feature.
- Win-back offers purchasing flow (the `winBack` `DiscountType` value exists for parity but
  is not wired to a purchase path here).
- Rust core / `librovenue.udl` / uniffi binding changes.
