// Rovenue.kt — public singleton façade over the Rust core (UniFFI-generated
// RovenueCore). Lifecycle, identity, entitlements, credits, receipts,
// and the observer flow all live here.
//
// Threading: every suspend method that touches RovenueCore flows through
// the internal Dispatcher (Dispatchers.IO). The Rust core is itself
// thread-safe (Arc<Mutex<...>>); we don't add a Kotlin-side mutex.

package dev.rovenue.sdk

import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.sdkVersion
import dev.rovenue.sdk.internal.Dispatcher
import dev.rovenue.sdk.internal.ObserverBridge

class Rovenue private constructor(
    internal val core: RovenueCore,
    internal val bridge: ObserverBridge,
    internal val dispatcher: Dispatcher,
) {
    companion object {
        // Guarded by `lock`. Configure-twice replaces the instance
        // (RevenueCat / Adapty pattern). Accessing `shared` before
        // configure() throws IllegalStateException — silent fallback
        // would mask developer mistakes.

        private val lock = Any()

        @Volatile
        private var _shared: Rovenue? = null

        @Throws(RovenueException::class)
        fun configure(apiKey: String, baseUrl: String, debug: Boolean = false) {
            if (apiKey.isBlank()) {
                throw RovenueException.InvalidApiKey("apiKey is blank")
            }
            val config = Config(apiKey = apiKey, baseUrl = baseUrl, debug = debug)
            val core = RovenueCore(config)  // may throw RovenueException
            val bridge = ObserverBridge()
            core.registerObserver(bridge)
            val instance = Rovenue(core, bridge, Dispatcher())
            synchronized(lock) {
                _shared?.shutdownInternal()
                _shared = instance
            }
        }

        val shared: Rovenue
            get() = _shared
                ?: error("Rovenue: must call Rovenue.configure(apiKey, baseUrl) before accessing shared")

        // Test-only: tears down the prior instance and clears the slot.
        // Internal so the test source set sees it (same module).
        internal fun resetForTesting() {
            synchronized(lock) {
                _shared?.shutdownInternal()
                _shared = null
            }
        }
    }

    // ---------------------------------------------------------------
    // Sync accessors
    // ---------------------------------------------------------------

    val version: String
        get() = sdkVersion()

    // ---------------------------------------------------------------
    // Internal teardown (used by configure-twice and resetForTesting)
    // ---------------------------------------------------------------

    private fun shutdownInternal() {
        core.shutdown()
    }

    // ---------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------

    /** Returns the SDK's current user (anonymous ID + optional known ID).
     *  Cache read — never hits the network. */
    suspend fun currentUser(): dev.rovenue.sdk.generated.User =
        dispatcher.run { core.currentUser() }

    /** Associate the SDK's user with the customer's app-side user id.
     *  Client-local only — server-side merging happens via the customer's
     *  backend calling /v1/subscribers/transfer with the secret key. */
    @Throws(RovenueException::class)
    suspend fun identify(knownUserId: String) {
        dispatcher.run { core.identify(knownUserId) }
    }
}
