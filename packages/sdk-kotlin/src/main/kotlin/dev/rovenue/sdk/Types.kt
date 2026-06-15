// Types.kt — public purchase-surface types mirroring the Swift SDK.
//
// These are the developer-facing shapes returned by getOfferings() and
// purchase(). They are deliberately separate from the UniFFI-generated
// Core* types (CoreOfferings / CoreOffering / CoreOfferingProduct), which
// are internal FFI wire types; Rovenue maps Core* -> these on the way out.

package dev.rovenue.sdk

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

/**
 * A purchasable product as configured in Rovenue. In v1 the price fields are
 * null at the offerings layer (configuration only); localized price metadata
 * comes from Play Billing's ProductDetails at purchase time.
 */
data class StoreProduct(
    val id: String,
    val type: ProductType,
    val displayName: String,
    val priceString: String? = null,
    val price: Double? = null,
    val currencyCode: String? = null,
)

/** A named slot within an [Offering] that points at a single [StoreProduct]. */
data class Package(
    val identifier: String,
    val product: StoreProduct,
)

/** A group of packages presented together (e.g. a paywall configuration). */
data class Offering(
    val identifier: String,
    val isDefault: Boolean,
    val packages: List<Package>,
)

/** The full set of configured offerings plus the currently-selected one. */
data class Offerings(
    val current: Offering?,
    val all: Map<String, Offering>,
)

/** The outcome of a successful, validated purchase. */
data class PurchaseResult(
    val entitlements: List<Entitlement>,
    val creditBalance: Long,
    val productId: String,
    val storeTransactionId: String,
)

// Purchase exceptions — top-level classes (the generated RovenueException is a
// sealed class we must not extend). Mirrors the Swift SDK's purchase errors.

class PurchaseCancelledException(message: String) : Exception(message)

class PurchasePendingException(message: String) : Exception(message)

class ProductNotAvailableException(message: String) : Exception(message)

class StoreProblemException(message: String) : Exception(message)
