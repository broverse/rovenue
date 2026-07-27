package dev.rovenue.sdk.paywallui

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import androidx.core.widget.NestedScrollView
import dev.rovenue.sdk.Paywall
import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.mockkConstructor
import io.mockk.mockkStatic
import io.mockk.spyk
import io.mockk.unmockkConstructor
import io.mockk.unmockkStatic
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

/**
 * Task 2 (wave C): every paywall renderer needs a scroll container at its
 * root, or a paywall taller than the screen has unreachable content —
 * purchase button included. This mirrors the web (`data-rov-paywall-scroll`
 * + `minHeight: 100%`) and SwiftUI (`ScrollView` + `.frame(minHeight:)`)
 * siblings' scroll-container tests.
 *
 * Real Android-view-construction is otherwise manually smoked in this module
 * (see RovenuePaywallView.kt's class doc) — this uses the same
 * `mockkConstructor` technique NodeViewFactoryTest's "real View-tree
 * assertions" section already relies on, which verifies the MOCKED
 * addView/property-setter CALLS `render()` makes on a real
 * `NestedScrollView` instance, not state read back off it afterward (this
 * module's stub android.jar reports ViewGroup bookkeeping like
 * `childCount`/`getChildAt` as always-empty regardless of what was actually
 * added).
 */
class RovenuePaywallViewTest {

    private fun mockContext(): Context = mockk(relaxed = true)

    @AfterEach
    fun tearDown() {
        unmockkConstructor(NestedScrollView::class)
        unmockkStatic(ViewConfiguration::class)
    }

    private fun paywallWithBuilderConfig(json: String) = Paywall(
        placementIdentifier = "plc_1",
        placementRevision = 1,
        paywallIdentifier = "pw_1",
        paywallName = "Test Paywall",
        configFormatVersion = 2,
        remoteConfig = null,
        remoteConfigLocale = null,
        offering = null,
        presentedContext = null,
        builderConfigJson = json,
    )

    @Test
    fun `bind wraps the root content in a NestedScrollView with isFillViewport true`() {
        // NestedScrollView is real androidx.core bytecode (unlike
        // LinearLayout/ImageView/TextView, which come from this module's
        // gutted-by-`isReturnDefaultValues` fake android.jar) — mockk still
        // runs its actual constructor, which calls the STUBBED, always-null
        // `ViewConfiguration.get(context)` and then dereferences it. Stubbed
        // statically so the real constructor can complete.
        mockkStatic(ViewConfiguration::class)
        every { ViewConfiguration.get(any()) } returns mockk(relaxed = true)

        mockkConstructor(NestedScrollView::class)
        every { anyConstructed<NestedScrollView>().addView(any<View>(), any<ViewGroup.LayoutParams>()) } just Runs
        every { anyConstructed<NestedScrollView>().isFillViewport = any() } just Runs

        val json = """
            {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
             "root":{"type":"stack","id":"root","axis":"v","children":[{"type":"text","id":"t1","key":"k","role":"body"}]}}
        """.trimIndent()
        val fakeContext = mockContext()
        // spyk, not a plain instance: render() reads `this.context` (the
        // `NestedScrollView(context)` construction) and `this.resources
        // .configuration.uiMode` (dark-mode detection) — both inherited
        // View properties this module's stub android.jar always returns
        // null for (the real delegation to the constructing Context is
        // stripped out of the stub), which trips Kotlin's non-null
        // assertion before ever reaching the scroll-container code this
        // test targets.
        val paywallView = spyk(RovenuePaywallView(fakeContext))
        val resources: Resources = mockk(relaxed = true)
        every { resources.configuration } returns Configuration()
        every { paywallView.getResources() } returns resources
        every { paywallView.getContext() } returns fakeContext

        paywallView.bind(paywallWithBuilderConfig(json))

        // The trap this task guards against: without isFillViewport = true,
        // a short paywall's content stops filling the screen and any stack
        // pushing its CTA to the bottom rides up instead.
        verify(exactly = 1) { anyConstructed<NestedScrollView>().isFillViewport = true }
        verify(exactly = 1) {
            anyConstructed<NestedScrollView>().addView(any<View>(), any<ViewGroup.LayoutParams>())
        }
    }
}
