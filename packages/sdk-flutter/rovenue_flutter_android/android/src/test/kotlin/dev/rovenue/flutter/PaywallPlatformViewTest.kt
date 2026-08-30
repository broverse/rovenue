// PaywallPlatformViewTest.kt — regression test for the Activity leak that
// `PaywallPlatformView.dispose()` used to cause.
//
// `channel.setMethodCallHandler(::onMethodCall)` registers a BOUND callable
// reference, so Flutter's `DartMessenger` holds a strong reference to the
// PlatformView — which holds `RovenuePaywallView(context)`, where `context`
// is the host Activity. Channel names are unique per view id, so nothing
// ever overwrites a stale entry: without an explicit unregister in
// `dispose()`, every mounted-and-dismissed paywall pins one Activity for
// the life of the FlutterEngine.
//
// The seam this asserts on is the messenger itself: `MethodChannel`
// forwards `setMethodCallHandler(handler)` to
// `BinaryMessenger.setMessageHandler(name, handler)` and a null handler to
// `setMessageHandler(name, null)`, so recording that call is exactly what
// "the DartMessenger no longer holds this view" looks like from here.

package dev.rovenue.flutter

import android.content.Context
import io.flutter.plugin.common.BinaryMessenger
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class PaywallPlatformViewTest {

    private companion object {
        const val VIEW_ID = 7
        const val CHANNEL_NAME = "dev.rovenue.flutter/paywall_view_$VIEW_ID"

        /** An empty placement makes `load()` return before it ever touches
         *  `Rovenue.shared` — this test is about channel lifetime, not
         *  paywall resolution. */
        val CREATION_PARAMS: Map<String, Any?> = mapOf(
            "placementIdentifier" to "",
            "locale" to null,
            "colorSchemeOverride" to null,
            "hasRestoreHandler" to false,
            "hasUrlHandler" to false,
        )
    }

    /** `RovenuePaywallView`'s constructor builds a
     *  `CoroutineScope(... + Dispatchers.Main.immediate)`, which throws on a
     *  plain JVM test JVM unless a main dispatcher is installed. */
    @BeforeTest
    fun installMainDispatcher() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @AfterTest
    fun removeMainDispatcher() {
        Dispatchers.resetMain()
    }

    @Test
    fun dispose_unregistersTheMethodCallHandler() {
        val registered = mutableMapOf<String, BinaryMessenger.BinaryMessageHandler?>()
        val messenger = mockk<BinaryMessenger>(relaxed = true)
        every { messenger.setMessageHandler(any(), any()) } answers {
            registered[firstArg()] = secondArg()
        }

        val view = PaywallPlatformView(
            context = mockk<Context>(relaxed = true),
            viewId = VIEW_ID,
            args = CREATION_PARAMS,
            messenger = messenger,
        )

        assertTrue(
            registered.containsKey(CHANNEL_NAME),
            "expected the view to register a handler on $CHANNEL_NAME, saw ${registered.keys}",
        )
        assertNotNull(registered[CHANNEL_NAME], "handler must be live before dispose()")

        view.dispose()

        assertNull(
            registered[CHANNEL_NAME],
            "dispose() must clear the handler or the DartMessenger keeps the view (and its Activity) alive",
        )
    }
}
