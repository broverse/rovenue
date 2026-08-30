// HostApiImplTest.kt — unit tests for HostApiImpl's plugin-wiring seams
// that don't require a real Rovenue façade instance or a real Activity.
//
// The one seam the brief calls out explicitly (task-5-brief.md Step 2,
// task-5-context.md): `purchase()`/`restorePurchases()` must fail cleanly
// with `code == "Internal"` and a clear message when no Activity is
// attached, rather than crashing — this is what `RovenueFlutterAndroidPlugin`'s
// `ActivityAware` wiring guards against (see its onAttachedToActivity /
// onDetachedFromActivity handlers).
//
// The second seam: EVERY method must funnel a throwing façade call into
// `Result.failure(fail(e))`. Kotlin has no checked exceptions, so an
// unguarded `scope.launch { Rovenue.shared.… }` body lets the throw escape
// to the scope's (handler-less) uncaught path — which kills the app AND
// leaves the Dart `Future` hanging forever, because pigeon's reply never
// fires. `Rovenue.shared` throws `IllegalStateException` before
// `configure()`, which is exactly that shape and is what the tests below
// use to provoke it.

package dev.rovenue.flutter

import io.flutter.plugin.common.BinaryMessenger
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class HostApiImplTest {

    private companion object {
        /** `ErrorKind.INTERNAL`'s UDL variant name — the code every failure
         *  that isn't a `RovenueException` flattens to (see Mapping.kt's
         *  `fail`/`internalError`). */
        const val INTERNAL_ERROR_CODE = "Internal"
    }

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
        assertEquals(INTERNAL_ERROR_CODE, error.code)
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
        assertEquals(INTERNAL_ERROR_CODE, error.code)
        assertTrue(
            error.message?.contains("Activity", ignoreCase = true) == true,
            "expected a clear message about the missing Activity, got: ${error.message}",
        )
    }

    @Test
    fun asyncMethod_whenFacadeThrows_completesWithCodedFailure() {
        val hostApi = newHostApiImpl()
        var result: Result<RvUser>? = null

        // `Rovenue.configure()` was never called, so `Rovenue.shared` throws
        // IllegalStateException. The scope is Unconfined, so the launch body
        // runs synchronously on this thread — if the throw escaped, `result`
        // would still be null here (and in production the Dart Future would
        // never complete).
        hostApi.currentUser { result = it }

        val outcome = result
        checkNotNull(outcome) {
            "currentUser() must complete its callback even when the façade throws — an escaped throw hangs the Dart Future"
        }
        assertTrue(outcome.isFailure)
        val error = outcome.exceptionOrNull()
        checkNotNull(error)
        assertTrue(error is FlutterError, "expected a FlutterError, got ${error::class}")
        assertEquals(INTERNAL_ERROR_CODE, error.code)
    }

    @Test
    fun syncMethod_whenFacadeThrows_throwsCodedFlutterError() {
        val hostApi = newHostApiImpl()

        // Same provocation, synchronous surface: pigeon turns a thrown
        // FlutterError into a coded Dart error, but any other Throwable
        // escapes as an uncaught crash.
        val error = assertFailsWith<FlutterError> { hostApi.getVersion() }
        assertEquals(INTERNAL_ERROR_CODE, error.code)
    }
}
