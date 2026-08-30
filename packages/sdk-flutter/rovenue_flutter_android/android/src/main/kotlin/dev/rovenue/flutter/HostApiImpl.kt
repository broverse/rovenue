// HostApiImpl.kt — `RovenueHostApi` implementation. Thin adapter from the
// Pigeon-generated `Result<T>` callback surface to the Kotlin façade
// (`Rovenue.shared`, `packages/sdk-kotlin`).
//
// Mirrors `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`
// method by method — the differences are Pigeon `Rv*` DTOs instead of Expo's
// `Map<String, Any?>` dicts, `FlutterError` instead of Expo `CodedException`s,
// and `Result<T>` callbacks instead of Expo's `AsyncFunction` coroutines.
//
// Every method that can fail funnels its catch block through `fail(_:)`
// (Mapping.kt) so the `FlutterError.code` is always one of the 24 UDL
// `ErrorKind` variant names Task 3's Dart mapper expects — EXCEPT the
// "no foreground Activity" guard in purchase()/restorePurchases(), which is
// a plugin-wiring problem rather than a store-layer failure and therefore
// uses `internalError(...)` (`code == "Internal"`) per task-5-context.md.
//
// "Every method" means EVERY method, including the ones whose Swift twin in
// `HostApiImpl.swift` has no catch. That asymmetry is deliberate: Swift's
// non-`throws` façade signatures are a compiler-enforced guarantee, and
// Kotlin — with no checked exceptions — gives none. `Rovenue.shared` alone
// throws `IllegalStateException` before `configure()`. An unguarded
// `scope.launch { … }` body would send that throw to the scope's uncaught
// handler (there is no `CoroutineExceptionHandler` on it), killing the app,
// AND leave the Dart `Future` hanging forever because pigeon's `callback`
// never fires.

package dev.rovenue.flutter

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Resources
import android.os.Build
import android.util.DisplayMetrics
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.generated.ClaimInstallParams
import java.util.Locale
import java.util.TimeZone
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

class HostApiImpl(
    private val appContext: Context?,
    private val activityProvider: () -> Activity?,
    private val eventBridge: EventBridge,
    private val scope: CoroutineScope,
) : RovenueHostApi {

    /** The version `configure` actually resolved (from an explicit
     *  `appVersion` argument, or auto-read from the host PackageManager), so
     *  `getAppVersion` can report back what was NOT passed explicitly.
     *  Mirrors `RovenueModule.kt`'s `resolvedAppVersion`. */
    private var resolvedAppVersion: String? = null

    // ---------------- Sync ----------------

    override fun configure(
        apiKey: String,
        baseUrl: String?,
        logLevel: RvLogLevel,
        appVersion: String?,
        environment: String?,
    ) {
        val resolved = appVersion ?: readPackageVersionName()
        resolvedAppVersion = resolved
        try {
            Rovenue.configure(
                apiKey = apiKey,
                baseUrl = baseUrl,
                logLevel = mapLogLevel(logLevel),
                appVersion = resolved,
                context = appContext,
                environment = environment,
            )
        } catch (e: Throwable) {
            throw fail(e)
        }
        // Subscribe once configure() has actually produced a shared
        // instance — see EventBridge's doc comment for why this lives here
        // rather than a dedicated lifecycle hook (Pigeon has none).
        eventBridge.start()
    }

    override fun shutdown() {
        try {
            Rovenue.shared.shutdown()
        } catch (e: Throwable) {
            throw fail(e)
        }
    }

    override fun setForeground(foreground: Boolean) {
        try {
            Rovenue.shared.setForeground(foreground)
        } catch (e: Throwable) {
            throw fail(e)
        }
    }

    override fun getVersion(): String = try {
        Rovenue.shared.version
    } catch (e: Throwable) {
        throw fail(e)
    }

    override fun getAppVersion(): String? = resolvedAppVersion

    // ---------------- Identity ----------------

    override fun currentUser(callback: (Result<RvUser>) -> Unit) {
        scope.launch {
            try {
                val u = Rovenue.shared.currentUser()
                callback(Result.success(mapUser(u)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun identify(appUserId: String, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.identify(appUserId)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun logOut(callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.logOut()
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Entitlements ----------------

    override fun entitlement(id: String, callback: (Result<RvEntitlement?>) -> Unit) {
        scope.launch {
            try {
                val e = Rovenue.shared.entitlement(id)
                callback(Result.success(e?.let(::mapEntitlement)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun entitlementsAll(callback: (Result<List<RvEntitlement>>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.entitlementsAll().map(::mapEntitlement)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun refreshEntitlements(callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.refreshEntitlements()
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Virtual Currencies ----------------

    override fun virtualCurrencies(callback: (Result<Map<String, Long>>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.virtualCurrencyBalances()))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun virtualCurrency(code: String, callback: (Result<Long>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.virtualCurrency(code)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun refreshVirtualCurrencies(callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.refreshVirtualCurrencies()
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Purchases / Placements ----------------

    override fun getOfferings(callback: (Result<RvOfferings>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(mapOfferings(Rovenue.shared.getOfferings())))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun getPaywall(placementId: String, locale: String?, callback: (Result<RvPaywall?>) -> Unit) {
        scope.launch {
            try {
                val p = Rovenue.shared.getPaywall(placementId, locale)
                callback(Result.success(p?.let(::mapPaywall)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun setFallbackPlacements(json: String, callback: (Result<Long>) -> Unit) {
        try {
            callback(Result.success(Rovenue.shared.setFallbackPlacements(json).toLong()))
        } catch (e: Throwable) {
            callback(Result.failure(fail(e)))
        }
    }

    override fun purchase(
        productId: String,
        productType: RvProductType,
        promotionalOfferId: String?,
        basePlanId: String?,
        offerId: String?,
        callback: (Result<RvPurchaseResult>) -> Unit,
    ) {
        // promotionalOfferId is iOS-only (ignored here). basePlanId/offerId
        // select a Play subscription offer. Play Billing needs the
        // foreground Activity to launch the flow.
        val activity = activityProvider()
        if (activity == null) {
            callback(Result.failure(internalError("No foreground Activity available for purchase")))
            return
        }
        // The façade re-resolves the real Play product by id, so
        // displayName/price are not needed here.
        val product = StoreProduct(
            id = productId,
            type = productTypeFrom(productType),
            // `StoreProduct.productCategory` has no default in sdk-kotlin's
            // Types.kt; the façade re-resolves the real Play product (and
            // its real category) by id, so this placeholder value is never
            // actually surfaced — mirrors HostApiImpl.swift's equivalent
            // `productCategory: .subscription` placeholder.
            productCategory = dev.rovenue.sdk.ProductCategory.SUBSCRIPTION,
            displayName = "",
        )
        scope.launch {
            try {
                val r = Rovenue.shared.purchase(activity, product, basePlanId, offerId)
                callback(Result.success(mapPurchaseResult(r)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun restorePurchases(callback: (Result<RvPurchaseResult>) -> Unit) {
        val activity = activityProvider()
        if (activity == null) {
            callback(Result.failure(internalError("No foreground Activity available for restore")))
            return
        }
        scope.launch {
            try {
                val r = Rovenue.shared.restorePurchases(activity)
                callback(Result.success(mapPurchaseResult(r)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Remote Config ----------------

    override fun refreshRemoteConfig(callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.refreshRemoteConfig()
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun remoteConfigBool(key: String, fallback: Boolean, callback: (Result<Boolean>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.remoteConfigBool(key, fallback)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun remoteConfigString(key: String, fallback: String, callback: (Result<String>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.remoteConfigString(key, fallback)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun remoteConfigInt(key: String, fallback: Long, callback: (Result<Long>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.remoteConfigInt(key, fallback)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun remoteConfigDouble(key: String, fallback: Double, callback: (Result<Double>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.remoteConfigDouble(key, fallback)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun remoteConfigJson(key: String, callback: (Result<String?>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.remoteConfigJson(key)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun remoteConfigKeys(callback: (Result<List<String>>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.remoteConfigKeys()))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun remoteConfigAllJson(callback: (Result<String>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.remoteConfigAllJson()))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun experiment(key: String, callback: (Result<RvExperimentAssignment?>) -> Unit) {
        scope.launch {
            try {
                val a = Rovenue.shared.experiment(key)
                callback(Result.success(a?.let(::mapExperimentAssignment)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun experimentsAll(callback: (Result<List<RvExperimentAssignment>>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.experimentsAll().map(::mapExperimentAssignment)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Refund Shield ----------------

    override fun getAppAccountToken(callback: (Result<String>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.getAppAccountToken()))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun recordSessionEvent(
        kind: RvSessionEventKind,
        occurredAt: String,
        durationMs: Long?,
        callback: (Result<Unit>) -> Unit,
    ) {
        scope.launch {
            try {
                Rovenue.shared.recordSessionEvent(
                    mapSessionEventKind(kind),
                    occurredAt,
                    durationMs?.toInt()?.toUInt(),
                )
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun flushSessionEvents(callback: (Result<Long>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.flushSessionEvents().toLong()))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Funnel Claim ----------------

    override fun claimFunnelToken(token: String, callback: (Result<RvFunnelClaim>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(mapFunnelClaim(Rovenue.shared.claimFunnelToken(token))))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun claimInstall(params: RvClaimInstallParams, callback: (Result<RvFunnelClaim?>) -> Unit) {
        scope.launch {
            val ctx = collectAndroidContext()
            val p = ClaimInstallParams(
                platform = params.platform ?: "android",
                locale = params.locale ?: ctx.locale,
                timezone = params.timezone ?: ctx.timezone,
                screenDims = params.screenDims ?: ctx.screenDims,
                deviceModel = params.deviceModel ?: ctx.deviceModel,
                installReferrer = params.installReferrer ?: readInstallReferrer(),
            )
            try {
                val r = Rovenue.shared.claimInstall(p)
                callback(Result.success(r?.let(::mapFunnelClaim)))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun claimViaEmail(email: String, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.claimViaEmail(email)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun claimFromClipboard(callback: (Result<RvFunnelClaim?>) -> Unit) {
        // Android's deferred path is the Play Install Referrer (claimInstall);
        // clipboard recovery is iOS-only. No-op for API symmetry — mirrors
        // RovenueModule.kt's `claimFromClipboard`.
        callback(Result.success(null))
    }

    // These two answer on the calling thread rather than via `scope.launch`,
    // but pigeon's generated dispatch (Messages.g.kt) does not wrap async
    // host calls in a try/catch either — so an escaping throw here is the
    // same crash-plus-hung-Future as an unguarded coroutine body.
    override fun installId(callback: (Result<String>) -> Unit) {
        try {
            callback(Result.success(Rovenue.shared.installId()))
        } catch (e: Throwable) {
            callback(Result.failure(fail(e)))
        }
    }

    override fun hasResolvedFunnelClaim(callback: (Result<Boolean>) -> Unit) {
        try {
            callback(Result.success(Rovenue.shared.hasResolvedFunnelClaim()))
        } catch (e: Throwable) {
            callback(Result.failure(fail(e)))
        }
    }

    // ---------------- Generic events ----------------

    override fun track(envelopeJson: String, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.track(envelopeJson)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun enqueuePaywallEvent(envelopeJson: String, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.enqueuePaywallEvent(envelopeJson)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Subscriber Attributes ----------------

    override fun setAttributes(attributes: Map<String, String?>, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.setAttributes(attributes)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun setEmail(email: String?, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.setEmail(email)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun setDisplayName(name: String?, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.setDisplayName(name)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun setPhoneNumber(phone: String?, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.setPhoneNumber(phone)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun setPushToken(token: String?, callback: (Result<Unit>) -> Unit) {
        scope.launch {
            try {
                Rovenue.shared.setPushToken(token)
                callback(Result.success(Unit))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    override fun flushAttributes(callback: (Result<Long>) -> Unit) {
        scope.launch {
            try {
                callback(Result.success(Rovenue.shared.flushAttributes().toLong()))
            } catch (e: Throwable) {
                callback(Result.failure(fail(e)))
            }
        }
    }

    // ---------------- Helpers ----------------

    /**
     * Reads the host app's `versionName` from its installed PackageInfo.
     * Returns null if the context isn't available or the lookup throws —
     * mirrors `RovenueModule.kt`'s `readPackageVersionName`.
     */
    private fun readPackageVersionName(): String? {
        val context = appContext ?: return null
        return try {
            val pm = context.packageManager
            val pkg = context.packageName
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(pkg, 0)
            }
            info.versionName
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } catch (_: Throwable) {
            null
        }
    }

    private data class AndroidInstallContext(
        val locale: String,
        val timezone: String,
        val screenDims: String,
        val deviceModel: String,
    )

    /** Collects the device context the backend's claim-install requires.
     *  Mirrors `RovenueModule.kt`'s `collectAndroidContext`. */
    private fun collectAndroidContext(): AndroidInstallContext {
        val dm: DisplayMetrics = appContext?.resources?.displayMetrics ?: Resources.getSystem().displayMetrics
        return AndroidInstallContext(
            locale = Locale.getDefault().toLanguageTag(),
            timezone = TimeZone.getDefault().id,
            screenDims = "${dm.widthPixels}x${dm.heightPixels}",
            deviceModel = Build.MODEL ?: "",
        )
    }

    /** Reads the raw Google Play Install Referrer once, with a 3s connection
     *  timeout. Returns null when unavailable. Mirrors `RovenueModule.kt`'s
     *  `readInstallReferrer`. */
    private suspend fun readInstallReferrer(): String? {
        val ctx = appContext ?: return null
        return withTimeoutOrNull(3_000L) {
            val client = InstallReferrerClient.newBuilder(ctx).build()
            try {
                suspendCancellableCoroutine<String?> { cont ->
                    client.startConnection(object : InstallReferrerStateListener {
                        override fun onInstallReferrerSetupFinished(responseCode: Int) {
                            val result = try {
                                if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                                    client.installReferrer.installReferrer
                                } else {
                                    null
                                }
                            } catch (_: Throwable) {
                                null
                            }
                            if (cont.isActive) cont.resume(result)
                        }

                        override fun onInstallReferrerServiceDisconnected() {
                            if (cont.isActive) cont.resume(null)
                        }
                    })
                }
            } catch (_: Throwable) {
                null
            } finally {
                try {
                    client.endConnection()
                } catch (_: Throwable) {
                    // best-effort
                }
            }
        }
    }
}
