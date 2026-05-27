// HybridRovenueNitroSpec.kt — Nitro HybridObject implementation
// forwarding to the M4 Kotlin `Rovenue` singleton.
//
// Compile target: Android 24+ (JVM 17 baseline running on ART).
// Depends on:
//   - Nitro Modules Android runtime
//   - :sdk-kotlin (M4 façade Gradle module)
//
// M5 SCOPE NOTE
// -------------
// This file is checked in source-only; the actual Android library
// build is performed by the consuming RN app's autolinking step in
// M6. Nitrogen is also wired up in M6 and will normally generate a
// `HybridRovenueNitroSpecSpec` base class from the .nitro.ts spec —
// we hand-write the conformance against the expected shape here.
//
// M4 SURFACE STATUS
// -----------------
// At the time of writing, `packages/sdk-kotlin/src/main/kotlin/dev/
// rovenue/sdk/Rovenue.kt` only exposes `Rovenue.version` (a static
// `val`). The richer surface used below — `Rovenue.configure(...)`,
// `Rovenue.shared.identify(...)`, etc. — is the *expected* M4 façade
// shape that mirrors the M3 Swift `Rovenue` API. M4 is expected to
// grow to match (companion object for static `configure`, `shared`
// instance for the rest) when the Kotlin façade is fleshed out.
// Until then this file will NOT compile against M4; revisiting in M6
// is required (same as the iOS Swift spec).
//
// DTO mapping notes (UniFFI-generated Kotlin types -> RN-bridge DTOs
// as declared in `src/specs/RovenueNitroSpec.nitro.ts`):
//   * Entitlement: UDL fields `is_active`, `product_identifier`,
//                  `expires_iso`, `store` → Kotlin camelCase
//                  `isActive`, `productIdentifier`, `expiresIso`,
//                  `store`. RN ships `{ id, active, expiresAt,
//                  productId }` — `store` is intentionally dropped.
//   * ReceiptResult: UDL exposes `{subscriberId, appUserId,
//                    creditBalance}`. The suspend functions only
//                    return on success and (per spec) guarantee
//                    entitlements + credits caches were refreshed.
//                    We therefore synthesise `{ok: true,
//                    entitlementsRefreshed: true,
//                    creditsRefreshed: true}` when the call returns;
//                    failures propagate as thrown exceptions.
//   * `Rovenue.shared.changes` is the `SharedFlow<ChangeEvent>` from M4.
//   * `ChangeEvent.name` returns the SCREAMING_SNAKE enum constant name,
//     matching the iOS switch's output verbatim
//     (ENTITLEMENTS_CHANGED, IDENTITY_CHANGED, CREDIT_BALANCE_CHANGED).
//   * Kotlin `suspend` functions can throw — adjust if M4 marks any
//     of these non-throwing.

package dev.rovenue.sdkrn

import com.margelo.nitro.HybridObject
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Entitlement
import dev.rovenue.sdk.generated.ReceiptResult
import dev.rovenue.sdk.generated.User
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

class HybridRovenueNitroSpec : HybridObject() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // -------- Lifecycle --------
    fun configure(apiKey: String, baseUrl: String, debug: Boolean) {
        Rovenue.configure(apiKey, baseUrl, debug)
    }

    fun shutdown() {
        Rovenue.shared.shutdown()
    }

    fun setForeground(foreground: Boolean) {
        Rovenue.shared.setForeground(foreground)
    }

    fun getVersion(): String = Rovenue.shared.version

    // -------- Identity --------
    suspend fun currentUser(): Map<String, Any?> {
        val u: User = Rovenue.shared.currentUser()
        return mapOf(
            "anonId" to u.anonId,
            "knownUserId" to u.knownUserId,
        )
    }

    suspend fun identify(knownUserId: String) {
        Rovenue.shared.identify(knownUserId)
    }

    // -------- Entitlements --------
    suspend fun entitlement(id: String): Map<String, Any?>? {
        val e: Entitlement = Rovenue.shared.entitlement(id) ?: return null
        return dtoFromEntitlement(e)
    }

    suspend fun entitlementsAll(): List<Map<String, Any?>> {
        return Rovenue.shared.entitlementsAll().map(::dtoFromEntitlement)
    }

    suspend fun refreshEntitlements() {
        Rovenue.shared.refreshEntitlements()
    }

    // -------- Credits --------
    suspend fun creditBalance(): Double {
        // M4 returns Long (Int64 from UDL `i64`); Nitro JS Number is
        // Double — lossless up to 2^53.
        return Rovenue.shared.creditBalance().toDouble()
    }

    suspend fun refreshCredits() {
        Rovenue.shared.refreshCredits()
    }

    suspend fun consumeCredits(amount: Double, description: String?): Double {
        return Rovenue.shared.consumeCredits(amount.toLong(), description).toDouble()
    }

    // -------- Receipts --------
    suspend fun postAppleReceipt(jws: String, productId: String): Map<String, Any?> {
        // Discard the M4 ReceiptResult — only the success/throw
        // distinction is meaningful at the RN bridge layer.
        Rovenue.shared.postAppleReceipt(jws, productId)
        return mapOf(
            "ok" to true,
            "entitlementsRefreshed" to true,
            "creditsRefreshed" to true,
        )
    }

    suspend fun postGoogleReceipt(receipt: String, productId: String): Map<String, Any?> {
        Rovenue.shared.postGoogleReceipt(receipt, productId)
        return mapOf(
            "ok" to true,
            "entitlementsRefreshed" to true,
            "creditsRefreshed" to true,
        )
    }

    // -------- Observer --------
    fun addChangeListener(cb: (String) -> Unit): () -> Unit {
        val job: Job = scope.launch {
            Rovenue.shared.changes.collect { event ->
                cb(eventName(event))
            }
        }
        return { job.cancel() }
    }

    // -------- Helpers --------
    private fun dtoFromEntitlement(e: Entitlement): Map<String, Any?> {
        return mapOf(
            "id" to e.id,
            "active" to e.isActive,
            "expiresAt" to e.expiresIso,
            "productId" to e.productIdentifier,
        )
    }

    private fun eventName(event: ChangeEvent): String = event.name
}
