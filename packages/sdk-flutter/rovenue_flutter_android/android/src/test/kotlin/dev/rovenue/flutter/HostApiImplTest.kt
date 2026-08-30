// HostApiImplTest.kt — unit tests for HostApiImpl's plugin-wiring seams
// that don't require a real Rovenue façade instance or a real Activity.
//
// The one seam the brief calls out explicitly (task-5-brief.md Step 2,
// task-5-context.md): `purchase()`/`restorePurchases()` must fail cleanly
// with `code == "Internal"` and a clear message when no Activity is
// attached, rather than crashing — this is what `RovenueFlutterAndroidPlugin`'s
// `ActivityAware` wiring guards against (see its onAttachedToActivity /
// onDetachedFromActivity handlers).

package dev.rovenue.flutter

import io.flutter.plugin.common.BinaryMessenger
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HostApiImplTest {

    private fun newHostApiImpl(): HostApiImpl {
        val messenger = mockk<BinaryMessenger>(relaxed = true)
        val flutterApi = RovenueFlutterApi(messenger)
        val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
        val eventBridge = EventBridge(flutterApi, scope)
        return HostApiImpl(
            appContext = null,
            activityProvider = { null },
            eventBridge = eventBridge,
            scope = scope,
        )
    }

    @Test
    fun purchase_noActivity_failsWithInternalCode() {
        val hostApi = newHostApiImpl()
        var result: Result<RvPurchaseResult>? = null

        hostApi.purchase(
            productId = "monthly_id",
            productType = RvProductType.SUBSCRIPTION,
            promotionalOfferId = null,
            basePlanId = null,
            offerId = null,
        ) { result = it }

        val failure = result
        checkNotNull(failure) { "purchase() must invoke its callback synchronously when no Activity is attached" }
        assertTrue(failure.isFailure)
        val error = failure.exceptionOrNull()
        checkNotNull(error)
        assertTrue(error is FlutterError, "expected a FlutterError, got ${error::class}")
        assertEquals("Internal", error.code)
        assertTrue(
            error.message?.contains("Activity", ignoreCase = true) == true,
            "expected a clear message about the missing Activity, got: ${error.message}",
        )
    }

    @Test
    fun restorePurchases_noActivity_failsWithInternalCode() {
        val hostApi = newHostApiImpl()
        var result: Result<RvPurchaseResult>? = null

        hostApi.restorePurchases { result = it }

        val failure = result
        checkNotNull(failure) { "restorePurchases() must invoke its callback synchronously when no Activity is attached" }
        assertTrue(failure.isFailure)
        val error = failure.exceptionOrNull()
        checkNotNull(error)
        assertTrue(error is FlutterError, "expected a FlutterError, got ${error::class}")
        assertEquals("Internal", error.code)
        assertTrue(
            error.message?.contains("Activity", ignoreCase = true) == true,
            "expected a clear message about the missing Activity, got: ${error.message}",
        )
    }
}
