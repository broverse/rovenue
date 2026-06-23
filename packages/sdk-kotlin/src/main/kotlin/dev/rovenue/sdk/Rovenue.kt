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
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.ProcessLifecycleOwner
import dev.rovenue.sdk.generated.ClaimInstallParams
import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.CoreOfferings
import dev.rovenue.sdk.generated.ExperimentAssignment
import dev.rovenue.sdk.generated.FunnelClaimResult
import dev.rovenue.sdk.generated.ErrorKind
import dev.rovenue.sdk.generated.LogLevel
import dev.rovenue.sdk.generated.LogRecord
import dev.rovenue.sdk.generated.LogSink
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueErrorFfi
import dev.rovenue.sdk.generated.SessionEventKind
import dev.rovenue.sdk.generated.sdkVersion
import dev.rovenue.sdk.internal.Dispatcher
import dev.rovenue.sdk.internal.ForegroundReconcileObserver
import dev.rovenue.sdk.internal.ForegroundReconcileTrigger
import dev.rovenue.sdk.internal.FunnelClaimBridge
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
import kotlinx.coroutines.flow.SharedFlow
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
    val level: String,                    // "off" | "error" | "warn" | "info" | "debug" | "trace"
    val message: String,
    val data: Map<String, String>? = null,
)

/**
 * Bridges the Rust core's [LogSink] callback into Rovenue's [setLogHandler]
 * machinery. Registered once per [Rovenue.configure] call so all core-
 * authoritative logs flow through the same handler pipeline.
 *
 * The [when] is exhaustive over all six [LogLevel] variants with no `else`
 * branch so a future variant addition causes a compile error here.
 */
internal class LogSinkBridge : LogSink {
    override fun onLog(record: LogRecord) {
        val level = when (record.level) {
            LogLevel.OFF -> return
            LogLevel.ERROR -> "error"
            LogLevel.WARN -> "warn"
            LogLevel.INFO -> "info"
            LogLevel.DEBUG -> "debug"
            LogLevel.TRACE -> "trace"
        }
        Rovenue.emit(LogEntry(level, record.message, record.fields.ifEmpty { null }))
    }
}

class Rovenue private constructor(
    internal val core: RovenueCore,
    internal val bridge: ObserverBridge,
    internal val funnelBridge: FunnelClaimBridge,
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

    // Coalesces foreground-triggered reconciliations (post-configure + every
    // app foreground) so overlapping triggers run at most one reconcile.
    private val reconcileTrigger = ForegroundReconcileTrigger()

    // Lifecycle observer driving foreground reconciliation; held so it can be
    // removed on shutdown. Registered/removed on the main thread.
    private var foregroundObserver: ForegroundReconcileObserver? = null

    companion object {
        // Guarded by `lock`. Configure-twice replaces the instance
        // (RevenueCat / Adapty pattern). Accessing `shared` before
        // configure() throws IllegalStateException — silent fallback
        // would mask developer mistakes.

        // Single shared main-thread handler so lifecycle add/remove posts across
        // configure/reconfigure share one FIFO queue regardless of caller thread.
        private val mainHandler = Handler(Looper.getMainLooper())

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
            baseUrl: String? = null,
            logLevel: LogLevel = LogLevel.WARN,
            appVersion: String? = null,
            context: Context? = null,
            environment: String? = null,
        ) {
            if (apiKey.isBlank()) {
                throw RovenueException(kind = ErrorKind.INVALID_API_KEY, message = "apiKey is blank")
            }
            // Omit baseUrl → the generated Config default ("https://api.rovenue.io")
            // applies; the Rust core validates it on construction.
            val config = Config(
                apiKey = apiKey,
                logLevel = logLevel,
                appVersion = appVersion,
                platform = "android",
                environment = environment,
            ).let { if (baseUrl != null) it.copy(baseUrl = baseUrl) else it }
            val core = try {
                RovenueCore(config)
            } catch (e: RovenueErrorFfi.Generic) {
                throw RovenueException.from(e)
            }
            val bridge = ObserverBridge()
            core.registerObserver(bridge)
            val funnelBridge = FunnelClaimBridge()
            core.registerFunnelClaimListener(funnelBridge)
            core.registerLogSink(LogSinkBridge())
            val instance = Rovenue(
                core,
                bridge,
                funnelBridge,
                Dispatcher(),
                appVersion,
                context?.applicationContext,
            )
            synchronized(lock) {
                _shared?.shutdownInternal()
                _shared = instance
            }

            // Best-effort startup reconcile + continuous foreground reconcile.
            // When the app is already foregrounded, addObserver also fires an
            // immediate onStart reconcile; the in-flight guard collapses the two
            // while they overlap. A rare extra reconcile is harmless (server-side
            // idempotent), so we don't synchronize them further.
            instance.startForegroundReconcile()
            instance.reconcileTrigger.fire(instance.scope) { instance.reconcilePurchases() }
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

    // Registers the ProcessLifecycleOwner observer on the main thread (the
    // lifecycle APIs are main-thread only). Each app foreground fires a
    // coalesced reconcile on the background scope.
    private fun startForegroundReconcile() {
        val observer = ForegroundReconcileObserver {
            reconcileTrigger.fire(scope) { reconcilePurchases() }
        }
        foregroundObserver = observer
        mainHandler.post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(observer)
        }
    }

    private fun stopForegroundReconcile() {
        val observer = foregroundObserver ?: return
        foregroundObserver = null
        mainHandler.post {
            ProcessLifecycleOwner.get().lifecycle.removeObserver(observer)
        }
    }

    private fun shutdownInternal() {
        stopForegroundReconcile()
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
    suspend fun identify(appUserId: String) {
        try {
            dispatcher.run { core.identify(appUserId) }
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    /** Reset the SDK to an anonymous user, discarding the current app-user-id
     *  association. Client-local only — does not contact the server. */
    @Throws(RovenueException::class)
    suspend fun logOut() {
        try {
            dispatcher.run { core.logOut() }
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    // ---------------------------------------------------------------
    // Subscriber attributes
    // ---------------------------------------------------------------

    /** Set arbitrary subscriber attributes. Buffered locally and flushed by
     *  the Rust core. Reserved keys (prefixed with `$`) map to first-class
     *  fields server-side; pass a null value to clear an attribute. */
    @Throws(RovenueException::class)
    suspend fun setAttributes(attributes: Map<String, String?>) {
        try {
            dispatcher.run { core.setAttributes(attributes) }
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    @Throws(RovenueException::class)
    suspend fun setEmail(email: String?) = setAttributes(mapOf("\$email" to email))
    @Throws(RovenueException::class)
    suspend fun setDisplayName(name: String?) = setAttributes(mapOf("\$displayName" to name))
    @Throws(RovenueException::class)
    suspend fun setPhoneNumber(phone: String?) = setAttributes(mapOf("\$phoneNumber" to phone))
    /** Android push token → the $fcmTokens reserved attribute. */
    @Throws(RovenueException::class)
    suspend fun setPushToken(token: String?) = setAttributes(mapOf("\$fcmTokens" to token))

    /** Force an immediate flush of buffered attributes. Returns the number
     *  of attributes drained. */
    @Throws(RovenueException::class)
    suspend fun flushAttributes(): UInt = try {
        dispatcher.run { core.flushAttributes() }
    } catch (e: RovenueErrorFfi.Generic) {
        throw RovenueException.from(e)
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
        try {
            dispatcher.run { core.refreshEntitlements() }
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    // ---------------------------------------------------------------
    // Virtual Currencies
    // ---------------------------------------------------------------

    /** Cached virtual-currency balances (code → amount). Empty if uncached. */
    suspend fun virtualCurrencyBalances(): Map<String, Long> =
        dispatcher.run { core.virtualCurrencyBalances() }

    /** One currency's cached balance, or 0 if absent. */
    suspend fun virtualCurrency(code: String): Long =
        dispatcher.run { core.virtualCurrency(code) }

    /** Force a refresh of virtual-currency balances against the server.
     *  On change, emits ChangeEvent.VIRTUAL_CURRENCIES_CHANGED. */
    @Throws(RovenueException::class)
    suspend fun refreshVirtualCurrencies() {
        try {
            dispatcher.run { core.refreshVirtualCurrencies() }
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    // ---------------------------------------------------------------
    // Remote Config
    // ---------------------------------------------------------------

    /** Force a refresh of the remote config cache against the server.
     *  On success (when values changed), emits
     *  ChangeEvent.REMOTE_CONFIG_CHANGED. */
    @Throws(RovenueException::class)
    suspend fun refreshRemoteConfig() {
        try {
            dispatcher.run { core.refreshRemoteConfig() }
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    /** Read a boolean remote-config value from the local cache, returning
     *  [fallback] when the key is absent. Does not hit the network. */
    suspend fun remoteConfigBool(key: String, fallback: Boolean): Boolean =
        dispatcher.run { core.remoteConfigBool(key, fallback) }

    /** Read a string remote-config value from the local cache, returning
     *  [fallback] when the key is absent. Does not hit the network. */
    suspend fun remoteConfigString(key: String, fallback: String): String =
        dispatcher.run { core.remoteConfigString(key, fallback) }

    /** Read an integer remote-config value from the local cache, returning
     *  [fallback] when the key is absent. Does not hit the network. */
    suspend fun remoteConfigInt(key: String, fallback: Long): Long =
        dispatcher.run { core.remoteConfigInt(key, fallback) }

    /** Read a double remote-config value from the local cache, returning
     *  [fallback] when the key is absent. Does not hit the network. */
    suspend fun remoteConfigDouble(key: String, fallback: Double): Double =
        dispatcher.run { core.remoteConfigDouble(key, fallback) }

    /** Read a raw JSON remote-config value from the local cache. Returns null
     *  if the key is absent. Does not hit the network. */
    suspend fun remoteConfigJson(key: String): String? =
        dispatcher.run { core.remoteConfigJson(key) }

    /** List all cached remote-config keys. Does not hit the network. */
    suspend fun remoteConfigKeys(): List<String> =
        dispatcher.run { core.remoteConfigKeys() }

    /** Return the full remote-config payload serialized as a JSON object.
     *  Does not hit the network. */
    suspend fun remoteConfigAllJson(): String =
        dispatcher.run { core.remoteConfigAllJson() }

    /** Fetch the user's assignment for a single experiment from the local
     *  cache. Returns null if the user is not enrolled. Does not hit the
     *  network. */
    suspend fun experiment(key: String): ExperimentAssignment? =
        dispatcher.run { core.experiment(key) }

    /** List all of the user's experiment assignments from the local cache.
     *  Does not hit the network. */
    suspend fun experimentsAll(): List<ExperimentAssignment> =
        dispatcher.run { core.experimentsAll() }

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
    suspend fun getAppAccountToken(): String = try {
        dispatcher.run { core.getOrCreateAppAccountToken() }
    } catch (e: RovenueErrorFfi.Generic) {
        throw RovenueException.from(e)
    }

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
        try {
            dispatcher.run { core.recordSessionEvent(kind, occurredAt, durationMs) }
        } catch (e: RovenueErrorFfi.Generic) {
            throw RovenueException.from(e)
        }
    }

    /**
     * Force an immediate flush of buffered session events. Returns the
     * number of events drained. Normally callers don't invoke this — the
     * Rust core's 30s poll covers it.
     */
    @Throws(RovenueException::class)
    suspend fun flushSessionEvents(): UInt = try {
        dispatcher.run { core.flushSessionEvents() }
    } catch (e: RovenueErrorFfi.Generic) {
        throw RovenueException.from(e)
    }

    // ---------------------------------------------------------------
    // Custom event tracking
    // ---------------------------------------------------------------

    /**
     * Send a custom event envelope to the Rovenue backend.
     * [envelopeJson] must be a valid JSON string matching the
     * `EventEnvelope` schema (see `EventEnvelope.kt`).
     */
    @Throws(RovenueException::class)
    suspend fun track(envelopeJson: String) {
        try {
            dispatcher.run { core.track(envelopeJson) }
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

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
        try {
            val core: CoreOfferings = dispatcher.run { core.getOfferings() }
            val context = appContext
            val offerings = if (context != null) {
                runCatching { hydrateOfferings(core, PlayBillingStore(context)) }
                    .getOrElse {
                        hydrateOfferings(core, NoPriceStore)
                    }
            } else {
                // Pure-JVM / no-Context: config-only offerings, null prices.
                hydrateOfferings(core, NoPriceStore)
            }
            return offerings
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    /** Purchase the product backing a [Package]. */
    suspend fun purchase(activity: Activity, pkg: Package): PurchaseResult =
        purchase(activity, pkg.product)

    /** Purchase a [StoreProduct] via Play Billing. Launches the billing flow,
     *  validates the purchase token server-side, acknowledges/consumes it,
     *  then returns the refreshed entitlement/credit state. */
    suspend fun purchase(activity: Activity, product: StoreProduct): PurchaseResult {
        val context = appContext
            ?: throw RovenueException(kind = ErrorKind.STORE_PROBLEM, message = "Rovenue.configure(...) must be called with a Context before purchasing")
        val token = runCatching { getAppAccountToken() }.getOrNull()
        val flow = PlayPurchaseFlow(
            store = PlayBillingStore(context),
            validate = { receiptToken, pid ->
                dispatcher.run { core.postGoogleReceipt(receiptToken, pid, token, null) }
            },
        )
        try {
            return flow.run(activity, product.id, product.type, token)
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
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
        val context = appContext
            ?: throw RovenueException(kind = ErrorKind.STORE_PROBLEM, message = "Rovenue.configure(...) must be called with a Context before reconciling")
        val token = runCatching { getAppAccountToken() }.getOrNull()
        val reconciler = PurchaseReconciler(
            store = PlayBillingStore(context),
            validate = { receiptToken, pid ->
                dispatcher.run { core.postGoogleReceipt(receiptToken, pid, token, null) }
            },
        )
        try {
            reconciler.reconcile()
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }

    /** Restore the user's prior purchases. v1: refreshes entitlements from the
     *  server (Play Billing's queryPurchases-driven restore lands in a later
     *  revision) and returns the resulting entitlement/credit state. */
    @Throws(RovenueException::class)
    suspend fun restorePurchases(activity: Activity): PurchaseResult {
        refreshEntitlements()
        return PurchaseResult(
            entitlements = entitlementsAll(),
            virtualCurrencies = virtualCurrencyBalances(),
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
        core.setForeground(foreground)
    }

    /** Stop background work cleanly. Called automatically on
     *  resetForTesting() and on configure-twice. */
    fun shutdown() {
        core.shutdown()
    }

    // ---------------------------------------------------------------
    // Funnel Claim API
    // ---------------------------------------------------------------

    /** Returns the per-install stable identifier generated by the Rust core.
     *  Does not hit the network. */
    fun installId(): String = core.installId()

    fun hasResolvedFunnelClaim(): Boolean = core.hasResolvedFunnelClaim()

    /**
     * Claim a funnel token (deep-link / QR code / referral code) and
     * resolve it to a subscriber + funnel-answer payload server-side.
     *
     * @throws RovenueException on network failure or invalid token.
     */
    @Throws(RovenueException::class)
    suspend fun claimFunnelToken(token: String): FunnelClaimResult = try {
        dispatcher.run { core.claimFunnelToken(token) }
    } catch (e: RovenueErrorFfi.Generic) {
        throw RovenueException.from(e)
    }

    /**
     * Claim via install attribution — passes install-time context to the
     * server and resolves to a subscriber + funnel-answer payload.
     *
     * Returns null when the server finds no matching funnel for this install.
     *
     * @throws RovenueException on network failure.
     */
    @Throws(RovenueException::class)
    suspend fun claimInstall(params: ClaimInstallParams): FunnelClaimResult? = try {
        dispatcher.run { core.claimInstall(params) }
    } catch (e: RovenueErrorFfi.Generic) {
        throw RovenueException.from(e)
    }

    /**
     * Claim via email — associates the current subscriber with the supplied
     * email address for funnel resolution.
     *
     * @throws RovenueException on network failure.
     */
    @Throws(RovenueException::class)
    suspend fun claimViaEmail(email: String) {
        try {
            dispatcher.run { core.claimViaEmail(email) }
        } catch (e: RovenueErrorFfi.Generic) {
            throw RovenueException.from(e)
        }
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

    /** SharedFlow of resolved funnel-claim events. Collectors receive every
     *  claim resolved by the Rust core (token / install / email paths).
     *  Buffer is 16 with DROP_OLDEST policy. */
    val funnelClaims: SharedFlow<FunnelClaimResult>
        get() = funnelBridge.flow
}
