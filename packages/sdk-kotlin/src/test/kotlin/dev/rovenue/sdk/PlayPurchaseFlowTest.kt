package dev.rovenue.sdk

import android.app.Activity
import dev.rovenue.sdk.generated.ReceiptResult
import dev.rovenue.sdk.internal.PlayPurchaseFlow
import dev.rovenue.sdk.internal.PendingPurchase
import dev.rovenue.sdk.internal.PlayStore
import dev.rovenue.sdk.internal.ProductInfo
import dev.rovenue.sdk.internal.StorePurchaseOutcome
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class PurchaseTypesTest {

    @Test
    fun `ProductType maps raw store strings`() {
        assertEquals(ProductType.CONSUMABLE, ProductType.from("CONSUMABLE"))
        assertEquals(ProductType.NON_CONSUMABLE, ProductType.from("NON_CONSUMABLE"))
        assertEquals(ProductType.SUBSCRIPTION, ProductType.from("SUBSCRIPTION"))
        // Unknown / default falls through to subscription.
        assertEquals(ProductType.SUBSCRIPTION, ProductType.from("anything-else"))
    }

    @Test
    fun `StoreProduct carries id type and optional price fields`() {
        val p = StoreProduct(
            id = "pro_monthly",
            type = ProductType.SUBSCRIPTION,
            productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Pro Monthly",
        )
        assertEquals("pro_monthly", p.id)
        assertEquals(ProductType.SUBSCRIPTION, p.type)
        assertEquals("Pro Monthly", p.displayName)
        assertNull(p.priceString)
        assertNull(p.price)
        assertNull(p.currencyCode)

        val priced = StoreProduct(
            id = "coins_100",
            type = ProductType.CONSUMABLE,
            productCategory = ProductCategory.NON_SUBSCRIPTION,
            displayName = "100 Coins",
            priceString = "$0.99",
            price = 0.99,
            currencyCode = "USD",
        )
        assertEquals("$0.99", priced.priceString)
        assertEquals(0.99, priced.price)
        assertEquals("USD", priced.currencyCode)
    }

    @Test
    fun `Package wraps a StoreProduct under an identifier`() {
        val product = StoreProduct(
            id = "pro_monthly",
            type = ProductType.SUBSCRIPTION,
            productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Pro Monthly",
        )
        val pkg = Package(identifier = "monthly", packageType = PackageType.CUSTOM, product = product)
        assertEquals("monthly", pkg.identifier)
        assertSame(product, pkg.product)
    }

    @Test
    fun `Offering groups packages and exposes default flag`() {
        val product = StoreProduct(
            id = "pro_monthly",
            type = ProductType.SUBSCRIPTION,
            productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Pro Monthly",
        )
        val pkg = Package(identifier = "monthly", packageType = PackageType.CUSTOM, product = product)
        val offering = Offering(identifier = "default", isDefault = true, packages = listOf(pkg))
        assertEquals("default", offering.identifier)
        assertTrue(offering.isDefault)
        assertEquals(1, offering.packages.size)
        assertSame(pkg, offering.packages[0])
    }

    @Test
    fun `Offerings exposes current and all map`() {
        val product = StoreProduct(
            id = "pro_monthly",
            type = ProductType.SUBSCRIPTION,
            productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Pro Monthly",
        )
        val offering = Offering(
            identifier = "default",
            isDefault = true,
            packages = listOf(Package(identifier = "monthly", packageType = PackageType.CUSTOM, product = product)),
        )
        val offerings = Offerings(current = offering, all = mapOf("default" to offering))
        assertSame(offering, offerings.current)
        assertEquals(1, offerings.all.size)
        assertSame(offering, offerings.all["default"])

        val empty = Offerings(current = null, all = emptyMap())
        assertNull(empty.current)
        assertTrue(empty.all.isEmpty())
    }

    @Test
    fun `PurchaseResult carries entitlements balance and ids`() {
        val result = PurchaseResult(
            entitlements = emptyList(),
            virtualCurrencies = mapOf("coins" to 250L),
            productId = "coins_100",
            storeTransactionId = "GPA.1234",
        )
        assertTrue(result.entitlements.isEmpty())
        assertEquals(mapOf("coins" to 250L), result.virtualCurrencies)
        assertEquals("coins_100", result.productId)
        assertEquals("GPA.1234", result.storeTransactionId)
    }

    @Test
    fun `RovenueException carries kind and message`() {
        val ex = RovenueException(kind = dev.rovenue.sdk.generated.ErrorKind.PURCHASE_CANCELED, message = "nope")
        assertEquals("nope", ex.message)
        assertEquals(dev.rovenue.sdk.generated.ErrorKind.PURCHASE_CANCELED, ex.kind)
    }
}

class PlayPurchaseFlowTest {

    private val activity = mockk<Activity>(relaxed = true)

    /** A PlayStore that always returns the supplied outcome. */
    private fun storeReturning(outcome: StorePurchaseOutcome) = object : PlayStore {
        override suspend fun purchase(
            activity: Activity,
            productId: String,
            productType: ProductType,
            obfuscatedAccountId: String?,
        ): StorePurchaseOutcome = outcome

        override suspend fun queryProducts(
            inappIds: List<String>,
            subscriptionIds: List<String>,
        ): Map<String, ProductInfo> = emptyMap()

        override suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase> = emptyList()
    }

    private fun receipt(virtualCurrencies: Map<String, Long>) =
        ReceiptResult(subscriberId = "sub_1", appUserId = "anon_1", virtualCurrencies = virtualCurrencies, entitlements = emptyList())

    @Test
    fun `cancelled outcome throws RovenueException(PURCHASE_CANCELED) and never validates`() = runTest {
        var validated = false
        val flow = PlayPurchaseFlow(
            store = storeReturning(StorePurchaseOutcome.UserCancelled),
            validate = { _, _ -> validated = true; receipt(emptyMap()) },
        )
        val ex = assertFailsWith<RovenueException> {
            flow.run(activity, "pro_monthly", ProductType.SUBSCRIPTION, null)
        }
        assertEquals(dev.rovenue.sdk.generated.ErrorKind.PURCHASE_CANCELED, ex.kind)
        assertFalse(validated, "validation must not run on a cancelled purchase")
    }

    @Test
    fun `deferred outcome returns PurchaseResult with isDeferred=true and never validates`() = runTest {
        var validated = false
        val flow = PlayPurchaseFlow(
            store = storeReturning(StorePurchaseOutcome.Deferred),
            validate = { _, _ -> validated = true; receipt(emptyMap()) },
        )
        val result = flow.run(activity, "pro_monthly", ProductType.SUBSCRIPTION, null)
        assertTrue(result.isDeferred, "deferred purchase must set isDeferred=true")
        assertFalse(validated, "validation must not run on a deferred purchase")
    }

    @Test
    fun `product-not-found outcome throws RovenueException(PRODUCT_NOT_AVAILABLE)`() = runTest {
        val flow = PlayPurchaseFlow(
            store = storeReturning(StorePurchaseOutcome.ProductNotFound),
            validate = { _, _ -> error("should not validate") },
        )
        val ex = assertFailsWith<RovenueException> {
            flow.run(activity, "missing", ProductType.CONSUMABLE, null)
        }
        assertEquals(dev.rovenue.sdk.generated.ErrorKind.PRODUCT_NOT_AVAILABLE, ex.kind)
    }

    @Test
    fun `already-owned outcome throws RovenueException(ALREADY_OWNED)`() = runTest {
        val flow = PlayPurchaseFlow(
            store = storeReturning(StorePurchaseOutcome.AlreadyOwned),
            validate = { _, _ -> error("should not validate") },
        )
        val ex = assertFailsWith<RovenueException> {
            flow.run(activity, "pro_monthly", ProductType.SUBSCRIPTION, null)
        }
        assertEquals(dev.rovenue.sdk.generated.ErrorKind.ALREADY_OWNED, ex.kind)
    }

    @Test
    fun `success validates then acknowledges then returns result`() = runTest {
        val order = mutableListOf<String>()
        val success = StorePurchaseOutcome.Success(
            purchaseToken = "tok_abc",
            orderId = "GPA.9999",
            acknowledge = { order.add("acknowledge") },
        )
        val flow = PlayPurchaseFlow(
            store = storeReturning(success),
            validate = { token, pid ->
                order.add("validate")
                assertEquals("tok_abc", token)
                assertEquals("coins_100", pid)
                receipt(mapOf("coins" to 500L))
            },
        )

        val result = flow.run(activity, "coins_100", ProductType.CONSUMABLE, "obf_1")

        // validate must happen strictly before acknowledge.
        assertEquals(listOf("validate", "acknowledge"), order)
        assertEquals(mapOf("coins" to 500L), result.virtualCurrencies)
        assertEquals("coins_100", result.productId)
        assertEquals("GPA.9999", result.storeTransactionId)
        assertTrue(result.entitlements.isEmpty())
    }

    @Test
    fun `validation failure prevents acknowledge`() = runTest {
        var acknowledged = false
        val success = StorePurchaseOutcome.Success(
            purchaseToken = "tok_abc",
            orderId = "GPA.9999",
            acknowledge = { acknowledged = true },
        )
        val flow = PlayPurchaseFlow(
            store = storeReturning(success),
            validate = { _, _ -> throw RovenueException(kind = dev.rovenue.sdk.generated.ErrorKind.STORE_PROBLEM, message = "server rejected") },
        )

        assertFailsWith<RovenueException> {
            flow.run(activity, "coins_100", ProductType.CONSUMABLE, null)
        }
        assertFalse(acknowledged, "must not acknowledge when validation fails")
    }
}
