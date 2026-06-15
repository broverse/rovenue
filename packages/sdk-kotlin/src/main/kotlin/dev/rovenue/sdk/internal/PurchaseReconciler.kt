// PurchaseReconciler.kt — background reconciliation of unfinished Play Billing
// purchases (parity with the Swift SDK's always-on Transaction.updates listener).
//
// A purchase can be left unacknowledged when the app dies mid-flow, or when a
// purchase happens out-of-band (promo redemption, another device). For each
// such purchase the reconciler validates the token server-side and ONLY THEN
// acknowledges/consumes it — never acknowledging an unvalidated purchase, so a
// validation failure leaves the purchase to be retried on the next reconcile
// (and Play auto-refunds anything left unacknowledged past its window).
//
// All store / validation interactions are injected so this logic is
// unit-testable with fakes (no live Play Billing / network).

package dev.rovenue.sdk.internal

class PurchaseReconciler(
    private val store: PlayStore,
    private val validate: suspend (token: String, productId: String) -> Unit,
) {
    suspend fun reconcile() {
        for (p in store.queryUnacknowledgedPurchases()) {
            if (p.isAcknowledged) continue
            runCatching { validate(p.purchaseToken, p.productId) }
                // Acknowledge ONLY after validation succeeds. On failure we
                // leave the purchase unacknowledged; the next reconcile retries.
                .onSuccess { p.acknowledge() }
        }
    }
}
