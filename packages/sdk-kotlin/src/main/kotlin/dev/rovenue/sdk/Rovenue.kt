// Rovenue.kt — public singleton façade over the Rust core (UniFFI-generated
// RovenueCore). Lifecycle, identity, entitlements, credits, receipts,
// and the observer flow all live here.
//
// Threading: every suspend method that touches RovenueCore flows through
// the internal Dispatcher (Dispatchers.IO). The Rust core is itself
// thread-safe (Arc<Mutex<...>>); we don't add a Kotlin-side mutex.

package dev.rovenue.sdk

import android.app.Activity
import android.content.Context
import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.CoreOfferings
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.SessionEventKind
import dev.rovenue.sdk.generated.sdkVersion
import dev.rovenue.sdk.internal.Dispatcher
import dev.rovenue.sdk.internal.NoPriceStore
import dev.rovenue.sdk.internal.ObserverBridge
import dev.rovenue.sdk.internal.PlayBillingStore
import dev.rovenue.sdk.internal.PlayPurchaseFlow
import dev.rovenue.sdk.internal.PurchaseReconciler
import dev.rovenue.sdk.internal.hydrateOfferings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
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
    private val appVersion: String?,
    private val appContext: Context?,
) {
    /**
     * Test-only accessor that exposes the appVersion captured at
     * configure() time. Used by `AppVersionTest` to verify the wiring
     * without scraping the actual session-event request body.
     */
    internal val resolvedAppVersionForTesting: String? get() = appVersion

    // Background scope for best-effort work that must not block the caller
    // (e.g. the post-configure purchase reconciliation). SupervisorJob so one
    // failed child never tears the scope down; cancelled on shutdown.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        // Guarded by `lock`. Configure-twice replaces the instance
        // (RevenueCat / Adapty pattern). Accessing `shared` before
        // configure() throws IllegalStateException — silent fallback
        // would mask developer mistakes.

        private val lock = Any()

        @Volatile
        private var _shared: Rovenue? = null

        /**
         * Configure the SDK.
         *
         * @param context An Android [Context]; the application context is
         *   retained and used to drive Play Billing during [purchase]. May be
         *   null only in pure-JVM/unit-test scenarios that never purchase.
         * @param appVersion The host app's user-facing version string. On
         *   Android, callers should pass
         *   `context.packageManager.getPackageInfo(context.packageName, 0).versionName`
         *   (or the API 33+ flags overload). The standalone JVM SDK has no
         *   `Context`, so the value is supplied explicitly; the RN bridge
         *   forwards the PackageManager value automatically.
         */
        @Throws(RovenueException::class)
        fun configure(
            apiKey: String,
            baseUrl: String,
            debug: Boolean = false,
            appVersion: String? = null,
            context: Context? = null,
        ) {
            emit(LogEntry(level = "info", message = "configure"))
            if (apiKey.isBlank()) {
                throw RovenueException.InvalidApiKey("apiKey is blank")
            }
            val config = Config(
                apiKey = apiKey,
                baseUrl = baseUrl,
                debug = debug,
                appVersion = appVersion,
            )
            val core = RovenueCore(config)  // may throw RovenueException
            val bridge = ObserverBridge()
            core.registerObserver(bridge)
            val instance = Rovenue(
                core,
                bridge,
                Dispatcher(),
                appVersion,
                context?.applicationContext,
            )
            synchronized(lock) {
                _shared?.shutdownInternal()
                _shared = instance
            }

            // Best-effort: reconcile any unfinished purchases in the background.
            // Must NOT block configure() and must never surface errors — a
            // device with no Play Billing / offline simply skips reconciliation.
            instance.scope.launch {
                runCatching { instance.reconcilePurchases() }
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
        scope.cancel()
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
    // Refund Shield — stable per-subscriber token
    // ---------------------------------------------------------------

    /**
     * Returns a stable UUID for the current user. The host app passes this
     * to `BillingFlowParams.Builder.setObfuscatedAccountId(token)` so Google
     * can use it for fraud-detection signals and so the backend can attribute
     * refund-related signals back to a known subscriber.
     *
     * The token is generated once per (project, current_user_scope) pair
     * and persisted locally. Stable across app launches. Calling [identify]
     * first changes the scope, so the next [getAppAccountToken] returns a
     * different UUID for the now-known user.
     */
    @Throws(RovenueException::class)
    suspend fun getAppAccountToken(): String =
        dispatcher.run { core.getOrCreateAppAccountToken() }

    // ---------------------------------------------------------------
    // Refund Shield — session telemetry
    // ---------------------------------------------------------------

    /**
     * Record a single SDK session-lifecycle event (open / background / close).
     * Buffered locally and flushed in batches of up to 200 every ~30s by the
     * Rust core's `SessionDispatcher`. Best-effort: dropped on network error.
     */
    @Throws(RovenueException::class)
    suspend fun recordSessionEvent(
        kind: SessionEventKind,
        occurredAt: String,
        durationMs: UInt? = null,
    ) {
        dispatcher.run { core.recordSessionEvent(kind, occurredAt, durationMs) }
    }

    /**
     * Force an immediate flush of buffered session events. Returns the
     * number of events drained. Normally callers don't invoke this — the
     * Rust core's 30s poll covers it.
     */
    @Throws(RovenueException::class)
    suspend fun flushSessionEvents(): UInt =
        dispatcher.run { core.flushSessionEvents() }

    // ---------------------------------------------------------------
    // Offerings & purchasing
    // ---------------------------------------------------------------

    /** Fetch the project's offerings. The list (and which one is `current`)
     *  comes from the Rovenue backend; localized price metadata is hydrated
     *  live from Play Billing's ProductDetails (parity with the Swift SDK).
     *
     *  Resilient: if the price query fails (no Play Billing, offline, no
     *  Context), the offerings are still returned with null price fields —
     *  getOfferings never fails just because pricing was unavailable. */
    @Throws(RovenueException::class)
    suspend fun getOfferings(): Offerings {
        emit(LogEntry(level = "info", message = "getOfferings"))
        try {
            val core: CoreOfferings = dispatcher.run { core.getOfferings() }
            val context = appContext
            val offerings = if (context != null) {
                runCatching { hydrateOfferings(core, PlayBillingStore(context)) }
                    .getOrElse {
                        emit(LogEntry(level = "warn", message = "getOfferings price hydration failed: ${it.message ?: it.javaClass.simpleName}"))
                        hydrateOfferings(core, NoPriceStore)
                    }
            } else {
                // Pure-JVM / no-Context: config-only offerings, null prices.
                hydrateOfferings(core, NoPriceStore)
            }
            emit(LogEntry(level = "info", message = "getOfferings ok"))
            return offerings
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "getOfferings failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    /** Purchase the product backing a [Package]. */
    suspend fun purchase(activity: Activity, pkg: Package): PurchaseResult =
        purchase(activity, pkg.product)

    /** Purchase a [StoreProduct] via Play Billing. Launches the billing flow,
     *  validates the purchase token server-side, acknowledges/consumes it,
     *  then returns the refreshed entitlement/credit state. */
    suspend fun purchase(activity: Activity, product: StoreProduct): PurchaseResult {
        emit(LogEntry(level = "info", message = "purchase"))
        val context = appContext
            ?: throw StoreProblemException("Rovenue.configure(...) must be called with a Context before purchasing")
        val token = runCatching { getAppAccountToken() }.getOrNull()
        val flow = PlayPurchaseFlow(
            store = PlayBillingStore(context),
            validate = { receiptToken, pid ->
                dispatcher.run { core.postGoogleReceipt(receiptToken, pid, token, null) }
            },
            snapshot = { entitlementsAll() to creditBalance() },
        )
        try {
            val result = flow.run(activity, product.id, product.type, token)
            emit(LogEntry(level = "info", message = "purchase ok"))
            return result
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "purchase failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    /** Reconcile unfinished Play Billing purchases (parity with the Swift SDK's
     *  always-on Transaction.updates listener).
     *
     *  Queries Play Billing for purchases the user owns that are not yet
     *  acknowledged/consumed — e.g. the app died mid-flow, a promo was redeemed,
     *  or a purchase happened on another device — then for each one validates
     *  the token server-side and, only on success, acknowledges/consumes it. A
     *  validation failure leaves the purchase untouched to be retried on the
     *  next reconcile (Play auto-refunds anything left unacknowledged).
     *
     *  Best-effort: also invoked automatically (off-thread, errors swallowed)
     *  after [configure]. Safe to call manually, e.g. on app foreground. */
    suspend fun reconcilePurchases() {
        emit(LogEntry(level = "info", message = "reconcilePurchases"))
        val context = appContext
            ?: throw StoreProblemException("Rovenue.configure(...) must be called with a Context before reconciling")
        val token = runCatching { getAppAccountToken() }.getOrNull()
        val reconciler = PurchaseReconciler(
            store = PlayBillingStore(context),
            validate = { receiptToken, pid ->
                dispatcher.run { core.postGoogleReceipt(receiptToken, pid, token, null) }
            },
        )
        try {
            reconciler.reconcile()
            emit(LogEntry(level = "info", message = "reconcilePurchases ok"))
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "reconcilePurchases failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }

    /** Restore the user's prior purchases. v1: refreshes entitlements from the
     *  server (Play Billing's queryPurchases-driven restore lands in a later
     *  revision) and returns the resulting entitlement/credit state. */
    @Throws(RovenueException::class)
    suspend fun restorePurchases(activity: Activity): PurchaseResult {
        emit(LogEntry(level = "info", message = "restorePurchases"))
        refreshEntitlements()
        return PurchaseResult(
            entitlements = entitlementsAll(),
            creditBalance = creditBalance(),
            productId = "",
            storeTransactionId = "",
        )
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
