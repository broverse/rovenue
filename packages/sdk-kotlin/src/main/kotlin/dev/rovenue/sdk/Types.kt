// Types.kt — public purchase-surface types mirroring the Swift SDK.
//
// These are the developer-facing shapes returned by getOfferings() and
// purchase(). They are deliberately separate from the UniFFI-generated
// Core* types (CoreOfferings / CoreOffering / CoreOfferingProduct), which
// are internal FFI wire types; Rovenue maps Core* -> these on the way out.

package dev.rovenue.sdk

import com.android.billingclient.api.ProductDetails
import dev.rovenue.sdk.generated.Entitlement

/**
 * The kind of product backing a [StoreProduct].
 *
 * The Rust core / backend speaks raw strings; [from] normalises them,
 * defaulting unknown values to [SUBSCRIPTION] (the safest assumption for an
 * access-granting product).
 */
enum class ProductType {
    SUBSCRIPTION,
    CONSUMABLE,
    NON_CONSUMABLE;

    companion object {
        fun from(raw: String) = when (raw) {
            "CONSUMABLE" -> CONSUMABLE
            "NON_CONSUMABLE" -> NON_CONSUMABLE
            else -> SUBSCRIPTION
        }
    }
}

enum class ProductCategory { SUBSCRIPTION, NON_SUBSCRIPTION }
enum class PeriodUnit { DAY, WEEK, MONTH, YEAR }
enum class PaymentMode { FREE_TRIAL, PAY_AS_YOU_GO, PAY_UP_FRONT }
enum class DiscountType { INTRODUCTORY, PROMOTIONAL, WIN_BACK }
enum class RecurrenceMode { INFINITE_RECURRING, FINITE_RECURRING, NON_RECURRING }

data class Period(val value: Int, val unit: PeriodUnit, val iso8601: String)

data class IntroPrice(
    val price: Double?, val priceString: String?, val currencyCode: String?,
    val period: Period, val cycles: Int, val paymentMode: PaymentMode,
)

data class Discount(
    val identifier: String?, val price: Double?, val priceString: String?, val currencyCode: String?,
    val period: Period, val numberOfPeriods: Int, val paymentMode: PaymentMode, val type: DiscountType,
)

data class PricingPhase(
    val price: Double?, val priceString: String?, val currencyCode: String?,
    val billingPeriod: Period, val billingCycleCount: Int?,
    val recurrenceMode: RecurrenceMode, val paymentMode: PaymentMode?,
)

data class SubscriptionOption(
    val id: String, val basePlanId: String?, val offerId: String?, val tags: List<String>,
    val isBasePlan: Boolean, val isPrepaid: Boolean, val pricingPhases: List<PricingPhase>,
    val freePhase: PricingPhase?, val introPhase: PricingPhase?, val fullPricePhase: PricingPhase?,
)

enum class PackageType { UNKNOWN, CUSTOM, LIFETIME, ANNUAL, SIX_MONTH, THREE_MONTH, TWO_MONTH, MONTHLY, WEEKLY }

/**
 * A purchasable product as configured in Rovenue. In v1 the price fields are
 * null at the offerings layer (configuration only); localized price metadata
 * comes from Play Billing's ProductDetails at purchase time.
 */
data class StoreProduct(
    val id: String,
    val type: ProductType,
    val productCategory: ProductCategory,
    val displayName: String,
    val description: String? = null,
    val priceString: String? = null,
    val price: Double? = null,
    val currencyCode: String? = null,
    val subscriptionPeriod: Period? = null,
    val subscriptionGroupIdentifier: String? = null,
    val isFamilyShareable: Boolean = false,
    val introPrice: IntroPrice? = null,
    val discounts: List<Discount> = emptyList(),
    val isEligibleForIntroOffer: Boolean? = null,
    val subscriptionOptions: List<SubscriptionOption>? = null,
    val defaultOption: SubscriptionOption? = null,
    val pricePerWeek: Double? = null,
    val pricePerMonth: Double? = null,
    val pricePerYear: Double? = null,
    val pricePerWeekString: String? = null,
    val pricePerMonthString: String? = null,
    val pricePerYearString: String? = null,
    val rawStoreProduct: ProductDetails? = null,
)

/** A named slot within an [Offering] that points at a single [StoreProduct]. */
data class Package(
    val identifier: String,
    val packageType: PackageType,
    val product: StoreProduct,
)

/** A group of packages presented together (e.g. a paywall configuration). */
data class Offering(
    val identifier: String,
    val isDefault: Boolean,
    val packages: List<Package>,
) {
    fun packageBy(identifier: String): Package? = packages.firstOrNull { it.identifier == identifier }
    private fun byType(t: PackageType): Package? = packages.firstOrNull { it.packageType == t }
    val lifetime: Package? get() = byType(PackageType.LIFETIME)
    val annual: Package? get() = byType(PackageType.ANNUAL)
    val sixMonth: Package? get() = byType(PackageType.SIX_MONTH)
    val threeMonth: Package? get() = byType(PackageType.THREE_MONTH)
    val twoMonth: Package? get() = byType(PackageType.TWO_MONTH)
    val monthly: Package? get() = byType(PackageType.MONTHLY)
    val weekly: Package? get() = byType(PackageType.WEEKLY)
}

/** The full set of configured offerings plus the currently-selected one. */
data class Offerings(
    val current: Offering?,
    val all: Map<String, Offering>,
)

// -------------------------------------------------------------
// Placements / Paywalls
// -------------------------------------------------------------

/**
 * Paywall-attribution snapshot for the paywall a [Rovenue.getPaywall] call
 * resolved. Round-tripped opaquely into the purchase attribution path, and
 * the source [Rovenue.logPaywallShown] builds its `paywall_view` event
 * from — mirrors the core's `CorePresentedContext`.
 */
data class PresentedContext(
    val placementId: String,
    val paywallId: String,
    val variantId: String?,
    val experimentKey: String?,
    val revision: Long,
)

/**
 * A resolved placement: either a direct paywall assignment or the winning
 * variant of a client-drawn PAYWALL experiment. The SDK ships no renderer
 * (Adapty remote-config model, Phase A) — callers read [remoteConfig] and
 * build their own UI, then call [Rovenue.logPaywallShown] once it's on screen.
 */
data class Paywall(
    val placementIdentifier: String,
    val placementRevision: Long,
    val paywallIdentifier: String?,
    val paywallName: String?,
    val configFormatVersion: Long,
    /** Decoded from the core's raw `remoteConfigJson` string. `null` when
     *  the paywall has no remote config for the resolved locale, or when
     *  the JSON fails to decode as an object. */
    val remoteConfig: Map<String, Any?>?,
    val remoteConfigLocale: String?,
    val offering: Offering?,
    val presentedContext: PresentedContext?,
    /** Raw JSON of the Phase-B builder component tree (`configFormatVersion`
     *  2 paywalls). Consumed by the native paywall renderer; `null` for
     *  remote-config-only paywalls. Defaulted so existing positional
     *  constructions keep compiling. */
    val builderConfigJson: String? = null,
)

/** The outcome of a successful, validated purchase. */
data class PurchaseResult(
    val entitlements: List<Entitlement>,
    val virtualCurrencies: Map<String, Long>,
    val productId: String,
    val storeTransactionId: String,
    /**
     * True when Play Billing returned PENDING (now Deferred) — the payment is
     * pending external action (e.g. cash at a kiosk). No entitlements are
     * granted yet; the SDK will deliver them when the purchase completes via
     * reconcilePurchases(). Swift parity: PurchaseResultState.deferred flag.
     */
    val isDeferred: Boolean = false,
)
