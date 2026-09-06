// HomeViewModel.kt — drives the demonstrated SDK flow for HomeScreen.
//
// Every SDK call is wrapped in try/catch and its outcome (success or
// failure) is appended to `log`, so the app is useful to poke at even
// without a live backend — the same "always show something on screen"
// contract the Flutter, React Native, and iOS examples follow.
package dev.rovenue.example.android

import android.app.Activity
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.rovenue.sdk.Offerings
import dev.rovenue.sdk.Paywall
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Entitlement
import dev.rovenue.sdk.generated.LogLevel
import dev.rovenue.sdk.generated.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class HomeViewModel(application: Application) : AndroidViewModel(application) {

    private val _configuring = MutableStateFlow(true)
    val configuring: StateFlow<Boolean> = _configuring.asStateFlow()

    private val _currentUser = MutableStateFlow<User?>(null)
    val currentUser: StateFlow<User?> = _currentUser.asStateFlow()

    private val _offerings = MutableStateFlow<Offerings?>(null)
    val offerings: StateFlow<Offerings?> = _offerings.asStateFlow()

    private val _entitlements = MutableStateFlow<List<Entitlement>>(emptyList())
    val entitlements: StateFlow<List<Entitlement>> = _entitlements.asStateFlow()

    private val _log = MutableStateFlow<List<String>>(emptyList())
    val log: StateFlow<List<String>> = _log.asStateFlow()

    private val _busyLabel = MutableStateFlow<String?>(null)
    val busyLabel: StateFlow<String?> = _busyLabel.asStateFlow()

    var appUserIdInput: String = ""

    /** Products to show purchase buttons for — the `current` offering's
     *  packages when the server designates one, otherwise every package
     *  across every offering (mirrors the Flutter/iOS examples' `products`). */
    val products: List<StoreProduct>
        get() {
            val offerings = _offerings.value ?: return emptyList()
            val current = offerings.current
            return if (current != null) {
                current.packages.map { it.product }
            } else {
                offerings.all.values.flatMap { offering -> offering.packages.map { it.product } }
            }
        }

    private var unsubscribeLog: (() -> Unit)? = null

    override fun onCleared() {
        unsubscribeLog?.invoke()
        super.onCleared()
    }

    fun appendLog(line: String) {
        _log.value = (listOf(line) + _log.value).take(200)
    }

    // ---------------------------------------------------------------
    // configure
    // ---------------------------------------------------------------

    fun bootstrap() {
        viewModelScope.launch {
            try {
                // RovenueCore's constructor does synchronous local I/O
                // (opens the on-disk cache) — run it off the main thread,
                // matching every other SDK call's routing through
                // Dispatchers.IO (see Rovenue.kt's internal Dispatcher).
                withContext(Dispatchers.IO) {
                    Rovenue.configure(
                        apiKey = ExampleConfig.apiKey,
                        baseUrl = ExampleConfig.baseUrl,
                        logLevel = LogLevel.INFO,
                        context = getApplication(),
                    )
                }
                appendLog("configure() succeeded")
            } catch (e: RovenueException) {
                appendLog("configure() failed: RovenueException(${e.kind}): ${e.message}")
                _configuring.value = false
                return@launch
            } catch (e: Throwable) {
                appendLog("configure() failed: $e")
                _configuring.value = false
                return@launch
            }

            // Now that configure() has run, install the real log handler
            // and start observing change events for the app's lifetime.
            unsubscribeLog = Rovenue.shared.setLogHandler { entry ->
                appendLog("[${entry.level}] ${entry.message}")
            }

            // The SDK's own "go re-fetch" signal (ENTITLEMENTS_CHANGED /
            // IDENTITY_CHANGED / ...), collected for the app's lifetime.
            //
            // IMPORTANT — do NOT call refreshEntitlements() from this
            // collector: that method hits the network and, on success,
            // emits ChangeEvent.ENTITLEMENTS_CHANGED again, which would
            // re-enter this very collector and loop forever (the recorded
            // footgun — "refreshX() inside the XCHANGED handler re-emits
            // the event"). entitlementsAll() below is a *local cache read*
            // (see its doc in Rovenue.kt: "Does not hit the network") — it
            // never emits a change event, so calling it here is safe. This
            // mirrors the iOS example's HomeViewModel.bootstrap(), which
            // calls the same-shaped cache-only entitlementsAll() (never
            // refreshEntitlements()) from inside its own `changes` listener.
            viewModelScope.launch {
                Rovenue.shared.changes.collect { event ->
                    appendLog("onChange: $event")
                    refreshEntitlementsFromCache()
                    if (event == ChangeEvent.IDENTITY_CHANGED) {
                        refreshCurrentUser()
                    }
                }
            }

            refreshCurrentUser()
            refreshEntitlementsFromCache()
            loadOfferings()
            _configuring.value = false
        }
    }

    // ---------------------------------------------------------------
    // identify
    // ---------------------------------------------------------------

    fun identify() {
        val appUserId = appUserIdInput.trim()
        if (appUserId.isEmpty()) return
        viewModelScope.launch {
            _busyLabel.value = "identify"
            try {
                Rovenue.shared.identify(appUserId)
                appendLog("identify($appUserId) succeeded")
                refreshCurrentUser()
            } catch (e: RovenueException) {
                appendLog("identify() failed: RovenueException(${e.kind}): ${e.message}")
            } catch (e: Throwable) {
                appendLog("identify() failed: $e")
            } finally {
                _busyLabel.value = null
            }
        }
    }

    fun logOut() {
        viewModelScope.launch {
            _busyLabel.value = "logOut"
            try {
                Rovenue.shared.logOut()
                appendLog("logOut() succeeded")
                refreshCurrentUser()
            } catch (e: RovenueException) {
                appendLog("logOut() failed: RovenueException(${e.kind}): ${e.message}")
            } catch (e: Throwable) {
                appendLog("logOut() failed: $e")
            } finally {
                _busyLabel.value = null
            }
        }
    }

    private suspend fun refreshCurrentUser() {
        _currentUser.value = Rovenue.shared.currentUser()
    }

    // ---------------------------------------------------------------
    // entitlements
    // ---------------------------------------------------------------

    /** Cache-only read — see the long comment in [bootstrap] on why this
     *  (and not [refreshEntitlementsFromNetwork]) is what the change
     *  collector calls. */
    private suspend fun refreshEntitlementsFromCache() {
        _entitlements.value = Rovenue.shared.entitlementsAll()
    }

    /** Explicit, user-initiated network refresh (the "Refresh" button) —
     *  safe to call from a button tap; only the *collector* must avoid it. */
    fun refreshEntitlementsFromNetwork() {
        viewModelScope.launch {
            _busyLabel.value = "refreshEntitlements"
            try {
                Rovenue.shared.refreshEntitlements()
                appendLog("refreshEntitlements() succeeded")
                // The refresh above already triggered ENTITLEMENTS_CHANGED,
                // which the collector installed in bootstrap() will pick up
                // and re-read from cache — no need to duplicate that here.
            } catch (e: RovenueException) {
                appendLog("refreshEntitlements() failed: RovenueException(${e.kind}): ${e.message}")
            } catch (e: Throwable) {
                appendLog("refreshEntitlements() failed: $e")
            } finally {
                _busyLabel.value = null
            }
        }
    }

    // ---------------------------------------------------------------
    // offerings
    // ---------------------------------------------------------------

    fun loadOfferings() {
        viewModelScope.launch {
            _busyLabel.value = "getOfferings"
            try {
                val result = Rovenue.shared.getOfferings()
                _offerings.value = result
                appendLog("getOfferings() succeeded: ${result.all.size} offering(s)")
            } catch (e: RovenueException) {
                appendLog("getOfferings() failed: RovenueException(${e.kind}): ${e.message}")
            } catch (e: Throwable) {
                appendLog("getOfferings() failed: $e")
            } finally {
                _busyLabel.value = null
            }
        }
    }

    // ---------------------------------------------------------------
    // purchase
    // ---------------------------------------------------------------

    fun purchase(activity: Activity, product: StoreProduct) {
        viewModelScope.launch {
            _busyLabel.value = "purchase ${product.id}"
            try {
                val result = Rovenue.shared.purchase(activity, product)
                appendLog("purchase(${product.id}) succeeded: txn ${result.storeTransactionId}")
                _entitlements.value = result.entitlements
            } catch (e: RovenueException) {
                appendLog("purchase(${product.id}) failed: RovenueException(${e.kind}): ${e.message}")
            } catch (e: Throwable) {
                appendLog("purchase(${product.id}) failed: $e")
            } finally {
                _busyLabel.value = null
            }
        }
    }

    // ---------------------------------------------------------------
    // restore
    // ---------------------------------------------------------------

    fun restore(activity: Activity) {
        viewModelScope.launch {
            _busyLabel.value = "restorePurchases"
            try {
                val result = Rovenue.shared.restorePurchases(activity)
                appendLog("restorePurchases() succeeded: ${result.entitlements.size} entitlement(s)")
                _entitlements.value = result.entitlements
            } catch (e: RovenueException) {
                appendLog("restorePurchases() failed: RovenueException(${e.kind}): ${e.message}")
            } catch (e: Throwable) {
                appendLog("restorePurchases() failed: $e")
            } finally {
                _busyLabel.value = null
            }
        }
    }

    // ---------------------------------------------------------------
    // paywall
    // ---------------------------------------------------------------

    suspend fun resolvePaywall(): Paywall? {
        _busyLabel.value = "getPaywall"
        try {
            val paywall = Rovenue.shared.getPaywall(ExampleConfig.placementIdentifier)
            if (paywall == null) {
                appendLog(
                    "getPaywall(${ExampleConfig.placementIdentifier}) resolved to nothing " +
                        "(no assignment for this placement)",
                )
                return null
            }
            appendLog(
                "getPaywall(${ExampleConfig.placementIdentifier}) succeeded: paywall " +
                    (paywall.paywallIdentifier ?: "(remote-config only)"),
            )
            return paywall
        } catch (e: RovenueException) {
            appendLog("getPaywall() failed: RovenueException(${e.kind}): ${e.message}")
            return null
        } catch (e: Throwable) {
            appendLog("getPaywall() failed: $e")
            return null
        } finally {
            _busyLabel.value = null
        }
    }
}
