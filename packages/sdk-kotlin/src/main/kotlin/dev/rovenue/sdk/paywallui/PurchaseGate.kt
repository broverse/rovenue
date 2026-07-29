package dev.rovenue.sdk.paywallui

/**
 * Pure decision helper for [RovenuePaywallView]'s purchase trigger — no
 * Android framework, no I/O, fully unit-testable in isolation from the
 * view. Preview must never charge: `startPurchase()` consults this FIRST,
 * before touching any purchasing state (`isPurchasing`/`selectedPackageId`),
 * so an on-device draft preview ([RovenuePaywallPreviewView]) never reaches
 * `Rovenue.shared.purchase` at all — not even transiently. Mirrors the
 * Swift sibling (`PurchaseGate.swift`) exactly.
 */

/**
 * Whether [RovenuePaywallView]'s `startPurchase()` may proceed to the real
 * Play Billing purchase.
 *
 * @param previewMode `true` for an on-device draft preview
 *   ([RovenuePaywallPreviewView]), which carries no real purchase intent —
 *   there is nothing to buy against an unpublished draft.
 * @return `false` when [previewMode] is `true`. The caller does nothing
 *   further on `false` — no billing call, and no fabricated success/failure
 *   callback either; invoking `onPurchaseFailed` would be dishonest (it
 *   would claim a purchase attempt happened when none did), so the gate
 *   itself carries no side effect and the caller must not invent one.
 */
fun purchaseGate(previewMode: Boolean): Boolean = !previewMode
