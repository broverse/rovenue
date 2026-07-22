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
import android.content.res.Resources
import android.os.Build
import android.util.DisplayMetrics
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import java.util.Locale
import java.util.TimeZone
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import dev.rovenue.sdk.Discount
import dev.rovenue.sdk.DiscountType
import dev.rovenue.sdk.IntroPrice
import dev.rovenue.sdk.LogEntry
import dev.rovenue.sdk.Offerings
import dev.rovenue.sdk.generated.LogLevel
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.PaymentMode
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.PricingPhase
import dev.rovenue.sdk.PurchaseResult
import dev.rovenue.sdk.RecurrenceMode
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.SubscriptionOption
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.ClaimInstallParams
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
import org.json.JSONObject

class RovenueModule : Module() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var changesJob: Job? = null
    private var funnelClaimsJob: Job? = null
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
        Function("configure") { apiKey: String, baseUrl: String?, logLevel: String, appVersion: String?, environment: String? ->
            val resolved = appVersion ?: readPackageVersionName()
            val level = when (logLevel) {
                "off"   -> LogLevel.OFF
                "error" -> LogLevel.ERROR
                "warn"  -> LogLevel.WARN
                "info"  -> LogLevel.INFO
                "debug" -> LogLevel.DEBUG
                "trace" -> LogLevel.TRACE
                else    -> LogLevel.WARN
            }
            // The M4 Kotlin façade needs a Context to drive Play Billing.
            Rovenue.configure(
                apiKey = apiKey,
                baseUrl = baseUrl,
                logLevel = level,
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
            try { Rovenue.shared.identify(appUserId) } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("logOut") Coroutine { ->
            try { Rovenue.shared.logOut() } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("entitlement") Coroutine { id: String ->
            Rovenue.shared.entitlement(id)?.let(::dtoFromEntitlement)
        }
        AsyncFunction("entitlementsAll") Coroutine { ->
            Rovenue.shared.entitlementsAll().map(::dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") Coroutine { ->
            try { Rovenue.shared.refreshEntitlements() } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("virtualCurrencies") Coroutine { ->
            Rovenue.shared.virtualCurrencyBalances().mapValues { it.value.toDouble() }
        }
        AsyncFunction("virtualCurrency") Coroutine { code: String ->
            Rovenue.shared.virtualCurrency(code).toDouble()
        }
        AsyncFunction("refreshVirtualCurrencies") Coroutine { ->
            try { Rovenue.shared.refreshVirtualCurrencies() } catch (e: Throwable) { throw codedError(e) }
        }
        // ---------------- Remote Config ----------------
        AsyncFunction("refreshRemoteConfig") Coroutine { ->
            try { Rovenue.shared.refreshRemoteConfig() } catch (e: Throwable) { throw codedError(e) }
        }
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
        AsyncFunction("getPaywall") Coroutine { placementId: String, locale: String? ->
            try {
                Rovenue.shared.getPaywall(placementId, locale)?.let(::dtoFromPaywall)
            } catch (e: Throwable) {
                throw codedError(e)
            }
        }
        AsyncFunction("setFallbackPlacements") Coroutine { json: String ->
            try {
                Rovenue.shared.setFallbackPlacements(json).toDouble()
            } catch (e: Throwable) {
                throw codedError(e)
            }
        }
        AsyncFunction("purchase") Coroutine { productId: String, productType: String, promotionalOfferId: String?, basePlanId: String?, offerId: String? ->
            // promotionalOfferId is iOS-only (ignored here). basePlanId/offerId select a Play subscription offer.
            // Play Billing needs the foreground Activity to launch the flow.
            val activity = appContext.currentActivity
                ?: throw StoreProblemFallbackCodedException("No foreground Activity available for purchase")
            // JS sends the lowercase DTO string; reconstruct the façade enum.
            // The façade re-resolves the real Play product by id, so
            // displayName/price are not needed here.
            val product = StoreProduct(
                id = productId,
                type = productTypeFrom(productType),
                displayName = "",
            )
            try {
                dtoFromPurchaseResult(Rovenue.shared.purchase(activity, product, basePlanId, offerId))
            } catch (e: Throwable) {
                throw codedError(e)
            }
        }
        AsyncFunction("restorePurchases") Coroutine { ->
            val activity = appContext.currentActivity
                ?: throw StoreProblemFallbackCodedException("No foreground Activity available for restore")
            try {
                dtoFromPurchaseResult(Rovenue.shared.restorePurchases(activity))
            } catch (e: Throwable) {
                throw codedError(e)
            }
        }

        // ---------------- Refund Shield ----------------
        AsyncFunction("getAppAccountToken") Coroutine { ->
            try { Rovenue.shared.getAppAccountToken() } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("recordSessionEvent") Coroutine { kind: String, occurredAt: String, durationMs: Double? ->
            val kindEnum = when (kind) {
                "open" -> SessionEventKind.OPEN
                "background" -> SessionEventKind.BACKGROUND
                "close" -> SessionEventKind.CLOSE
                else -> SessionEventKind.OPEN
            }
            try {
                Rovenue.shared.recordSessionEvent(kindEnum, occurredAt, durationMs?.toInt()?.toUInt())
            } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("flushSessionEvents") Coroutine { ->
            try { Rovenue.shared.flushSessionEvents().toDouble() } catch (e: Throwable) { throw codedError(e) }
        }

        // ---------------- Subscriber Attributes ----------------
        AsyncFunction("setAttributes") Coroutine { attributes: Map<String, String?> ->
            try { Rovenue.shared.setAttributes(attributes) } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("setEmail") Coroutine { email: String? ->
            try { Rovenue.shared.setEmail(email) } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("setDisplayName") Coroutine { name: String? ->
            try { Rovenue.shared.setDisplayName(name) } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("setPhoneNumber") Coroutine { phone: String? ->
            try { Rovenue.shared.setPhoneNumber(phone) } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("setPushToken") Coroutine { token: String? ->
            try { Rovenue.shared.setPushToken(token) } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("flushAttributes") Coroutine { ->
            // UInt → Double for the JS number bridge.
            try { Rovenue.shared.flushAttributes().toDouble() } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("track") Coroutine { envelopeJson: String ->
            try { Rovenue.shared.track(envelopeJson) } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("enqueuePaywallEvent") Coroutine { envelopeJson: String ->
            try { Rovenue.shared.enqueuePaywallEvent(envelopeJson) } catch (e: Throwable) { throw codedError(e) }
        }

        // ---------------- Funnel Claim ----------------
        AsyncFunction("installId") Coroutine { ->
            Rovenue.shared.installId()
        }
        AsyncFunction("hasResolvedFunnelClaim") Coroutine { ->
            Rovenue.shared.hasResolvedFunnelClaim()
        }
        AsyncFunction("claimFunnelToken") Coroutine { token: String ->
            try {
                val r = Rovenue.shared.claimFunnelToken(token)
                mapOf("subscriberId" to r.subscriberId, "funnelAnswersJson" to r.funnelAnswersJson)
            } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("claimFromClipboard") Coroutine { ->
            // Android's deferred path is the Play Install Referrer (sub-project B);
            // clipboard recovery is iOS-only. No-op for API symmetry.
            null
        }
        AsyncFunction("claimInstall") Coroutine { params: Map<String, Any?> ->
            val ctx = collectAndroidContext()
            val p = ClaimInstallParams(
                platform = params["platform"] as? String ?: "android",
                locale = params["locale"] as? String ?: ctx.locale,
                timezone = params["timezone"] as? String ?: ctx.timezone,
                screenDims = params["screenDims"] as? String ?: ctx.screenDims,
                deviceModel = params["deviceModel"] as? String ?: ctx.deviceModel,
                installReferrer = params["installReferrer"] as? String ?: readInstallReferrer(),
            )
            try {
                val r = Rovenue.shared.claimInstall(p) ?: return@Coroutine null
                mapOf("subscriberId" to r.subscriberId, "funnelAnswersJson" to r.funnelAnswersJson)
            } catch (e: Throwable) { throw codedError(e) }
        }
        AsyncFunction("claimViaEmail") Coroutine { email: String ->
            try { Rovenue.shared.claimViaEmail(email) } catch (e: Throwable) { throw codedError(e) }
        }

        // ---------------- Events ----------------
        Events("onChange", "onLog", "onFunnelClaimResolved")

        OnStartObserving {
            changesJob = scope.launch {
                Rovenue.shared.changes.collect { event ->
                    sendEvent("onChange", mapOf("event" to event.name))
                }
            }
            funnelClaimsJob = scope.launch {
                Rovenue.shared.funnelClaims.collect { r ->
                    sendEvent("onFunnelClaimResolved", mapOf(
                        "subscriberId" to r.subscriberId,
                        "funnelAnswersJson" to r.funnelAnswersJson,
                    ))
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
            funnelClaimsJob?.cancel()
            funnelClaimsJob = null
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

    // ---------------- Enum → lowerCamel string mappers ----------------

    private fun productCategoryString(c: ProductCategory): String = when (c) {
        ProductCategory.SUBSCRIPTION     -> "subscription"
        ProductCategory.NON_SUBSCRIPTION -> "nonSubscription"
    }

    private fun periodUnitString(u: PeriodUnit): String = when (u) {
        PeriodUnit.DAY   -> "day"
        PeriodUnit.WEEK  -> "week"
        PeriodUnit.MONTH -> "month"
        PeriodUnit.YEAR  -> "year"
    }

    private fun paymentModeString(m: PaymentMode): String = when (m) {
        PaymentMode.FREE_TRIAL   -> "freeTrial"
        PaymentMode.PAY_AS_YOU_GO -> "payAsYouGo"
        PaymentMode.PAY_UP_FRONT -> "payUpFront"
    }

    private fun discountTypeString(t: DiscountType): String = when (t) {
        DiscountType.INTRODUCTORY -> "introductory"
        DiscountType.PROMOTIONAL  -> "promotional"
        DiscountType.WIN_BACK     -> "winBack"
    }

    private fun recurrenceModeString(r: RecurrenceMode): String = when (r) {
        RecurrenceMode.INFINITE_RECURRING -> "infiniteRecurring"
        RecurrenceMode.FINITE_RECURRING   -> "finiteRecurring"
        RecurrenceMode.NON_RECURRING      -> "nonRecurring"
    }

    private fun packageTypeString(t: PackageType): String = when (t) {
        PackageType.UNKNOWN     -> "unknown"
        PackageType.CUSTOM      -> "custom"
        PackageType.LIFETIME    -> "lifetime"
        PackageType.ANNUAL      -> "annual"
        PackageType.SIX_MONTH   -> "sixMonth"
        PackageType.THREE_MONTH -> "threeMonth"
        PackageType.TWO_MONTH   -> "twoMonth"
        PackageType.MONTHLY     -> "monthly"
        PackageType.WEEKLY      -> "weekly"
    }

    // ---------------- Nested DTO helpers ----------------

    private fun periodMap(p: Period): Map<String, Any?> = mapOf(
        "value"   to p.value,
        "unit"    to periodUnitString(p.unit),
        "iso8601" to p.iso8601,
    )

    private fun introMap(i: IntroPrice?): Any? {
        if (i == null) return null
        return mapOf(
            "price"        to i.price,
            "priceString"  to i.priceString,
            "currencyCode" to i.currencyCode,
            "period"       to periodMap(i.period),
            "cycles"       to i.cycles,
            "paymentMode"  to paymentModeString(i.paymentMode),
        )
    }

    private fun discountMap(d: Discount): Map<String, Any?> = mapOf(
        "identifier"     to d.identifier,
        "price"          to d.price,
        "priceString"    to d.priceString,
        "currencyCode"   to d.currencyCode,
        "period"         to periodMap(d.period),
        "numberOfPeriods" to d.numberOfPeriods,
        "paymentMode"    to paymentModeString(d.paymentMode),
        "type"           to discountTypeString(d.type),
    )

    private fun phaseMap(ph: PricingPhase): Map<String, Any?> = mapOf(
        "price"            to ph.price,
        "priceString"      to ph.priceString,
        "currencyCode"     to ph.currencyCode,
        "billingPeriod"    to periodMap(ph.billingPeriod),
        "billingCycleCount" to ph.billingCycleCount,
        "recurrenceMode"   to recurrenceModeString(ph.recurrenceMode),
        "paymentMode"      to ph.paymentMode?.let { paymentModeString(it) },
    )

    private fun optionMap(opt: SubscriptionOption): Map<String, Any?> = mapOf(
        "id"             to opt.id,
        "basePlanId"     to opt.basePlanId,
        "offerId"        to opt.offerId,
        "tags"           to opt.tags,
        "isBasePlan"     to opt.isBasePlan,
        "isPrepaid"      to opt.isPrepaid,
        "pricingPhases"  to opt.pricingPhases.map { phaseMap(it) },
        "freePhase"      to opt.freePhase?.let { phaseMap(it) },
        "introPhase"     to opt.introPhase?.let { phaseMap(it) },
        "fullPricePhase" to opt.fullPricePhase?.let { phaseMap(it) },
    )

    // ---------------- StoreProduct + Offerings serializers ----------------

    private fun dtoFromStoreProduct(p: StoreProduct): Map<String, Any?> = mapOf(
        "id"                          to p.id,
        "type"                        to productTypeString(p.type),
        "productCategory"             to productCategoryString(p.productCategory),
        "displayName"                 to p.displayName,
        "description"                 to p.description,
        "priceString"                 to p.priceString,
        "price"                       to p.price,
        "currencyCode"                to p.currencyCode,
        "subscriptionPeriod"          to p.subscriptionPeriod?.let { periodMap(it) },
        "subscriptionGroupIdentifier" to p.subscriptionGroupIdentifier,
        "isFamilyShareable"           to p.isFamilyShareable,
        "introPrice"                  to introMap(p.introPrice),
        // Discounts are iOS-only (App Store promotional offers); always empty on Android.
        "discounts"                   to emptyList<Any>(),
        "isEligibleForIntroOffer"     to p.isEligibleForIntroOffer,
        // subscriptionOptions + defaultOption are Android-only (Google Play base plans + offers).
        "subscriptionOptions"         to p.subscriptionOptions?.map { optionMap(it) },
        "defaultOption"               to p.defaultOption?.let { optionMap(it) },
        "pricePerWeek"                to p.pricePerWeek,
        "pricePerMonth"               to p.pricePerMonth,
        "pricePerYear"                to p.pricePerYear,
        "pricePerWeekString"          to p.pricePerWeekString,
        "pricePerMonthString"         to p.pricePerMonthString,
        "pricePerYearString"          to p.pricePerYearString,
    )

    private fun dtoFromOffering(off: dev.rovenue.sdk.Offering): Map<String, Any?> = mapOf(
        "identifier" to off.identifier,
        "isDefault"  to off.isDefault,
        "packages"   to off.packages.map { pkg ->
            mapOf(
                "identifier"  to pkg.identifier,
                "packageType" to packageTypeString(pkg.packageType),
                "product"     to dtoFromStoreProduct(pkg.product),
            )
        },
    )

    private fun dtoFromOfferings(o: Offerings): Map<String, Any?> = mapOf(
        "current" to o.current?.identifier,
        "offerings" to o.all.values.map(::dtoFromOffering),
    )

    private fun dtoFromPresentedContext(c: dev.rovenue.sdk.PresentedContext): Map<String, Any?> = mapOf(
        "placementId" to c.placementId,
        "paywallId" to c.paywallId,
        "variantId" to c.variantId,
        "experimentKey" to c.experimentKey,
        "revision" to c.revision.toDouble(),
    )

    /** Recursively converts a decoded remote-config value (Map/List/scalar,
     *  as produced by [dev.rovenue.sdk.internal.decodeRemoteConfig]) into an
     *  `org.json` value so it can be re-serialized to the wire JSON string
     *  the DTO carries — JS re-parses it (see paywalls.ts parseRemoteConfig). */
    private fun Any?.toJsonValue(): Any = when (this) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { obj -> forEach { (k, v) -> obj.put(k.toString(), v.toJsonValue()) } }
        is List<*> -> org.json.JSONArray().also { arr -> forEach { arr.put(it.toJsonValue()) } }
        else -> this
    }

    private fun dtoFromPaywall(p: dev.rovenue.sdk.Paywall): Map<String, Any?> = mapOf(
        "placementIdentifier" to p.placementIdentifier,
        "placementRevision" to p.placementRevision.toDouble(),
        "paywallIdentifier" to p.paywallIdentifier,
        "paywallName" to p.paywallName,
        "configFormatVersion" to p.configFormatVersion.toDouble(),
        "remoteConfigJson" to p.remoteConfig?.let { (it as Any?).toJsonValue().toString() },
        "remoteConfigLocale" to p.remoteConfigLocale,
        "builderConfigJson" to p.builderConfigJson,
        "offering" to p.offering?.let(::dtoFromOffering),
        "presentedContext" to p.presentedContext?.let(::dtoFromPresentedContext),
        "servedFromFallback" to p.servedFromFallback,
    )

    private fun dtoFromPurchaseResult(r: PurchaseResult): Map<String, Any?> = mapOf(
        "entitlements"      to r.entitlements.map(::dtoFromEntitlement),
        "virtualCurrencies" to r.virtualCurrencies.mapValues { it.value.toDouble() },
        "productId"         to r.productId,
        "storeTransactionId" to r.storeTransactionId,
        "isDeferred"        to r.isDeferred,
    )

    /**
     * Convert a [RovenueException] to a [RovenueCodedError] so the Expo bridge
     * surfaces a structured `code` (= `error.kind.name` = UPPER_SNAKE_CASE) and
     * extras (`serverCode`, `httpStatus`, `retryable`) to JS. The JS
     * `mapNativeError()` normaliser resolves UPPER_SNAKE back to PascalCase.
     * Non-RovenueException throwables propagate unchanged.
     */
    private fun codedError(e: Throwable): Throwable =
        if (e is RovenueException) RovenueCodedError(e) else e

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

    private data class AndroidInstallContext(
        val locale: String,
        val timezone: String,
        val screenDims: String,
        val deviceModel: String,
    )

    /** Collects the device context the backend's claim-install requires.
     *  No fingerprinting concern on Android (Google-sanctioned referrer flow). */
    private fun collectAndroidContext(): AndroidInstallContext {
        val ctx: Context? = appContext.reactContext?.applicationContext
        val dm: DisplayMetrics = ctx?.resources?.displayMetrics ?: Resources.getSystem().displayMetrics
        return AndroidInstallContext(
            locale = Locale.getDefault().toLanguageTag(),
            timezone = TimeZone.getDefault().id,
            screenDims = "${dm.widthPixels}x${dm.heightPixels}",
            deviceModel = Build.MODEL ?: "",
        )
    }

    /** Reads the raw Google Play Install Referrer once, with a 3s connection
     *  timeout. Returns null when unavailable (no Play Store, sideloaded,
     *  FEATURE_NOT_SUPPORTED/SERVICE_UNAVAILABLE, timeout, or any error). The
     *  raw string is parsed server-side (parseInstallReferrer → rovenue_funnel_token). */
    private suspend fun readInstallReferrer(): String? {
        val ctx: Context = appContext.reactContext?.applicationContext ?: return null
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

/**
 * Single Expo CodedException that wraps any [RovenueException] from the Kotlin façade.
 *
 * `code`    = `error.kind.name` — yields UPPER_SNAKE_CASE (e.g. "NETWORK_UNAVAILABLE",
 *             "PURCHASE_CANCELED"). The JS `mapNativeError()` normaliser strips underscores
 *             and does a case-insensitive lookup to resolve the canonical PascalCase ErrorKind.
 * `message` = a tagged JSON envelope carrying the human message AND the structured extras
 *             (serverCode, httpStatus, retryable).
 *
 * WHY an envelope: the Expo JSI bridge forwards ONLY `code` + `message` to JS —
 * `PromiseImpl.reject(code, message, cause)` calls `callback.invoke(code, message)` and
 * drops the `cause`/anything else. (The third `CodedException` ctor arg is a `Throwable?`
 * cause, NOT an extras map.) So the extras are folded into the message and the JS
 * mapNativeError() unpacks them. The prefix is kept in sync verbatim with
 * NATIVE_ERROR_ENVELOPE_PREFIX in src/errors.ts.
 */
private class RovenueCodedError(e: RovenueException) : CodedException(
    e.kind.name,
    buildEnvelope(e),
    null,
) {
    companion object {
        private const val ENVELOPE_PREFIX = "@rovenue/err1:"

        private fun buildEnvelope(e: RovenueException): String {
            val o = JSONObject()
            o.put("message", e.message ?: "")
            o.put("retryable", e.isRetryable)
            e.serverCode?.let { o.put("serverCode", it) }
            e.httpStatus?.let { o.put("httpStatus", it) }
            return ENVELOPE_PREFIX + o.toString()
        }
    }
}

// Fallback for the "No foreground Activity" guard (no RovenueException available yet).
// JS normalizer maps "STORE_PROBLEM" → "StoreProblem".
private class StoreProblemFallbackCodedException(message: String?) :
    CodedException("STORE_PROBLEM", message ?: "A store error occurred", null)
