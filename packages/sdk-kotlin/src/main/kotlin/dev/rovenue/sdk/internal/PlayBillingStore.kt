// PlayBillingStore.kt — the live Play Billing 6 implementation of [PlayStore].
//
// This is the integration edge: it talks to the real BillingClient. It is NOT
// exercised by unit tests (which use a fake PlayStore); correctness here is
// covered by compilation plus the PlayPurchaseFlow unit tests. Callbacks are
// bridged to coroutines via suspendCancellableCoroutine.

package dev.rovenue.sdk.internal

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.generated.ErrorKind
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class PlayBillingStore(private val context: Context) : PlayStore {

    // Atomic flag that prevents two concurrent purchase() calls from both
    // entering the billing flow and racing on the single `pending` slot.
    // compareAndSet(false, true) succeeds only for the first caller.
    private val inFlight = AtomicBoolean(false)

    // The PurchasesUpdatedListener fires asynchronously after launchBillingFlow.
    // We hold the in-flight continuation here and resume it from the listener.
    @Volatile
    private var pending: Continuation<StorePurchaseOutcome>? = null

    private val purchasesListener = PurchasesUpdatedListener { result, purchases ->
        val cont = pending ?: return@PurchasesUpdatedListener
        pending = null
        inFlight.set(false)
        if (result.responseCode == BillingClient.BillingResponseCode.OK) {
            val purchase = purchases?.firstOrNull()
            if (purchase == null) {
                cont.resume(StorePurchaseOutcome.ProductNotFound)
            } else if (purchase.purchaseState == Purchase.PurchaseState.PURCHASED) {
                cont.resume(successFor(purchase))
            } else {
                // PENDING or unknown state → Deferred (not a failure)
                cont.resume(StorePurchaseOutcome.Deferred)
            }
        } else {
            val outcome = mapBillingCode(result.responseCode, null, null)
            when (outcome) {
                is StorePurchaseOutcome.StoreProblem ->
                    cont.resumeWithException(
                        RovenueException(
                            kind = ErrorKind.STORE_PROBLEM,
                            message = "billing error ${result.responseCode}: ${result.debugMessage}",
                        ),
                    )
                else -> cont.resume(outcome)
            }
        }
    }

    // The acknowledge/consume needs the productType captured at flow time.
    @Volatile
    private var pendingType: ProductType = ProductType.SUBSCRIPTION

    @Volatile
    private var billingClient: BillingClient? = null

    override suspend fun purchase(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
        basePlanId: String?,
        offerId: String?,
    ): StorePurchaseOutcome {
        // Atomic concurrency guard — compareAndSet ensures exactly one caller
        // can enter the billing flow at a time. A second concurrent purchase()
        // is rejected immediately rather than silently clobbering the pending
        // continuation slot (which would result in one caller never resuming).
        if (!inFlight.compareAndSet(false, true)) {
            return StorePurchaseOutcome.StoreProblem
        }
        pendingType = productType
        val client = connect()
        val details = queryDetails(client, productId, productType)
            ?: run { inFlight.set(false); return StorePurchaseOutcome.ProductNotFound }

        var selectedOfferToken: String? = null
        if (productType == ProductType.SUBSCRIPTION) {
            val candidates = (details.subscriptionOfferDetails ?: emptyList()).map { offer ->
                PlayOfferToken(
                    basePlanId = offer.basePlanId,
                    offerId = offer.offerId,
                    offerToken = offer.offerToken,
                    recurringPriceMicros = offer.pricingPhases.pricingPhaseList
                        .firstOrNull { it.recurrenceMode == 1 }?.priceAmountMicros,
                )
            }
            selectedOfferToken = selectOfferToken(candidates, basePlanId, offerId)
            // Caller asked for a specific offer that no longer exists → fail loudly, do not pick a different price.
            if (selectedOfferToken == null && basePlanId != null) {
                inFlight.set(false); return StorePurchaseOutcome.OfferNotFound
            }
        }

        val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .apply { selectedOfferToken?.let { setOfferToken(it) } }
            .build()

        val flowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(productParams))
            .apply { obfuscatedAccountId?.let { setObfuscatedAccountId(it) } }
            .build()

        return suspendCancellableCoroutine { cont ->
            pending = cont
            cont.invokeOnCancellation {
                pending = null
                inFlight.set(false)
            }
            val launch = client.launchBillingFlow(activity, flowParams)
            if (launch.responseCode != BillingClient.BillingResponseCode.OK) {
                pending = null
                inFlight.set(false)
                cont.resumeWithException(
                    RovenueException(
                        kind = ErrorKind.STORE_PROBLEM,
                        message = "launchBillingFlow failed ${launch.responseCode}: ${launch.debugMessage}",
                    ),
                )
            }
        }
    }

    @Volatile
    private var lastRawDetails: Map<String, ProductDetails> = emptyMap()

    override fun rawDetails(): Map<String, ProductDetails> = lastRawDetails

    override suspend fun queryProducts(
        inappIds: List<String>,
        subscriptionIds: List<String>,
    ): Map<String, ProductInfo> {
        if (inappIds.isEmpty() && subscriptionIds.isEmpty()) return emptyMap()
        val client = connect()
        val out = mutableMapOf<String, ProductInfo>()
        val rawOut = mutableMapOf<String, ProductDetails>()
        if (inappIds.isNotEmpty()) {
            queryDetailsBatch(client, inappIds, BillingClient.ProductType.INAPP).forEach { details ->
                rawOut[details.productId] = details
                inappProductInfo(details)?.let { out[details.productId] = it }
            }
        }
        if (subscriptionIds.isNotEmpty()) {
            queryDetailsBatch(client, subscriptionIds, BillingClient.ProductType.SUBS).forEach { details ->
                rawOut[details.productId] = details
                subsProductInfo(details)?.let { out[details.productId] = it }
            }
        }
        lastRawDetails = rawOut
        return out
    }

    private suspend fun queryDetailsBatch(
        client: BillingClient,
        productIds: List<String>,
        type: String,
    ): List<ProductDetails> {
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                productIds.map {
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(it)
                        .setProductType(type)
                        .build()
                },
            )
            .build()
        return awaitProductDetails(client, params)
    }

    private fun inappProductInfo(details: ProductDetails): ProductInfo? {
        val offer = details.oneTimePurchaseOfferDetails ?: return null
        val phase = PlayPhaseInput(
            priceMicros = offer.priceAmountMicros,
            formattedPrice = offer.formattedPrice,
            currencyCode = offer.priceCurrencyCode,
            billingPeriodIso = "P0D", // one-time purchases have no period; explicit zero period
            billingCycleCount = 1,
            recurrenceMode = 3, // NON_RECURRING
        )
        return ProductInfo(description = details.description, options = null, oneTimePrice = phase)
    }

    private fun subsProductInfo(details: ProductDetails): ProductInfo? {
        val offerDetails = details.subscriptionOfferDetails ?: return null
        val options = offerDetails.map { offer ->
            val phases = offer.pricingPhases.pricingPhaseList.map { phase ->
                PlayPhaseInput(
                    priceMicros = phase.priceAmountMicros,
                    formattedPrice = phase.formattedPrice,
                    currencyCode = phase.priceCurrencyCode,
                    billingPeriodIso = phase.billingPeriod,
                    billingCycleCount = phase.billingCycleCount,
                    recurrenceMode = phase.recurrenceMode,
                )
            }
            mapSubscriptionOption(PlayOfferInput(
                basePlanId = offer.basePlanId,
                offerId = offer.offerId,
                tags = offer.offerTags,
                phases = phases,
            ))
        }
        return ProductInfo(description = details.description, options = options, oneTimePrice = null)
    }

    override suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase> {
        val client = connect()
        val out = mutableListOf<PendingPurchase>()
        out += queryOwned(client, BillingClient.ProductType.SUBS, isConsumable = false)
        out += queryOwned(client, BillingClient.ProductType.INAPP, isConsumable = false)
        return out
    }

    private suspend fun queryOwned(
        client: BillingClient,
        type: String,
        @Suppress("UNUSED_PARAMETER") isConsumable: Boolean,
    ): List<PendingPurchase> {
        val params = QueryPurchasesParams.newBuilder().setProductType(type).build()
        return awaitPurchases(client, params)
            .filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
            .map { purchase ->
                val productId = purchase.products.firstOrNull() ?: ""
                // INAPP purchases may be consumables; we can't know the configured
                // type here, so acknowledge() acknowledges (never consumes) during
                // reconciliation. Consumables are consumed in the foreground
                // purchase flow; an unacknowledged consumable left over from a
                // crashed flow is still validated + acknowledged here, which grants
                // entitlement and stops the auto-refund — consumption can follow.
                PendingPurchase(
                    purchaseToken = purchase.purchaseToken,
                    productId = productId,
                    productType = if (type == BillingClient.ProductType.SUBS) {
                        ProductType.SUBSCRIPTION
                    } else {
                        ProductType.NON_CONSUMABLE
                    },
                    isAcknowledged = purchase.isAcknowledged,
                    acknowledge = { acknowledge(client, purchase.purchaseToken) },
                )
            }
    }

    private fun successFor(purchase: Purchase): StorePurchaseOutcome.Success {
        val client = billingClient
        val isConsumable = pendingType == ProductType.CONSUMABLE
        return StorePurchaseOutcome.Success(
            purchaseToken = purchase.purchaseToken,
            orderId = purchase.orderId ?: "",
            acknowledge = {
                val c = client ?: throw RovenueException(kind = ErrorKind.STORE_PROBLEM, message = "billing client gone")
                if (isConsumable) {
                    consume(c, purchase.purchaseToken)
                } else if (!purchase.isAcknowledged) {
                    acknowledge(c, purchase.purchaseToken)
                }
            },
        )
    }

    private suspend fun connect(): BillingClient {
        billingClient?.let { if (it.isReady) return it }
        val client = BillingClient.newBuilder(context)
            .setListener(purchasesListener)
            // PBL 8 removed the no-arg enablePendingPurchases(); the params form
            // with enableOneTimeProducts() is the documented functional equivalent.
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder().enableOneTimeProducts().build(),
            )
            .build()
        billingClient = client
        return suspendCancellableCoroutine { cont ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                        cont.resume(client)
                    } else {
                        cont.resumeWithException(
                            RovenueException(
                                kind = ErrorKind.STORE_PROBLEM,
                                message = "billing setup failed ${result.responseCode}: ${result.debugMessage}",
                            ),
                        )
                    }
                }

                override fun onBillingServiceDisconnected() {
                    // No-op: the next purchase() reconnects via connect().
                }
            })
        }
    }

    private suspend fun queryDetails(
        client: BillingClient,
        productId: String,
        productType: ProductType,
    ): ProductDetails? {
        val type = if (productType == ProductType.SUBSCRIPTION) {
            BillingClient.ProductType.SUBS
        } else {
            BillingClient.ProductType.INAPP
        }
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(productId)
                        .setProductType(type)
                        .build(),
                ),
            )
            .build()
        return awaitProductDetails(client, params).firstOrNull()
    }

    // PBL 8 dropped the Kotlin suspend ktx extensions (billing-ktx now ships
    // Kotlin 2.x metadata, incompatible with this module's Kotlin 1.9), so we
    // bridge the callback query APIs to coroutines ourselves — same pattern as
    // consume/acknowledge below.
    private suspend fun awaitProductDetails(
        client: BillingClient,
        params: QueryProductDetailsParams,
    ): List<ProductDetails> =
        suspendCancellableCoroutine { cont ->
            client.queryProductDetailsAsync(params) { result, details ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    cont.resume(details.productDetailsList)
                } else {
                    cont.resumeWithException(
                        RovenueException(
                            kind = ErrorKind.STORE_PROBLEM,
                            message = "queryProductDetails failed ${result.responseCode}: ${result.debugMessage}",
                        ),
                    )
                }
            }
        }

    private suspend fun awaitPurchases(
        client: BillingClient,
        params: QueryPurchasesParams,
    ): List<Purchase> =
        suspendCancellableCoroutine { cont ->
            client.queryPurchasesAsync(params) { result, purchases ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    cont.resume(purchases)
                } else {
                    cont.resumeWithException(
                        RovenueException(
                            kind = ErrorKind.STORE_PROBLEM,
                            message = "queryPurchases failed ${result.responseCode}: ${result.debugMessage}",
                        ),
                    )
                }
            }
        }

    private suspend fun consume(client: BillingClient, token: String) =
        suspendCancellableCoroutine<Unit> { cont ->
            val params = ConsumeParams.newBuilder().setPurchaseToken(token).build()
            client.consumeAsync(params) { result, _ ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    cont.resume(Unit)
                } else {
                    cont.resumeWithException(
                        RovenueException(
                            kind = ErrorKind.STORE_PROBLEM,
                            message = "consume failed ${result.responseCode}: ${result.debugMessage}",
                        ),
                    )
                }
            }
        }

    private suspend fun acknowledge(client: BillingClient, token: String) =
        suspendCancellableCoroutine<Unit> { cont ->
            val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()
            client.acknowledgePurchase(params) { result ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    cont.resume(Unit)
                } else {
                    cont.resumeWithException(
                        RovenueException(
                            kind = ErrorKind.STORE_PROBLEM,
                            message = "acknowledge failed ${result.responseCode}: ${result.debugMessage}",
                        ),
                    )
                }
            }
        }
}

// ---------------------------------------------------------------------------
// Billing-code mapping — package-internal so it can be unit-tested without a
// live BillingClient. PURCHASED is NOT handled here (the caller uses
// successFor(purchase) when the purchase state is PURCHASED).
//
// @param code       BillingClient.BillingResponseCode
// @param subResponse PBL9 sub-response code, or null (for ERROR with
//                    PAYMENT_DECLINED / USER_INELIGIBLE disambiguation)
// @param state      Purchase.PurchaseState, or null (used only when code==OK)
// ---------------------------------------------------------------------------

// PBL9 sub-response constants (not exposed as a public API by the SDK).
private const val SUB_RESPONSE_PAYMENT_DECLINED = 1   // PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS
private const val SUB_RESPONSE_USER_INELIGIBLE = 2    // USER_INELIGIBLE

internal fun mapBillingCode(
    code: Int,
    subResponse: Int?,
    state: Int?,
): StorePurchaseOutcome = when (code) {
    BillingClient.BillingResponseCode.OK -> when (state) {
        Purchase.PurchaseState.PURCHASED -> StorePurchaseOutcome.Deferred // replaced by successFor at call site
        Purchase.PurchaseState.PENDING -> StorePurchaseOutcome.Deferred
        else -> StorePurchaseOutcome.Deferred
    }
    BillingClient.BillingResponseCode.USER_CANCELED ->
        StorePurchaseOutcome.UserCancelled
    BillingClient.BillingResponseCode.ITEM_UNAVAILABLE ->
        StorePurchaseOutcome.ProductNotFound
    BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED ->
        StorePurchaseOutcome.AlreadyOwned
    BillingClient.BillingResponseCode.SERVICE_DISCONNECTED,
    BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,
    BillingClient.BillingResponseCode.BILLING_UNAVAILABLE,
    BillingClient.BillingResponseCode.NETWORK_ERROR ->
        StorePurchaseOutcome.ServiceUnavailable
    BillingClient.BillingResponseCode.ERROR -> when (subResponse) {
        SUB_RESPONSE_PAYMENT_DECLINED -> StorePurchaseOutcome.PaymentDeclined
        SUB_RESPONSE_USER_INELIGIBLE -> StorePurchaseOutcome.Ineligible
        else -> StorePurchaseOutcome.StoreProblem
    }
    else ->
        StorePurchaseOutcome.StoreProblem
}
