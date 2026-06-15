package dev.rovenue.sdk

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
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
        val product = StoreProduct("pro_monthly", ProductType.SUBSCRIPTION, "Pro Monthly")
        val pkg = Package(identifier = "monthly", product = product)
        assertEquals("monthly", pkg.identifier)
        assertSame(product, pkg.product)
    }

    @Test
    fun `Offering groups packages and exposes default flag`() {
        val product = StoreProduct("pro_monthly", ProductType.SUBSCRIPTION, "Pro Monthly")
        val pkg = Package("monthly", product)
        val offering = Offering(identifier = "default", isDefault = true, packages = listOf(pkg))
        assertEquals("default", offering.identifier)
        assertTrue(offering.isDefault)
        assertEquals(1, offering.packages.size)
        assertSame(pkg, offering.packages[0])
    }

    @Test
    fun `Offerings exposes current and all map`() {
        val product = StoreProduct("pro_monthly", ProductType.SUBSCRIPTION, "Pro Monthly")
        val offering = Offering("default", true, listOf(Package("monthly", product)))
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
            creditBalance = 250L,
            productId = "coins_100",
            storeTransactionId = "GPA.1234",
        )
        assertTrue(result.entitlements.isEmpty())
        assertEquals(250L, result.creditBalance)
        assertEquals("coins_100", result.productId)
        assertEquals("GPA.1234", result.storeTransactionId)
    }

    @Test
    fun `purchase exceptions carry their message`() {
        assertEquals("nope", PurchaseCancelledException("nope").message)
        assertEquals("later", PurchasePendingException("later").message)
        assertEquals("gone", ProductNotAvailableException("gone").message)
        assertEquals("oops", StoreProblemException("oops").message)
    }
}
