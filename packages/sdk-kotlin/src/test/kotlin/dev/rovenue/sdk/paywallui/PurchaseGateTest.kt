package dev.rovenue.sdk.paywallui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * Pure decision helper for [RovenuePaywallView]'s purchase trigger — no
 * Android framework, no I/O, mirrors the Swift `PurchaseGateTests`
 * (`PreviewModeTests.swift`) exactly. Preview must never charge:
 * `previewMode = true` blocks the real Play Billing purchase.
 */
class PurchaseGateTest {

    @Test
    fun `previewMode false allows purchase`() {
        assertEquals(true, purchaseGate(previewMode = false))
    }

    @Test
    fun `previewMode true blocks purchase`() {
        assertEquals(false, purchaseGate(previewMode = true))
    }
}
