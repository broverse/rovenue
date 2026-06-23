// PurchaseReconcilerTest.kt — unit tests for background purchase reconciliation.
// Drives PurchaseReconciler with a FAKE PlayStore so no live Play Billing /
// network is needed. Asserts the validate-then-acknowledge contract.

package dev.rovenue.sdk

import android.app.Activity
import dev.rovenue.sdk.internal.PendingPurchase
import dev.rovenue.sdk.internal.PlayStore
import dev.rovenue.sdk.internal.ProductInfo
import dev.rovenue.sdk.internal.PurchaseReconciler
import dev.rovenue.sdk.internal.StorePurchaseOutcome
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PurchaseReconcilerTest {

    /** A PlayStore that returns a fixed list of pending purchases. */
    private class FakeReconcileStore(private val pending: List<PendingPurchase>) : PlayStore {
        override suspend fun purchase(
            activity: Activity,
            productId: String,
            productType: ProductType,
            obfuscatedAccountId: String?,
        ): StorePurchaseOutcome = StorePurchaseOutcome.ProductNotFound

        override suspend fun queryProducts(
            inappIds: List<String>,
            subscriptionIds: List<String>,
        ): Map<String, ProductInfo> = emptyMap()

        override suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase> = pending
    }

    @Test
    fun `validates and acknowledges only the unacknowledged purchase`() = runTest {
        val acked = mutableListOf<String>()
        val validated = mutableListOf<String>()

        val unacked = PendingPurchase(
            purchaseToken = "tok_unacked",
            productId = "coins_100",
            productType = ProductType.CONSUMABLE,
            isAcknowledged = false,
            acknowledge = { acked.add("tok_unacked") },
        )
        val alreadyAcked = PendingPurchase(
            purchaseToken = "tok_acked",
            productId = "pro_monthly",
            productType = ProductType.SUBSCRIPTION,
            isAcknowledged = true,
            acknowledge = { acked.add("tok_acked") },
        )

        val reconciler = PurchaseReconciler(
            store = FakeReconcileStore(listOf(unacked, alreadyAcked)),
            validate = { token, _ -> validated.add(token) },
        )

        reconciler.reconcile()

        assertEquals(listOf("tok_unacked"), validated, "only the unacked purchase is validated")
        assertEquals(listOf("tok_unacked"), acked, "only the unacked purchase is acknowledged")
    }

    @Test
    fun `does not acknowledge when validation fails`() = runTest {
        var acknowledged = false
        val unacked = PendingPurchase(
            purchaseToken = "tok_unacked",
            productId = "coins_100",
            productType = ProductType.CONSUMABLE,
            isAcknowledged = false,
            acknowledge = { acknowledged = true },
        )

        val reconciler = PurchaseReconciler(
            store = FakeReconcileStore(listOf(unacked)),
            validate = { _, _ -> throw RovenueException(kind = dev.rovenue.sdk.generated.ErrorKind.STORE_PROBLEM, message = "server rejected") },
        )

        // reconcile swallows the per-purchase failure (does not throw).
        reconciler.reconcile()

        assertFalse(acknowledged, "must not acknowledge when validation fails")
    }

    @Test
    fun `acknowledge runs strictly after validate succeeds`() = runTest {
        val order = mutableListOf<String>()
        val unacked = PendingPurchase(
            purchaseToken = "tok_unacked",
            productId = "coins_100",
            productType = ProductType.CONSUMABLE,
            isAcknowledged = false,
            acknowledge = { order.add("acknowledge") },
        )

        val reconciler = PurchaseReconciler(
            store = FakeReconcileStore(listOf(unacked)),
            validate = { _, _ -> order.add("validate") },
        )

        reconciler.reconcile()

        assertEquals(listOf("validate", "acknowledge"), order)
        assertTrue(order.isNotEmpty())
    }
}
