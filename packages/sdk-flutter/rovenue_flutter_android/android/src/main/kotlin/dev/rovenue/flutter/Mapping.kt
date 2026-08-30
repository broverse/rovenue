// Mapping.kt — pure functions mapping between the Kotlin façade's public
// types (`packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/{Types,
// RovenueException,Rovenue}.kt`) and the Pigeon-generated `Rv*` DTOs / enums
// in `Messages.g.kt` (Task 2).
//
// No I/O, no Flutter-channel plumbing here — HostApiImpl.kt and
// EventBridge.kt are the only callers. Kept side-effect free so
// MappingTest.kt can exercise every mapper directly.
//
// Mirrors `packages/sdk-flutter/rovenue_flutter_ios/ios/Classes/Mapping.swift`
// method by method — Pigeon `Rv*` DTOs are shared across platforms so the
// two mappers stay structurally parallel even though the source façade
// types differ (Kotlin `dev.rovenue.sdk.*` vs Swift `Rovenue.*`).

package dev.rovenue.flutter

import dev.rovenue.sdk.Discount
import dev.rovenue.sdk.DiscountType
import dev.rovenue.sdk.IntroPrice
import dev.rovenue.sdk.LogEntry
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Offerings
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.PaymentMode
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.PresentedContext
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.PricingPhase
import dev.rovenue.sdk.PurchaseResult
import dev.rovenue.sdk.RecurrenceMode
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.SubscriptionOption
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.ClaimInstallParams
import dev.rovenue.sdk.generated.Entitlement
import dev.rovenue.sdk.generated.ErrorKind
import dev.rovenue.sdk.generated.ExperimentAssignment
import dev.rovenue.sdk.generated.FunnelClaimResult
import dev.rovenue.sdk.generated.SessionEventKind
import dev.rovenue.sdk.generated.User

// ---------------- Error mapping ----------------
//
// Every failure surfaced to Dart becomes a `FlutterError` whose `code` is
// EXACTLY the UDL `ErrorKind` variant name (see
// `packages/core-rs/src/librovenue.udl`). Task 3's Dart mapper
// (`rovenue_flutter_platform_interface/lib/src/errors.dart`, `_kindByCode`)
// and Task 4's Swift `ErrorKind.udlVariantName` both match on these 24
// strings verbatim — a mismatch here silently degrades that error to
// `RovenueErrorKind.unknown` on the Dart side.
//
// The `when` below is intentionally exhaustive with NO `else` branch: if
// `core-rs` ever adds a new `ErrorKind` variant, this file fails to compile
// until the new case is added here, so the mapping can never silently drift
// from the UDL contract.
val ErrorKind.udlVariantName: String
    get() = when (this) {
        ErrorKind.NETWORK_UNAVAILABLE -> "NetworkUnavailable"
        ErrorKind.TIMEOUT -> "Timeout"
        ErrorKind.RATE_LIMITED -> "RateLimited"
        ErrorKind.SERVER_ERROR -> "ServerError"
        ErrorKind.INVALID_API_KEY -> "InvalidApiKey"
        ErrorKind.FORBIDDEN -> "Forbidden"
        ErrorKind.NOT_FOUND -> "NotFound"
        ErrorKind.INVALID_REQUEST -> "InvalidRequest"
        ErrorKind.CONFLICT -> "Conflict"
        ErrorKind.INVALID_ARGUMENT -> "InvalidArgument"
        ErrorKind.INSUFFICIENT_CREDITS -> "InsufficientCredits"
        ErrorKind.FUNNEL_TOKEN_NOT_FOUND -> "FunnelTokenNotFound"
        ErrorKind.FUNNEL_TOKEN_EXPIRED -> "FunnelTokenExpired"
        ErrorKind.FUNNEL_TOKEN_ALREADY_CLAIMED -> "FunnelTokenAlreadyClaimed"
        ErrorKind.PURCHASE_CANCELED -> "PurchaseCanceled"
        ErrorKind.PRODUCT_NOT_AVAILABLE -> "ProductNotAvailable"
        ErrorKind.ALREADY_OWNED -> "AlreadyOwned"
        ErrorKind.PAYMENT_DECLINED -> "PaymentDeclined"
        ErrorKind.STORE_SERVICE_UNAVAILABLE -> "StoreServiceUnavailable"
        ErrorKind.INELIGIBLE -> "Ineligible"
        ErrorKind.RECEIPT_INVALID -> "ReceiptInvalid"
        ErrorKind.STORE_PROBLEM -> "StoreProblem"
        ErrorKind.STORAGE -> "Storage"
        ErrorKind.INTERNAL -> "Internal"
    }

/**
 * Converts any thrown error into the `FlutterError` shape every
 * `RovenueHostApi` method must fail with (binding contract from
 * task-5-context.md, carried over from Task 4).
 */
fun fail(error: Throwable): FlutterError =
    if (error is RovenueException) {
        FlutterError(
            code = error.kind.udlVariantName,
            message = error.message,
            details = mapOf(
                "detail" to error.message,
                "serverCode" to error.serverCode,
                "httpStatus" to error.httpStatus,
                "retryable" to error.isRetryable,
            ),
        )
    } else {
        FlutterError(
            code = "Internal",
            message = error.message ?: error.toString(),
            details = mapOf(
                "detail" to (error.message ?: error.toString()),
                "retryable" to false,
            ),
        )
    }

/**
 * Flattens any thrown error into the `{code, detail, serverCode,
 * httpStatus, retryable}` map the paywall PlatformView's per-view callback
 * channel sends for `onPurchaseFailed` (Task 7) — the SAME shape every
 * other failure path in this SDK uses (see `fail(Throwable)` above), just
 * not wrapped in a `FlutterError` since this channel isn't Pigeon-generated.
 * Built by reusing `fail(Throwable)` rather than re-deriving the
 * code/detail mapping, so it can never drift from it.
 */
fun errorArgs(error: Throwable): Map<String, Any?> {
    val flutterError = fail(error)
    @Suppress("UNCHECKED_CAST")
    val details = (flutterError.details as? Map<String, Any?>) ?: emptyMap()
    return details + ("code" to flutterError.code)
}

/**
 * Used for the "no foreground Activity available" guard in HostApiImpl,
 * mirroring `RovenueModule.kt`'s `StoreProblemFallbackCodedException` — but
 * per task-5-context.md this must surface as `code == "Internal"` (a
 * missing Activity is a plugin-wiring problem, not a store-layer failure).
 */
fun internalError(message: String): FlutterError = FlutterError(
    code = "Internal",
    message = message,
    details = mapOf(
        "detail" to message,
        "retryable" to false,
    ),
)

// ---------------- Simple 1:1 struct/enum mappers ----------------

fun mapUser(u: User): RvUser = RvUser(rovenueId = u.rovenueId, appUserId = u.appUserId)

fun mapEntitlement(e: Entitlement): RvEntitlement = RvEntitlement(
    id = e.id,
    active = e.isActive,
    expiresAt = e.expiresIso,
    productId = e.productIdentifier,
)

fun mapExperimentAssignment(a: ExperimentAssignment): RvExperimentAssignment = RvExperimentAssignment(
    experimentId = a.experimentId,
    key = a.key,
    variantId = a.variantId,
    variantName = a.variantName,
    valueJson = a.valueJson,
)

fun mapPurchaseResult(r: PurchaseResult): RvPurchaseResult = RvPurchaseResult(
    entitlements = r.entitlements.map(::mapEntitlement),
    virtualCurrencies = r.virtualCurrencies,
    productId = r.productId,
    storeTransactionId = r.storeTransactionId,
    isDeferred = r.isDeferred,
)

fun mapFunnelClaim(r: FunnelClaimResult): RvFunnelClaim =
    RvFunnelClaim(subscriberId = r.subscriberId, funnelAnswersJson = r.funnelAnswersJson)

fun mapChangeEvent(event: ChangeEvent): RvChangeEvent {
    val kind = when (event) {
        ChangeEvent.ENTITLEMENTS_CHANGED -> RvChangeEventKind.ENTITLEMENTS_CHANGED
        ChangeEvent.IDENTITY_CHANGED -> RvChangeEventKind.IDENTITY_CHANGED
        ChangeEvent.VIRTUAL_CURRENCIES_CHANGED -> RvChangeEventKind.VIRTUAL_CURRENCIES_CHANGED
        ChangeEvent.REMOTE_CONFIG_CHANGED -> RvChangeEventKind.REMOTE_CONFIG_CHANGED
    }
    return RvChangeEvent(kind = kind)
}

/** `LogEntry.level` is the façade's own `"off"|"error"|"warn"|"info"|
 *  "debug"|"trace"` string (see `Rovenue.kt`'s `LogEntry`), not the FFI
 *  `LogLevel` enum — the mapping here is string-keyed accordingly. Unknown
 *  values fall back to `.WARN`, matching `RovenueModule.kt`'s `configure`
 *  default. */
fun mapLogLevel(level: String): RvLogLevel = when (level) {
    "off" -> RvLogLevel.OFF
    "error" -> RvLogLevel.ERROR
    "warn" -> RvLogLevel.WARN
    "info" -> RvLogLevel.INFO
    "debug" -> RvLogLevel.DEBUG
    "trace" -> RvLogLevel.TRACE
    else -> RvLogLevel.WARN
}

fun mapLogRecord(entry: LogEntry): RvLogRecord = RvLogRecord(
    level = mapLogLevel(entry.level),
    message = entry.message,
    fields = entry.data ?: emptyMap(),
)

/** Inbound: the Pigeon `RvLogLevel` selector passed to `configure()` → the
 *  FFI `LogLevel` the façade's `Rovenue.configure` expects. */
fun mapLogLevel(level: RvLogLevel): dev.rovenue.sdk.generated.LogLevel = when (level) {
    RvLogLevel.OFF -> dev.rovenue.sdk.generated.LogLevel.OFF
    RvLogLevel.ERROR -> dev.rovenue.sdk.generated.LogLevel.ERROR
    RvLogLevel.WARN -> dev.rovenue.sdk.generated.LogLevel.WARN
    RvLogLevel.INFO -> dev.rovenue.sdk.generated.LogLevel.INFO
    RvLogLevel.DEBUG -> dev.rovenue.sdk.generated.LogLevel.DEBUG
    RvLogLevel.TRACE -> dev.rovenue.sdk.generated.LogLevel.TRACE
}

/** Outbound: façade `ProductType` → `RvProductType`. */
fun productTypeString(t: ProductType): RvProductType = when (t) {
    ProductType.SUBSCRIPTION -> RvProductType.SUBSCRIPTION
    ProductType.CONSUMABLE -> RvProductType.CONSUMABLE
    ProductType.NON_CONSUMABLE -> RvProductType.NON_CONSUMABLE
}

/** Inbound: `RvProductType` (from `purchase()`'s `productType` argument) →
 *  façade `ProductType`. Mirrors `RovenueModule.kt`'s `productTypeFrom`. */
fun productTypeFrom(t: RvProductType): ProductType = when (t) {
    RvProductType.SUBSCRIPTION -> ProductType.SUBSCRIPTION
    RvProductType.CONSUMABLE -> ProductType.CONSUMABLE
    RvProductType.NON_CONSUMABLE -> ProductType.NON_CONSUMABLE
}

fun mapSessionEventKind(k: RvSessionEventKind): SessionEventKind = when (k) {
    RvSessionEventKind.OPEN -> SessionEventKind.OPEN
    RvSessionEventKind.BACKGROUND -> SessionEventKind.BACKGROUND
    RvSessionEventKind.CLOSE -> SessionEventKind.CLOSE
}

/** Inbound: `claimInstall`'s `RvClaimInstallParams` → façade
 *  `ClaimInstallParams`. `platform`/`locale`/`timezone`/`screenDims` are
 *  non-optional on the façade side; missing values default the same way
 *  `RovenueModule.kt`'s Expo bridge does. */
fun mapClaimInstallParams(p: RvClaimInstallParams): ClaimInstallParams = ClaimInstallParams(
    platform = p.platform ?: "android",
    locale = p.locale ?: "",
    timezone = p.timezone ?: "",
    screenDims = p.screenDims ?: "",
    deviceModel = p.deviceModel,
    installReferrer = p.installReferrer,
)

// ---------------- Paywall PlatformView (Task 7) event payloads ----------------
//
// The paywall PlatformView's per-view callback channel is a plain Flutter
// `MethodChannel`, not Pigeon — so its `onPurchaseCompleted` payload is a
// hand-built `Map<String, Any?>`, not an `RvPurchaseResult`. Mirrors
// `packages/sdk-rn/android/.../RovenueModule.kt`'s `dtoFromPurchaseResult` /
// `dtoFromEntitlement` field-for-field, since the Dart side
// (`rovenue_flutter/lib/src/paywall_view.dart`) decodes these same key
// names into the public `Entitlement`/`PurchaseResult` models.

private fun dtoFromEntitlement(e: Entitlement): Map<String, Any?> = mapOf(
    "id" to e.id,
    "active" to e.isActive,
    "expiresAt" to e.expiresIso,
    "productId" to e.productIdentifier,
)

fun dtoFromPurchaseResult(r: PurchaseResult): Map<String, Any?> = mapOf(
    "entitlements" to r.entitlements.map(::dtoFromEntitlement),
    "virtualCurrencies" to r.virtualCurrencies,
    "productId" to r.productId,
    "storeTransactionId" to r.storeTransactionId,
    "isDeferred" to r.isDeferred,
)

// ---------------- Store product graph ----------------

fun mapProductCategory(c: ProductCategory): RvProductCategory = when (c) {
    ProductCategory.SUBSCRIPTION -> RvProductCategory.SUBSCRIPTION
    ProductCategory.NON_SUBSCRIPTION -> RvProductCategory.NON_SUBSCRIPTION
}

fun mapPeriodUnit(u: PeriodUnit): RvPeriodUnit = when (u) {
    PeriodUnit.DAY -> RvPeriodUnit.DAY
    PeriodUnit.WEEK -> RvPeriodUnit.WEEK
    PeriodUnit.MONTH -> RvPeriodUnit.MONTH
    PeriodUnit.YEAR -> RvPeriodUnit.YEAR
}

fun mapPaymentMode(m: PaymentMode): RvPaymentMode = when (m) {
    PaymentMode.FREE_TRIAL -> RvPaymentMode.FREE_TRIAL
    PaymentMode.PAY_AS_YOU_GO -> RvPaymentMode.PAY_AS_YOU_GO
    PaymentMode.PAY_UP_FRONT -> RvPaymentMode.PAY_UP_FRONT
}

fun mapDiscountType(t: DiscountType): RvDiscountType = when (t) {
    DiscountType.INTRODUCTORY -> RvDiscountType.INTRODUCTORY
    DiscountType.PROMOTIONAL -> RvDiscountType.PROMOTIONAL
    DiscountType.WIN_BACK -> RvDiscountType.WIN_BACK
}

fun mapRecurrenceMode(r: RecurrenceMode): RvRecurrenceMode = when (r) {
    RecurrenceMode.INFINITE_RECURRING -> RvRecurrenceMode.INFINITE_RECURRING
    RecurrenceMode.FINITE_RECURRING -> RvRecurrenceMode.FINITE_RECURRING
    RecurrenceMode.NON_RECURRING -> RvRecurrenceMode.NON_RECURRING
}

fun mapPackageType(t: PackageType): RvPackageType = when (t) {
    PackageType.UNKNOWN -> RvPackageType.UNKNOWN
    PackageType.CUSTOM -> RvPackageType.CUSTOM
    PackageType.LIFETIME -> RvPackageType.LIFETIME
    PackageType.ANNUAL -> RvPackageType.ANNUAL
    PackageType.SIX_MONTH -> RvPackageType.SIX_MONTH
    PackageType.THREE_MONTH -> RvPackageType.THREE_MONTH
    PackageType.TWO_MONTH -> RvPackageType.TWO_MONTH
    PackageType.MONTHLY -> RvPackageType.MONTHLY
    PackageType.WEEKLY -> RvPackageType.WEEKLY
}

fun mapPeriod(p: Period): RvPeriod = RvPeriod(
    value = p.value.toLong(),
    unit = mapPeriodUnit(p.unit),
    iso8601 = p.iso8601,
)

fun mapIntroPrice(i: IntroPrice): RvIntroPrice = RvIntroPrice(
    price = i.price,
    priceString = i.priceString,
    currencyCode = i.currencyCode,
    period = mapPeriod(i.period),
    cycles = i.cycles.toLong(),
    paymentMode = mapPaymentMode(i.paymentMode),
)

fun mapDiscount(d: Discount): RvDiscount = RvDiscount(
    identifier = d.identifier,
    price = d.price,
    priceString = d.priceString,
    currencyCode = d.currencyCode,
    period = mapPeriod(d.period),
    numberOfPeriods = d.numberOfPeriods.toLong(),
    paymentMode = mapPaymentMode(d.paymentMode),
    type = mapDiscountType(d.type),
)

fun mapPricingPhase(ph: PricingPhase): RvPricingPhase = RvPricingPhase(
    price = ph.price,
    priceString = ph.priceString,
    currencyCode = ph.currencyCode,
    billingPeriod = mapPeriod(ph.billingPeriod),
    billingCycleCount = ph.billingCycleCount?.toLong(),
    recurrenceMode = mapRecurrenceMode(ph.recurrenceMode),
    paymentMode = ph.paymentMode?.let(::mapPaymentMode),
)

fun mapSubscriptionOption(opt: SubscriptionOption): RvSubscriptionOption = RvSubscriptionOption(
    id = opt.id,
    basePlanId = opt.basePlanId,
    offerId = opt.offerId,
    tags = opt.tags,
    isBasePlan = opt.isBasePlan,
    isPrepaid = opt.isPrepaid,
    pricingPhases = opt.pricingPhases.map(::mapPricingPhase),
    freePhase = opt.freePhase?.let(::mapPricingPhase),
    introPhase = opt.introPhase?.let(::mapPricingPhase),
    fullPricePhase = opt.fullPricePhase?.let(::mapPricingPhase),
)

fun mapStoreProduct(p: StoreProduct): RvStoreProduct = RvStoreProduct(
    id = p.id,
    type = productTypeString(p.type),
    productCategory = mapProductCategory(p.productCategory),
    displayName = p.displayName,
    description = p.description,
    priceString = p.priceString,
    price = p.price,
    currencyCode = p.currencyCode,
    subscriptionPeriod = p.subscriptionPeriod?.let(::mapPeriod),
    subscriptionGroupIdentifier = p.subscriptionGroupIdentifier,
    isFamilyShareable = p.isFamilyShareable,
    introPrice = p.introPrice?.let(::mapIntroPrice),
    // Discounts are iOS-only (App Store promotional offers); always empty
    // on Android — mirrors RovenueModule.kt's dtoFromStoreProduct.
    discounts = emptyList(),
    isEligibleForIntroOffer = p.isEligibleForIntroOffer,
    // subscriptionOptions / defaultOption are Android-only (Google Play
    // base plans + offers).
    subscriptionOptions = p.subscriptionOptions?.map(::mapSubscriptionOption),
    defaultOption = p.defaultOption?.let(::mapSubscriptionOption),
    pricePerWeek = p.pricePerWeek,
    pricePerMonth = p.pricePerMonth,
    pricePerYear = p.pricePerYear,
    pricePerWeekString = p.pricePerWeekString,
    pricePerMonthString = p.pricePerMonthString,
    pricePerYearString = p.pricePerYearString,
)

fun mapPackage(pkg: dev.rovenue.sdk.Package): RvPackage = RvPackage(
    identifier = pkg.identifier,
    packageType = mapPackageType(pkg.packageType),
    product = mapStoreProduct(pkg.product),
)

fun mapOffering(off: Offering): RvOffering = RvOffering(
    identifier = off.identifier,
    isDefault = off.isDefault,
    packages = off.packages.map(::mapPackage),
)

fun mapOfferings(o: Offerings): RvOfferings = RvOfferings(
    current = o.current?.identifier,
    offerings = o.all.values.map(::mapOffering),
)

fun mapPresentedContext(c: PresentedContext): RvPresentedContext = RvPresentedContext(
    placementId = c.placementId,
    paywallId = c.paywallId,
    variantId = c.variantId,
    experimentKey = c.experimentKey,
    revision = c.revision,
)

/** Recursively converts a decoded remote-config value (Map/List/scalar) into
 *  an `org.json` value so it can be re-serialized to the wire JSON string
 *  the DTO carries — Dart re-parses this JSON string itself. Mirrors
 *  RovenueModule.kt's `toJsonValue`. */
private fun Any?.toJsonValue(): Any = when (this) {
    null -> org.json.JSONObject.NULL
    is Map<*, *> -> org.json.JSONObject().also { obj -> forEach { (k, v) -> obj.put(k.toString(), v.toJsonValue()) } }
    is List<*> -> org.json.JSONArray().also { arr -> forEach { arr.put(it.toJsonValue()) } }
    else -> this
}

fun mapPaywall(p: dev.rovenue.sdk.Paywall): RvPaywall = RvPaywall(
    placementIdentifier = p.placementIdentifier,
    placementRevision = p.placementRevision,
    paywallIdentifier = p.paywallIdentifier,
    paywallName = p.paywallName,
    configFormatVersion = p.configFormatVersion,
    remoteConfigJson = p.remoteConfig?.let { (it as Any?).toJsonValue().toString() },
    remoteConfigLocale = p.remoteConfigLocale,
    builderConfigJson = p.builderConfigJson,
    offering = p.offering?.let(::mapOffering),
    presentedContext = p.presentedContext?.let(::mapPresentedContext),
    servedFromFallback = p.servedFromFallback,
)
