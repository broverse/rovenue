package dev.rovenue.sdk.paywallui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

/**
 * Covers the P9 "preview must never charge" fix: [PaywallViewOptions]'s
 * `previewMode` default, and that [RovenuePaywallPreviewView] always wraps
 * the rendered paywall with `previewMode = true` via
 * [buildPreviewWrappedOptions] — mirrors the Swift sibling's
 * `PreviewModeTests.swift`.
 */
class RovenuePaywallPreviewViewTest {

    @Test
    fun `PaywallViewOptions defaults previewMode to false`() {
        assertEquals(false, PaywallViewOptions().previewMode)
    }

    @Test
    fun `buildPreviewWrappedOptions always sets previewMode true`() {
        val hostOptions = PaywallViewOptions(locale = "en", onClose = {}, onUrl = {})
        val wrapped = buildPreviewWrappedOptions(hostOptions)
        assertEquals(true, wrapped.previewMode)
    }

    @Test
    fun `buildPreviewWrappedOptions passes locale darkMode onClose onUrl straight through`() {
        val onClose: () -> Unit = {}
        val onUrl: (String) -> Unit = {}
        val hostOptions = PaywallViewOptions(locale = "tr", darkMode = true, onClose = onClose, onUrl = onUrl)
        val wrapped = buildPreviewWrappedOptions(hostOptions)
        assertEquals("tr", wrapped.locale)
        assertEquals(true, wrapped.darkMode)
        assertSame(onClose, wrapped.onClose)
        assertSame(onUrl, wrapped.onUrl)
    }

    @Test
    fun `buildPreviewWrappedOptions neutralizes purchase and restore regardless of host callbacks`() {
        val hostOptions = PaywallViewOptions(
            onPurchaseCompleted = { throw AssertionError("host onPurchaseCompleted must never be reachable via the wrapped view") },
            onPurchaseFailed = { throw AssertionError("host onPurchaseFailed must never be reachable via the wrapped view") },
            onRestore = { throw AssertionError("host onRestore must never be reachable via the wrapped view") },
        )
        val wrapped = buildPreviewWrappedOptions(hostOptions)

        // The wrapped callbacks are safe no-ops: calling them must not throw
        // (proving they are NOT the host's callbacks, which do throw).
        val result = dev.rovenue.sdk.PurchaseResult(
            entitlements = emptyList(),
            virtualCurrencies = emptyMap(),
            productId = "p",
            storeTransactionId = "t",
        )
        wrapped.onPurchaseCompleted?.invoke(result)
        wrapped.onPurchaseFailed?.invoke(RuntimeException("test"))
        wrapped.onRestore?.invoke()
    }
}
