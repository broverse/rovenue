// MappingTest.kt — unit tests for Mapping.kt's façade → Pigeon DTO
// conversions and the `fail(_:)` error mapper.
//
// Mirrors packages/sdk-flutter/rovenue_flutter_ios/ios/Tests/HostApiImplTests.swift's
// four cases (entitlement with nil expiry, two-package offering, purchase
// result, one PurchaseCanceled error conversion) plus a 24-case sweep over
// every UDL `ErrorKind` variant — the binding error contract carried over
// from task-4-context.md into task-5-context.md.

package dev.rovenue.flutter

import dev.rovenue.sdk.Discount
import dev.rovenue.sdk.DiscountType
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.PurchaseResult
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.generated.Entitlement
import dev.rovenue.sdk.generated.ErrorKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MappingTest {

    // MARK: - Entitlement with expiresAt nil

    @Test
    fun mapEntitlement_expiresAtNil() {
        val e = Entitlement(
            id = "ent_pro",
            isActive = true,
            productIdentifier = "com.rovenue.pro.monthly",
            store = "play_store",
            expiresIso = null,
        )
        val dto = mapEntitlement(e)
        assertEquals("ent_pro", dto.id)
        assertTrue(dto.active)
        assertNull(dto.expiresAt)
        assertEquals("com.rovenue.pro.monthly", dto.productId)
    }

    // MARK: - Offering with two packages

    @Test
    fun mapOffering_twoPackages() {
        fun product(id: String) = StoreProduct(
            id = id,
            type = ProductType.SUBSCRIPTION,
            productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Pro ($id)",
            priceString = "\$9.99",
            price = 9.99,
            currencyCode = "USD",
            subscriptionPeriod = Period(value = 1, unit = PeriodUnit.MONTH, iso8601 = "P1M"),
            subscriptionGroupIdentifier = "group1",
            isFamilyShareable = false,
            pricePerMonth = 9.99,
            pricePerMonthString = "\$9.99",
        )

        val offering = Offering(
            identifier = "default",
            isDefault = true,
            packages = listOf(
                Package(identifier = "\$rov_monthly", packageType = PackageType.MONTHLY, product = product("monthly_id")),
                Package(identifier = "\$rov_annual", packageType = PackageType.ANNUAL, product = product("annual_id")),
            ),
        )

        val dto = mapOffering(offering)
        assertEquals("default", dto.identifier)
        assertTrue(dto.isDefault)
        assertEquals(2, dto.packages.size)
        assertEquals("\$rov_monthly", dto.packages[0].identifier)
        assertEquals(RvPackageType.MONTHLY, dto.packages[0].packageType)
        assertEquals("monthly_id", dto.packages[0].product.id)
        assertEquals("\$rov_annual", dto.packages[1].identifier)
        assertEquals(RvPackageType.ANNUAL, dto.packages[1].packageType)
        assertEquals("annual_id", dto.packages[1].product.id)
        // Discounts are always empty on Android (see Mapping.kt's
        // mapStoreProduct comment) — subscriptionOptions/defaultOption are
        // Android-only and both null here since `product()` leaves them unset.
        assertTrue(dto.packages[0].product.discounts.isEmpty())
        assertNull(dto.packages[0].product.subscriptionOptions)
        assertNull(dto.packages[0].product.defaultOption)
    }

    // MARK: - Purchase result

    @Test
    fun mapPurchaseResult_test() {
        val entitlement = Entitlement(
            id = "ent_pro",
            isActive = true,
            productIdentifier = "monthly_id",
            store = "play_store",
            expiresIso = "2027-01-01T00:00:00Z",
        )
        val result = PurchaseResult(
            entitlements = listOf(entitlement),
            virtualCurrencies = mapOf("gems" to 100L),
            productId = "monthly_id",
            storeTransactionId = "txn_123",
            isDeferred = false,
        )

        val dto = mapPurchaseResult(result)
        assertEquals(1, dto.entitlements.size)
        assertEquals("ent_pro", dto.entitlements[0].id)
        assertEquals("2027-01-01T00:00:00Z", dto.entitlements[0].expiresAt)
        assertEquals(100L, dto.virtualCurrencies["gems"])
        assertEquals("monthly_id", dto.productId)
        assertEquals("txn_123", dto.storeTransactionId)
        assertFalse(dto.isDeferred)
    }

    // MARK: - Error conversion

    @Test
    fun fail_purchaseCanceled() {
        val error = RovenueException(
            kind = ErrorKind.PURCHASE_CANCELED,
            message = "The user canceled the purchase sheet.",
        )
        val flutterError = fail(error)

        assertEquals("PurchaseCanceled", flutterError.code)
        assertEquals("The user canceled the purchase sheet.", flutterError.message)

        @Suppress("UNCHECKED_CAST")
        val details = flutterError.details as Map<String, Any?>
        assertEquals("The user canceled the purchase sheet.", details["detail"])
        assertEquals(false, details["retryable"])
    }

    /** Every UDL `ErrorKind` variant must round-trip to its exact PascalCase
     *  name — this is the binding error contract from task-5-context.md
     *  (carried over from Task 4). Exercises all 24 names in one pass so a
     *  future core-rs addition (which would fail to compile
     *  `ErrorKind.udlVariantName`'s exhaustive `when`) is also caught here
     *  if the `when` is ever relaxed with an `else` branch. */
    @Test
    fun fail_allErrorKindsMapToUdlVariantNames() {
        val expected = mapOf(
            ErrorKind.NETWORK_UNAVAILABLE to "NetworkUnavailable",
            ErrorKind.TIMEOUT to "Timeout",
            ErrorKind.RATE_LIMITED to "RateLimited",
            ErrorKind.SERVER_ERROR to "ServerError",
            ErrorKind.INVALID_API_KEY to "InvalidApiKey",
            ErrorKind.FORBIDDEN to "Forbidden",
            ErrorKind.NOT_FOUND to "NotFound",
            ErrorKind.INVALID_REQUEST to "InvalidRequest",
            ErrorKind.CONFLICT to "Conflict",
            ErrorKind.INVALID_ARGUMENT to "InvalidArgument",
            ErrorKind.INSUFFICIENT_CREDITS to "InsufficientCredits",
            ErrorKind.FUNNEL_TOKEN_NOT_FOUND to "FunnelTokenNotFound",
            ErrorKind.FUNNEL_TOKEN_EXPIRED to "FunnelTokenExpired",
            ErrorKind.FUNNEL_TOKEN_ALREADY_CLAIMED to "FunnelTokenAlreadyClaimed",
            ErrorKind.PURCHASE_CANCELED to "PurchaseCanceled",
            ErrorKind.PRODUCT_NOT_AVAILABLE to "ProductNotAvailable",
            ErrorKind.ALREADY_OWNED to "AlreadyOwned",
            ErrorKind.PAYMENT_DECLINED to "PaymentDeclined",
            ErrorKind.STORE_SERVICE_UNAVAILABLE to "StoreServiceUnavailable",
            ErrorKind.INELIGIBLE to "Ineligible",
            ErrorKind.RECEIPT_INVALID to "ReceiptInvalid",
            ErrorKind.STORE_PROBLEM to "StoreProblem",
            ErrorKind.STORAGE to "Storage",
            ErrorKind.INTERNAL to "Internal",
        )
        assertEquals(24, expected.size, "sanity check: all 24 UDL ErrorKind variants must be covered")
        for ((kind, name) in expected) {
            val error = RovenueException(kind = kind, message = "x")
            assertEquals(name, fail(error).code, "ErrorKind.$kind must map to \"$name\"")
        }
    }

    @Test
    fun fail_nonRovenueError_mapsToInternal() {
        class SomeOtherError : Throwable()
        val flutterError = fail(SomeOtherError())
        assertEquals("Internal", flutterError.code)
        @Suppress("UNCHECKED_CAST")
        val details = flutterError.details as Map<String, Any?>
        assertEquals(false, details["retryable"])
    }
}
