// RovenueModule.kt — Expo Module bridge forwarding to the M4 Kotlin
// `Rovenue` singleton.
//
// Compile target: Android 24+ (JVM 17). Depends on:
//   - expo-modules-core (provided via Expo autolinking)
//   - dev.rovenue:sdk (provided via Gradle composite build, injected
//     by the config plugin)
//
// JS surface mirrors RovenueModuleSpec in
// packages/sdk-rn/src/specs/RovenueModule.types.ts.

package dev.rovenue.sdkrn

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import dev.rovenue.sdk.LogEntry
import dev.rovenue.sdk.Offerings
import dev.rovenue.sdk.ProductNotAvailableException
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.PurchaseCancelledException
import dev.rovenue.sdk.PurchasePendingException
import dev.rovenue.sdk.PurchaseResult
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.StoreProblemException
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Entitlement
import dev.rovenue.sdk.generated.ExperimentAssignment
import dev.rovenue.sdk.generated.SessionEventKind
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

class RovenueModule : Module() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var changesJob: Job? = null
    private var logUnsub: (() -> Unit)? = null

    override fun definition() = ModuleDefinition {
        Name("Rovenue")

        // ---------------- Sync ----------------
        //
        // appVersion is optional from JS — when null/omitted we read
        // PackageManager.PackageInfo.versionName from the host context.
        // For Expo apps that's the value baked from app.json's
        // `expo.version` at prebuild time (into android/app/build.gradle
        // versionName); for bare RN it's the host project's gradle config.
        Function("configure") { apiKey: String, baseUrl: String?, debug: Boolean, appVersion: String?, environment: String? ->
            val resolved = appVersion ?: readPackageVersionName()
            // The M4 Kotlin façade needs a Context to drive Play Billing.
            Rovenue.configure(
                apiKey = apiKey,
                baseUrl = baseUrl,
                debug = debug,
                appVersion = resolved,
                context = appContext.reactContext?.applicationContext,
                environment = environment,
            )
        }
        Function("shutdown") { Rovenue.shared.shutdown() }
        Function("setForeground") { foreground: Boolean ->
            Rovenue.shared.setForeground(foreground)
        }
        Function("getVersion") { Rovenue.shared.version }

        // ---------------- Async ----------------
        AsyncFunction("currentUser") Coroutine { ->
            val u = Rovenue.shared.currentUser()
            mapOf("rovenueId" to u.rovenueId, "appUserId" to u.appUserId)
        }
        AsyncFunction("identify") Coroutine { appUserId: String ->
            Rovenue.shared.identify(appUserId)
        }
        AsyncFunction("logOut") Coroutine { ->
            Rovenue.shared.logOut()
        }
        AsyncFunction("entitlement") Coroutine { id: String ->
            Rovenue.shared.entitlement(id)?.let(::dtoFromEntitlement)
        }
        AsyncFunction("entitlementsAll") Coroutine { ->
            Rovenue.shared.entitlementsAll().map(::dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") Coroutine { ->
            Rovenue.shared.refreshEntitlements()
        }
        AsyncFunction("creditBalance") Coroutine { ->
            Rovenue.shared.creditBalance().toDouble()
        }
        AsyncFunction("refreshCredits") Coroutine { -> Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") Coroutine { amount: Double, description: String? ->
            Rovenue.shared.consumeCredits(amount.toLong(), description).toDouble()
        }
        // ---------------- Remote Config ----------------
        AsyncFunction("refreshRemoteConfig") Coroutine { -> Rovenue.shared.refreshRemoteConfig() }
        AsyncFunction("remoteConfigBool") Coroutine { key: String, fallback: Boolean ->
            Rovenue.shared.remoteConfigBool(key, fallback)
        }
        AsyncFunction("remoteConfigString") Coroutine { key: String, fallback: String ->
            Rovenue.shared.remoteConfigString(key, fallback)
        }
        AsyncFunction("remoteConfigInt") Coroutine { key: String, fallback: Double ->
            // JS marshals numbers as Double; widen the façade's Long back to Double.
            Rovenue.shared.remoteConfigInt(key, fallback.toLong()).toDouble()
        }
        AsyncFunction("remoteConfigDouble") Coroutine { key: String, fallback: Double ->
            Rovenue.shared.remoteConfigDouble(key, fallback)
        }
        AsyncFunction("remoteConfigJson") Coroutine { key: String ->
            Rovenue.shared.remoteConfigJson(key)
        }
        AsyncFunction("remoteConfigKeys") Coroutine { ->
            Rovenue.shared.remoteConfigKeys()
        }
        AsyncFunction("remoteConfigAllJson") Coroutine { ->
            Rovenue.shared.remoteConfigAllJson()
        }
        AsyncFunction("experiment") Coroutine { key: String ->
            Rovenue.shared.experiment(key)?.let(::dtoFromExperimentAssignment)
        }
        AsyncFunction("experimentsAll") Coroutine { ->
            Rovenue.shared.experimentsAll().map(::dtoFromExperimentAssignment)
        }

        // ---------------- Purchases ----------------
        AsyncFunction("getOfferings") Coroutine { ->
            try {
                dtoFromOfferings(Rovenue.shared.getOfferings())
            } catch (e: Throwable) {
                throw codedError(e)
            }
        }
        AsyncFunction("purchase") Coroutine { productId: String, productType: String ->
            // Play Billing needs the foreground Activity to launch the flow.
            val activity = appContext.currentActivity
                ?: throw StoreProblemCodedException("No foreground Activity available for purchase")
            // JS sends the lowercase DTO string; reconstruct the façade enum.
            // The façade re-resolves the real Play product by id, so
            // displayName/price are not needed here.
            val product = StoreProduct(
                id = productId,
                type = productTypeFrom(productType),
                displayName = "",
            )
            try {
                dtoFromPurchaseResult(Rovenue.shared.purchase(activity, product))
            } catch (e: Throwable) {
                throw codedError(e)
            }
        }
        AsyncFunction("restorePurchases") Coroutine { ->
            val activity = appContext.currentActivity
                ?: throw StoreProblemCodedException("No foreground Activity available for restore")
            try {
                dtoFromPurchaseResult(Rovenue.shared.restorePurchases(activity))
            } catch (e: Throwable) {
                throw codedError(e)
            }
        }

        // ---------------- Refund Shield ----------------
        AsyncFunction("getAppAccountToken") Coroutine { ->
            Rovenue.shared.getAppAccountToken()
        }
        AsyncFunction("recordSessionEvent") Coroutine { kind: String, occurredAt: String, durationMs: Double? ->
            val kindEnum = when (kind) {
                "open" -> SessionEventKind.OPEN
                "background" -> SessionEventKind.BACKGROUND
                "close" -> SessionEventKind.CLOSE
                else -> SessionEventKind.OPEN
            }
            Rovenue.shared.recordSessionEvent(kindEnum, occurredAt, durationMs?.toInt()?.toUInt())
        }
        AsyncFunction("flushSessionEvents") Coroutine { ->
            Rovenue.shared.flushSessionEvents().toDouble()
        }

        // ---------------- Subscriber Attributes ----------------
        AsyncFunction("setAttributes") Coroutine { attributes: Map<String, String?> ->
            Rovenue.shared.setAttributes(attributes)
        }
        AsyncFunction("setEmail") Coroutine { email: String? ->
            Rovenue.shared.setEmail(email)
        }
        AsyncFunction("setDisplayName") Coroutine { name: String? ->
            Rovenue.shared.setDisplayName(name)
        }
        AsyncFunction("setPhoneNumber") Coroutine { phone: String? ->
            Rovenue.shared.setPhoneNumber(phone)
        }
        AsyncFunction("setPushToken") Coroutine { token: String? ->
            Rovenue.shared.setPushToken(token)
        }
        AsyncFunction("flushAttributes") Coroutine { ->
            // UInt → Double for the JS number bridge.
            Rovenue.shared.flushAttributes().toDouble()
        }

        // ---------------- Events ----------------
        Events("onChange", "onLog")

        OnStartObserving {
            changesJob = scope.launch {
                Rovenue.shared.changes.collect { event ->
                    sendEvent("onChange", mapOf("event" to event.name))
                }
            }
            logUnsub = Rovenue.shared.setLogHandler { entry: LogEntry ->
                sendEvent("onLog", mapOf(
                    "level" to entry.level,
                    "message" to entry.message,
                    "data" to entry.data,
                ))
            }
        }
        OnStopObserving {
            changesJob?.cancel()
            changesJob = null
            logUnsub?.invoke()
            logUnsub = null
        }
    }

    private fun dtoFromEntitlement(e: Entitlement): Map<String, Any?> = mapOf(
        "id"        to e.id,
        "active"    to e.isActive,
        "expiresAt" to e.expiresIso,
        "productId" to e.productIdentifier,
    )

    private fun dtoFromExperimentAssignment(a: ExperimentAssignment): Map<String, Any?> = mapOf(
        "experimentId" to a.experimentId,
        "key"          to a.key,
        "variantId"    to a.variantId,
        "variantName"  to a.variantName,
        "valueJson"    to a.valueJson,
    )

    // ---------------- Purchase DTO encoders ----------------

    /** Façade [ProductType] enum → lowercase DTO string (OUTBOUND). */
    private fun productTypeString(t: ProductType): String = when (t) {
        ProductType.SUBSCRIPTION    -> "subscription"
        ProductType.CONSUMABLE      -> "consumable"
        ProductType.NON_CONSUMABLE  -> "non_consumable"
    }

    /**
     * Lowercase DTO string → façade [ProductType] enum (INBOUND). Unknown
     * values default to SUBSCRIPTION (mirrors the façade's safest assumption).
     */
    private fun productTypeFrom(raw: String): ProductType = when (raw) {
        "consumable"     -> ProductType.CONSUMABLE
        "non_consumable" -> ProductType.NON_CONSUMABLE
        else             -> ProductType.SUBSCRIPTION
    }

    private fun dtoFromStoreProduct(p: StoreProduct): Map<String, Any?> = mapOf(
        "id"           to p.id,
        "type"         to productTypeString(p.type),
        "displayName"  to p.displayName,
        "priceString"  to p.priceString,
        "price"        to p.price,
        "currencyCode" to p.currencyCode,
    )

    private fun dtoFromOfferings(o: Offerings): Map<String, Any?> = mapOf(
        "current" to o.current?.identifier,
        "offerings" to o.all.values.map { off ->
            mapOf(
                "identifier" to off.identifier,
                "isDefault"  to off.isDefault,
                "packages"   to off.packages.map { pkg ->
                    mapOf(
                        "identifier" to pkg.identifier,
                        "product"    to dtoFromStoreProduct(pkg.product),
                    )
                },
            )
        },
    )

    private fun dtoFromPurchaseResult(r: PurchaseResult): Map<String, Any?> = mapOf(
        "entitlements"      to r.entitlements.map(::dtoFromEntitlement),
        "creditBalance"     to r.creditBalance.toDouble(),
        "productId"         to r.productId,
        "storeTransactionId" to r.storeTransactionId,
    )

    /**
     * Map the four façade purchase exceptions to Expo coded exceptions whose
     * `code` matches the RN `mapNativeError` switch in
     * packages/sdk-rn/src/errors.ts. Anything else is rethrown unchanged so
     * Expo surfaces its default code/message.
     */
    private fun codedError(e: Throwable): Throwable = when (e) {
        is PurchaseCancelledException   -> PurchaseCancelledCodedException(e.message)
        is PurchasePendingException     -> PurchasePendingCodedException(e.message)
        is ProductNotAvailableException -> ProductNotAvailableCodedException(e.message)
        is StoreProblemException        -> StoreProblemCodedException(e.message)
        else                            -> e
    }

    /**
     * Reads the host app's `versionName` from its installed PackageInfo.
     * Returns null if the context isn't available (module instantiated
     * outside an Activity host) or the lookup throws — telemetry then
     * falls back to the pre-0.7 empty-string wire format.
     *
     * Uses the API 33+ `PackageInfoFlags.of(0)` overload on supported
     * devices and the legacy int-flag overload as a fallback.
     */
    private fun readPackageVersionName(): String? {
        val context: Context = appContext.reactContext ?: return null
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
}

// Expo coded exceptions for the Play Billing purchase flow. The explicit
// `code` surfaces to JS unchanged and is matched by `mapNativeError` in
// packages/sdk-rn/src/errors.ts.
private class PurchaseCancelledCodedException(message: String?) :
    CodedException("PurchaseCancelled", message ?: "The purchase was cancelled", null)

private class PurchasePendingCodedException(message: String?) :
    CodedException("PurchasePending", message ?: "The purchase is pending", null)

private class ProductNotAvailableCodedException(message: String?) :
    CodedException("ProductNotAvailable", message ?: "The product is not available", null)

private class StoreProblemCodedException(message: String?) :
    CodedException("StoreProblem", message ?: "A store error occurred", null)
