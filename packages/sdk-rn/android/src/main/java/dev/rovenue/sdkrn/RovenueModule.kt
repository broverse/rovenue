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
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Entitlement
import dev.rovenue.sdk.generated.SessionEventKind
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
        Function("configure") { apiKey: String, baseUrl: String, debug: Boolean, appVersion: String? ->
            val resolved = appVersion ?: readPackageVersionName()
            Rovenue.configure(apiKey, baseUrl, debug, resolved)
        }
        Function("shutdown") { Rovenue.shared.shutdown() }
        Function("setForeground") { foreground: Boolean ->
            Rovenue.shared.setForeground(foreground)
        }
        Function("getVersion") { Rovenue.shared.version }

        // ---------------- Async ----------------
        AsyncFunction("currentUser") Coroutine { ->
            val u = Rovenue.shared.currentUser()
            mapOf("anonId" to u.anonId, "knownUserId" to u.knownUserId)
        }
        AsyncFunction("identify") Coroutine { knownUserId: String ->
            Rovenue.shared.identify(knownUserId)
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
        AsyncFunction("postAppleReceipt") Coroutine { jws: String, productId: String, appAccountToken: String? ->
            Rovenue.shared.postAppleReceipt(jws, productId, appAccountToken)
            mapOf("ok" to true, "entitlementsRefreshed" to true, "creditsRefreshed" to true)
        }
        AsyncFunction("postGoogleReceipt") Coroutine { receipt: String, productId: String, obfAccount: String?, obfProfile: String? ->
            Rovenue.shared.postGoogleReceipt(receipt, productId, obfAccount, obfProfile)
            mapOf("ok" to true, "entitlementsRefreshed" to true, "creditsRefreshed" to true)
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
