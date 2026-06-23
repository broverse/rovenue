// PlayPurchaseFlowOfferTest.kt — verifies that basePlanId/offerId are threaded
// through PlayPurchaseFlow.run → PlayStore.purchase, and that OfferNotFound
// surfaces as RovenueException(PRODUCT_NOT_AVAILABLE).

package dev.rovenue.sdk

import android.app.Activity
import dev.rovenue.sdk.generated.ReceiptResult
import dev.rovenue.sdk.internal.PendingPurchase
import dev.rovenue.sdk.internal.PlayPurchaseFlow
import dev.rovenue.sdk.internal.PlayStore
import dev.rovenue.sdk.internal.ProductInfo
import dev.rovenue.sdk.internal.StorePurchaseOutcome
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PlayPurchaseFlowOfferTest {

    private val activity = mockk<Activity>(relaxed = true)

    /** A fake PlayStore that returns a fixed outcome and records the params passed to purchase(). */
    private class FakeStore(val outcome: StorePurchaseOutcome) : PlayStore {
        var capturedBasePlanId: String? = "UNSET"
        var capturedOfferId: String? = "UNSET"

        override suspend fun purchase(
            activity: Activity,
            productId: String,
            productType: ProductType,
            obfuscatedAccountId: String?,
            basePlanId: String?,
            offerId: String?,
        ): StorePurchaseOutcome {
            capturedBasePlanId = basePlanId
            capturedOfferId = offerId
            return outcome
        }

        override suspend fun queryProducts(
            inappIds: List<String>,
            subscriptionIds: List<String>,
        ): Map<String, ProductInfo> = emptyMap()

        override suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase> = emptyList()
    }

    private fun receipt() =
        ReceiptResult(subscriberId = "sub_1", appUserId = "anon_1", virtualCurrencies = emptyMap(), entitlements = emptyList())

    @Test
    fun `basePlanId and offerId are threaded to the store`() = runTest {
        val store = FakeStore(
            StorePurchaseOutcome.Success(
                purchaseToken = "tok_abc",
                orderId = "GPA.9999",
                acknowledge = {},
            ),
        )
        val flow = PlayPurchaseFlow(store) { _, _ -> receipt() }

        flow.run(activity, "premium", ProductType.SUBSCRIPTION, null, "monthly", "trial")

        assertEquals("monthly", store.capturedBasePlanId)
        assertEquals("trial", store.capturedOfferId)
    }

    @Test
    fun `OfferNotFound outcome throws RovenueException(PRODUCT_NOT_AVAILABLE)`() = runTest {
        val store = FakeStore(StorePurchaseOutcome.OfferNotFound)
        val flow = PlayPurchaseFlow(store) { _, _ -> receipt() }

        val ex = assertFailsWith<RovenueException> {
            flow.run(activity, "premium", ProductType.SUBSCRIPTION, null, "gone", null)
        }
        assertEquals(dev.rovenue.sdk.generated.ErrorKind.PRODUCT_NOT_AVAILABLE, ex.kind)
    }
}
