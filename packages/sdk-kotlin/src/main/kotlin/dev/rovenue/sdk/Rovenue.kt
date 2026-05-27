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
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * A single log event emitted by the Rovenue façade. Forwarded to any
 * handler registered via [Rovenue.setLogHandler]. The `message` field
 * is a fixed string per emit site (no user-input interpolation); the
 * `data` field is currently always `null` (reserved for future
 * structured payloads, which MUST NOT include PII).
 */
data class LogEntry(
    val level: String,                    // "debug" | "info" | "warn" | "error"
    val message: String,
    val data: Map<String, String>? = null,
)

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
            emit(LogEntry(level = "info", message = "configure"))
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

        // -----------------------------------------------------------
        // Log handlers — static, intentionally NOT cleared on
        // configure-twice or resetForTesting. Consumers install a
        // handler once at app start; reconfiguring should not drop it.
        // -----------------------------------------------------------

        private val logLock = ReentrantLock()
        private val logHandlers: MutableMap<UUID, (LogEntry) -> Unit> = mutableMapOf()

        internal fun emit(entry: LogEntry) {
            val snapshot = logLock.withLock { logHandlers.values.toList() }
            snapshot.forEach { it(entry) }
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

    /**
     * Register a log handler that receives bridge-level events
     * (configure / identify / refresh / receipt / shutdown).
     * Returns an unsubscribe lambda.
     */
    fun setLogHandler(handler: (LogEntry) -> Unit): () -> Unit {
        val id = UUID.randomUUID()
        Rovenue.logLock.withLock { Rovenue.logHandlers[id] = handler }
        return { Rovenue.logLock.withLock { Rovenue.logHandlers.remove(id) } }
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
        emit(LogEntry(level = "info", message = "identify"))
        try {
            dispatcher.run { core.identify(knownUserId) }
            emit(LogEntry(level = "info", message = "identify ok"))
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "identify failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    // ---------------------------------------------------------------
    // Entitlements (cache-first reads; refresh hits HTTP)
    // ---------------------------------------------------------------

    /** Fetch a specific entitlement from the local cache. Returns null if
     *  it doesn't exist locally — does not hit the network. */
    suspend fun entitlement(id: String): dev.rovenue.sdk.generated.Entitlement? =
        dispatcher.run { core.entitlement(id) }

    /** List all cached entitlements. Does not hit the network. */
    suspend fun entitlementsAll(): List<dev.rovenue.sdk.generated.Entitlement> =
        dispatcher.run { core.entitlementsAll() }

    /** Force a refresh of the entitlements cache against the server.
     *  On success, emits ChangeEvent.ENTITLEMENTS_CHANGED to subscribers
     *  of `changes`. */
    @Throws(RovenueException::class)
    suspend fun refreshEntitlements() {
        emit(LogEntry(level = "info", message = "refreshEntitlements"))
        try {
            dispatcher.run { core.refreshEntitlements() }
            emit(LogEntry(level = "info", message = "refreshEntitlements ok"))
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "refreshEntitlements failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    // ---------------------------------------------------------------
    // Credits
    // ---------------------------------------------------------------

    /** Read the cached credit balance. Returns 0 if the cache is empty. */
    suspend fun creditBalance(): Long =
        dispatcher.run { core.creditBalance() }

    /** Force a refresh of the credit balance against the server.
     *  On success (when the balance changed), emits
     *  ChangeEvent.CREDIT_BALANCE_CHANGED. */
    @Throws(RovenueException::class)
    suspend fun refreshCredits() {
        emit(LogEntry(level = "info", message = "refreshCredits"))
        try {
            dispatcher.run { core.refreshCredits() }
            emit(LogEntry(level = "info", message = "refreshCredits ok"))
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "refreshCredits failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    /** Spend credits server-side. The SDK generates an Idempotency-Key
     *  internally — retries of the same call are server-deduped. Returns
     *  the new balance. Throws RovenueException.InsufficientCredits if
     *  the user lacks the balance. */
    @Throws(RovenueException::class)
    suspend fun consumeCredits(amount: Long, description: String? = null): Long {
        emit(LogEntry(level = "info", message = "consumeCredits"))
        try {
            val result = dispatcher.run { core.consumeCredits(amount, description) }
            emit(LogEntry(level = "info", message = "consumeCredits ok"))
            return result
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "consumeCredits failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    // ---------------------------------------------------------------
    // Receipts
    // ---------------------------------------------------------------

    /** Post an Apple StoreKit 2 JWS to the server for validation.
     *  Caller obtains JWS via `Product.purchase()` on iOS (this SDK does
     *  NOT call StoreKit). On success, refreshes entitlements + credits
     *  and returns a ReceiptResult. */
    @Throws(RovenueException::class)
    suspend fun postAppleReceipt(
        jws: String,
        productId: String,
    ): dev.rovenue.sdk.generated.ReceiptResult {
        emit(LogEntry(level = "info", message = "postAppleReceipt"))
        try {
            val result = dispatcher.run { core.postAppleReceipt(jws, productId) }
            emit(LogEntry(level = "info", message = "postAppleReceipt ok"))
            return result
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "postAppleReceipt failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    /** Post a Google Play Billing purchase token to the server for
     *  validation. Caller obtains the token via `Purchase.purchaseToken`
     *  on Android. On success, refreshes entitlements + credits and
     *  returns a ReceiptResult. */
    @Throws(RovenueException::class)
    suspend fun postGoogleReceipt(
        receipt: String,
        productId: String,
    ): dev.rovenue.sdk.generated.ReceiptResult {
        emit(LogEntry(level = "info", message = "postGoogleReceipt"))
        try {
            val result = dispatcher.run { core.postGoogleReceipt(receipt, productId) }
            emit(LogEntry(level = "info", message = "postGoogleReceipt ok"))
            return result
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "postGoogleReceipt failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    // ---------------------------------------------------------------
    // Lifecycle hooks (sync)
    // ---------------------------------------------------------------

    /** Tell the SDK whether the app is in the foreground. While foreground,
     *  the SDK's internal polling scheduler ticks; while background,
     *  polling pauses. Call from your Activity / Application lifecycle. */
    fun setForeground(foreground: Boolean) {
        emit(LogEntry(level = "info", message = "setForeground"))
        core.setForeground(foreground)
    }

    /** Stop background work cleanly. Called automatically on
     *  resetForTesting() and on configure-twice. */
    fun shutdown() {
        emit(LogEntry(level = "info", message = "shutdown"))
        core.shutdown()
    }

    // ---------------------------------------------------------------
    // Observer flow
    // ---------------------------------------------------------------

    /** SharedFlow of cache-change notifications. Every collector receives
     *  every event (multicast). Buffer is 64 with DROP_OLDEST policy —
     *  consumers that don't keep up lose old events silently; the cache
     *  reads remain authoritative.
     *
     *  CAUTION: collect this flow from a coroutine OUTSIDE the SDK's
     *  internal scope; calling Rovenue.shutdown() from inside a coroutine
     *  that is itself collecting `changes` would cancel that collector. */
    val changes: kotlinx.coroutines.flow.SharedFlow<dev.rovenue.sdk.generated.ChangeEvent>
        get() = bridge.flow
}
