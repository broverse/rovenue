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

/** The outcome of a successful, validated purchase. */
data class PurchaseResult(
    val entitlements: List<Entitlement>,
    val virtualCurrencies: Map<String, Long>,
    val productId: String,
    val storeTransactionId: String,
)

// Purchase exceptions — top-level classes (the generated RovenueException is a
// sealed class we must not extend). Mirrors the Swift SDK's purchase errors.

class PurchaseCancelledException(message: String) : Exception(message)

class PurchasePendingException(message: String) : Exception(message)

class ProductNotAvailableException(message: String) : Exception(message)

class StoreProblemException(message: String) : Exception(message)
