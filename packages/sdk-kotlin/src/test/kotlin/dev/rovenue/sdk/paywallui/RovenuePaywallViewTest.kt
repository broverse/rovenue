package dev.rovenue.sdk.paywallui

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.LinearLayout
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
import kotlin.test.assertEquals
import kotlin.test.assertNull

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

    /**
     * I11 — the measure chain, which `isFillViewport` alone does NOT
     * guarantee. `NestedScrollView` re-measures its DIRECT child with an
     * EXACTLY spec of the viewport height; the footer path used to insert a
     * `FrameLayout` holding the root stack at `WRAP_CONTENT` between the
     * two, which turns that EXACTLY into an AT_MOST, and a `LinearLayout`
     * measured AT_MOST hands its weighted children nothing — a flexible
     * `spacer` collapses and a stack that distributed its children across
     * the viewport hugs the top. The old test could not see this: the tree
     * still built and every assertion still passed.
     *
     * So this asserts the shape that carries the EXACTLY spec down to the
     * root stack: the scroller's child is the ROOT STACK ITSELF (a
     * `LinearLayout`, since this fixture's root is a vertical stack), not a
     * wrapper, and the clearance rides on the scroller's OWN padding, which
     * `NestedScrollView` subtracts from that same spec (border-box, not
     * added on top).
     *
     * What no JVM test in this module can see is the measure pass itself —
     * this module's android.jar is gutted, so nothing actually measures or
     * lays out. Reintroducing the wrapper fails this test (mutation-checked
     * in the task report); a wrapper introduced somewhere else in the chain
     * would need the device smoke pass.
     */
    @Test
    fun `the scroll child is the root stack itself and the footer clearance is the scroller's own padding`() {
        mockkStatic(ViewConfiguration::class)
        every { ViewConfiguration.get(any()) } returns mockk(relaxed = true)

        mockkConstructor(NestedScrollView::class)
        every { anyConstructed<NestedScrollView>().addView(any<View>(), any<ViewGroup.LayoutParams>()) } just Runs
        every { anyConstructed<NestedScrollView>().isFillViewport = any() } just Runs
        every { anyConstructed<NestedScrollView>().clipToPadding = any() } just Runs
        every { anyConstructed<NestedScrollView>().setPadding(any(), any(), any(), any()) } just Runs

        val json = """
            {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
             "root":{"type":"stack","id":"root","axis":"v","children":[
               {"type":"text","id":"t1","key":"k","role":"body"},
               {"type":"stickyFooter","id":"f1","children":[{"type":"text","id":"t2","key":"k","role":"body"}]}]}}
        """.trimIndent()
        val fakeContext = mockContext()
        val paywallView = spyk(RovenuePaywallView(fakeContext))
        val resources: Resources = mockk(relaxed = true)
        every { resources.configuration } returns Configuration()
        every { paywallView.getResources() } returns resources
        every { paywallView.getContext() } returns fakeContext

        paywallView.bind(paywallWithBuilderConfig(json))

        // A wrapper between the two would make this child a FrameLayout.
        verify(exactly = 1) {
            anyConstructed<NestedScrollView>().addView(
                match<View> { it is LinearLayout },
                any<ViewGroup.LayoutParams>(),
            )
        }
        verify(exactly = 1) { anyConstructed<NestedScrollView>().isFillViewport = true }
        verify(exactly = 1) { anyConstructed<NestedScrollView>().clipToPadding = false }
        verify(atLeast = 1) { anyConstructed<NestedScrollView>().setPadding(0, 0, 0, any()) }

        // C1 — the footer OVERLAYS the scroller: both are direct children of
        // this FrameLayout. The weighted-LinearLayout sibling shape it
        // replaces added exactly ONE child here (the outer LinearLayout).
        verify(exactly = 2) { paywallView.addView(any<View>(), any<ViewGroup.LayoutParams>()) }
        verify(exactly = 1) {
            paywallView.addView(match<View> { it is NestedScrollView }, any<ViewGroup.LayoutParams>())
        }
    }

    // ---- root partition (pure) ---------------------------------------------

    private fun text(id: String) = BuilderNode.Text(id = id, key = "k", role = TextRole.BODY)
    private fun footer(id: String) = BuilderNode.StickyFooter(id = id, children = listOf(text("$id.child")))
    private fun root(vararg children: BuilderNode) =
        BuilderNode.Stack(id = "root", axis = Axis.V, children = children.toList())

    @Test
    fun `partitionRootChildren pins a stickyFooter that is the last direct child`() {
        val partition = partitionRootChildren(root(text("t1"), footer("f1")))
        assertEquals("f1", partition.stickyFooter?.id)
        assertEquals(listOf("t1"), partition.scrolledChildren.map { it.id })
    }

    /**
     * I9 — a `stickyFooter` is pinned when it is a DIRECT child of the
     * root, WHEREVER it sits among its siblings. Reading the rule as "the
     * last child only" silently un-pinned this shape: the footer rendered
     * in-flow, above the text, and nothing warned (the validator only warns
     * about footers that are not direct root children).
     */
    @Test
    fun `partitionRootChildren pins a stickyFooter that is not last`() {
        val partition = partitionRootChildren(root(footer("f1"), text("t1")))
        assertEquals("f1", partition.stickyFooter?.id)
        assertEquals(listOf("t1"), partition.scrolledChildren.map { it.id })
    }

    /** Among several direct-child footers the LAST wins; the earlier ones
     *  stay in the scrolled content and render in-flow. The "last child"
     *  reading pinned NEITHER of these. */
    @Test
    fun `partitionRootChildren pins the last of several stickyFooters and leaves the earlier ones inline`() {
        val partition = partitionRootChildren(root(footer("fA"), text("t1"), footer("fB")))
        assertEquals("fB", partition.stickyFooter?.id)
        assertEquals(listOf("fA", "t1"), partition.scrolledChildren.map { it.id })
    }

    @Test
    fun `partitionRootChildren pins nothing when there is no direct-child stickyFooter`() {
        // A NESTED footer is not a direct child: it stays where it is and
        // reaches the ordinary dispatch, rendering in-flow.
        val nested = BuilderNode.Stack(id = "s", axis = Axis.V, children = listOf(footer("f1")))
        val partition = partitionRootChildren(root(text("t1"), nested))
        assertNull(partition.stickyFooter)
        assertEquals(listOf("t1", "s"), partition.scrolledChildren.map { it.id })
    }

    @Test
    fun `partitionRootChildren keeps the scrolled children in their authored order`() {
        val partition = partitionRootChildren(root(text("a"), footer("f"), text("b"), text("c")))
        assertEquals(listOf("a", "b", "c"), partition.scrolledChildren.map { it.id })
    }

    // ---- footer clearance (pure) -------------------------------------------

    /** No footer -> ZERO clearance. A band of dead space at the bottom of
     *  every footerless paywall is exactly the bug the iOS sibling's
     *  dropped outer padding left behind. */
    @Test
    fun `stickyFooterClearancePx is zero without a pinned footer`() {
        assertEquals(
            0,
            stickyFooterClearancePx(
                hasPinnedFooter = false,
                footerIsGone = false,
                measuredFooterHeightPx = 140,
                placeholderPx = 96,
            ),
        )
    }

    /** A footer collapsed to GONE is not on screen, so it reserves nothing
     *  — NOT the pre-measurement placeholder, which its permanent zero
     *  height would otherwise select forever. */
    @Test
    fun `stickyFooterClearancePx is zero for a footer collapsed to GONE`() {
        assertEquals(
            0,
            stickyFooterClearancePx(
                hasPinnedFooter = true,
                footerIsGone = true,
                measuredFooterHeightPx = 0,
                placeholderPx = 96,
            ),
        )
    }

    @Test
    fun `stickyFooterClearancePx uses the placeholder only until the footer is measured`() {
        assertEquals(
            96,
            stickyFooterClearancePx(
                hasPinnedFooter = true,
                footerIsGone = false,
                measuredFooterHeightPx = 0,
                placeholderPx = 96,
            ),
        )
        // A footer with a CTA plus fine print is routinely taller than one
        // with a CTA alone: the measured height always wins over the guess.
        assertEquals(
            212,
            stickyFooterClearancePx(
                hasPinnedFooter = true,
                footerIsGone = false,
                measuredFooterHeightPx = 212,
                placeholderPx = 96,
            ),
        )
    }
}
