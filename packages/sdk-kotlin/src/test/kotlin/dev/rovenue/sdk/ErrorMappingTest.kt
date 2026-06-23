// ErrorMappingTest.kt — TDD: write first, then implement mapBillingCode.
//
// These tests exercise the pure billing-code → StorePurchaseOutcome mapping
// without requiring a live BillingClient or Activity.

package dev.rovenue.sdk

import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.Purchase
import dev.rovenue.sdk.internal.StorePurchaseOutcome
import dev.rovenue.sdk.internal.mapBillingCode
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class ErrorMappingTest {

    // ---------------------------------------------------------------
    // Happy-path error codes
    // ---------------------------------------------------------------

    @Test
    fun `USER_CANCELED maps to UserCancelled`() {
        assertEquals(
            StorePurchaseOutcome.UserCancelled,
            mapBillingCode(BillingClient.BillingResponseCode.USER_CANCELED, null, null),
        )
    }

    @Test
    fun `ITEM_UNAVAILABLE maps to ProductNotFound`() {
        assertEquals(
            StorePurchaseOutcome.ProductNotFound,
            mapBillingCode(BillingClient.BillingResponseCode.ITEM_UNAVAILABLE, null, null),
        )
    }

    @Test
    fun `ITEM_ALREADY_OWNED maps to AlreadyOwned`() {
        assertEquals(
            StorePurchaseOutcome.AlreadyOwned,
            mapBillingCode(BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED, null, null),
        )
    }

    @Test
    fun `SERVICE_DISCONNECTED maps to ServiceUnavailable`() {
        assertEquals(
            StorePurchaseOutcome.ServiceUnavailable,
            mapBillingCode(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED, null, null),
        )
    }

    @Test
    fun `SERVICE_UNAVAILABLE maps to ServiceUnavailable`() {
        assertEquals(
            StorePurchaseOutcome.ServiceUnavailable,
            mapBillingCode(BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE, null, null),
        )
    }

    @Test
    fun `BILLING_UNAVAILABLE maps to ServiceUnavailable`() {
        assertEquals(
            StorePurchaseOutcome.ServiceUnavailable,
            mapBillingCode(BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, null, null),
        )
    }

    @Test
    fun `NETWORK_ERROR maps to ServiceUnavailable`() {
        assertEquals(
            StorePurchaseOutcome.ServiceUnavailable,
            mapBillingCode(BillingClient.BillingResponseCode.NETWORK_ERROR, null, null),
        )
    }

    @Test
    fun `unknown code maps to StoreProblem`() {
        assertEquals(
            StorePurchaseOutcome.StoreProblem,
            mapBillingCode(999, null, null),
        )
    }

    // ---------------------------------------------------------------
    // Deferred (PENDING purchase state)
    // ---------------------------------------------------------------

    @Test
    fun `pending is Deferred not an exception`() {
        assertEquals(
            StorePurchaseOutcome.Deferred,
            mapBillingCode(BillingClient.BillingResponseCode.OK, null, Purchase.PurchaseState.PENDING),
        )
    }

    @Test
    fun `OK with null state is Deferred`() {
        assertEquals(
            StorePurchaseOutcome.Deferred,
            mapBillingCode(BillingClient.BillingResponseCode.OK, null, null),
        )
    }

    // ---------------------------------------------------------------
    // PBL9 sub-response codes (passed as subResponse param)
    // ---------------------------------------------------------------

    @Test
    fun `PBL9 sub-response PAYMENT_DECLINED maps to PaymentDeclined`() {
        // BillingClient.BillingResponseCode.PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS = 9
        // The sub-response code for payment declined is 1 (PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS)
        assertEquals(
            StorePurchaseOutcome.PaymentDeclined,
            mapBillingCode(BillingClient.BillingResponseCode.ERROR, 1 /* PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS */, null),
        )
    }

    @Test
    fun `PBL9 sub-response USER_INELIGIBLE maps to Ineligible`() {
        // Sub-response code 2 = USER_INELIGIBLE
        assertEquals(
            StorePurchaseOutcome.Ineligible,
            mapBillingCode(BillingClient.BillingResponseCode.ERROR, 2 /* USER_INELIGIBLE */, null),
        )
    }

    @Test
    fun `ERROR with unknown sub-response maps to StoreProblem`() {
        assertEquals(
            StorePurchaseOutcome.StoreProblem,
            mapBillingCode(BillingClient.BillingResponseCode.ERROR, null, null),
        )
    }
}
