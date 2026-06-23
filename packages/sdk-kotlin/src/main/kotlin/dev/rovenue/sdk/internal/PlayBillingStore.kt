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
import dev.rovenue.sdk.StoreProblemException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class PlayBillingStore(private val context: Context) : PlayStore {

    // The PurchasesUpdatedListener fires asynchronously after launchBillingFlow.
    // We hold the in-flight continuation here and resume it from the listener.
    @Volatile
    private var pending: Continuation<StorePurchaseOutcome>? = null

    private val purchasesListener = PurchasesUpdatedListener { result, purchases ->
        val cont = pending ?: return@PurchasesUpdatedListener
        pending = null
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                val purchase = purchases?.firstOrNull()
                if (purchase == null) {
                    cont.resume(StorePurchaseOutcome.ProductNotFound)
                } else when (purchase.purchaseState) {
                    Purchase.PurchaseState.PURCHASED ->
                        cont.resume(successFor(purchase))
                    Purchase.PurchaseState.PENDING ->
                        cont.resume(StorePurchaseOutcome.Pending)
                    else ->
                        cont.resume(StorePurchaseOutcome.Pending)
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED ->
                cont.resume(StorePurchaseOutcome.UserCancelled)
            BillingClient.BillingResponseCode.ITEM_UNAVAILABLE ->
                cont.resume(StorePurchaseOutcome.ProductNotFound)
            else ->
                cont.resumeWithException(StoreProblemException("billing error ${result.responseCode}: ${result.debugMessage}"))
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
    ): StorePurchaseOutcome {
        pendingType = productType
        val client = connect()
        val details = queryDetails(client, productId, productType)
            ?: return StorePurchaseOutcome.ProductNotFound

        val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .apply {
                // Subscriptions require an offer token; pick the first base plan.
                if (productType == ProductType.SUBSCRIPTION) {
                    details.subscriptionOfferDetails?.firstOrNull()?.offerToken?.let {
                        setOfferToken(it)
                    }
                }
            }
            .build()

        val flowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(productParams))
            .apply { obfuscatedAccountId?.let { setObfuscatedAccountId(it) } }
            .build()

        return suspendCancellableCoroutine { cont ->
            pending = cont
            cont.invokeOnCancellation { pending = null }
            val launch = client.launchBillingFlow(activity, flowParams)
            if (launch.responseCode != BillingClient.BillingResponseCode.OK) {
                pending = null
                cont.resumeWithException(
                    StoreProblemException("launchBillingFlow failed ${launch.responseCode}: ${launch.debugMessage}"),
                )
            }
        }
    }

    override suspend fun queryPrices(
        productIds: List<String>,
        subscriptionIds: List<String>,
    ): Map<String, PriceInfo> {
        if (productIds.isEmpty() && subscriptionIds.isEmpty()) return emptyMap()
        val client = connect()
        val out = mutableMapOf<String, PriceInfo>()
        if (productIds.isNotEmpty()) {
            queryDetailsBatch(client, productIds, BillingClient.ProductType.INAPP).forEach { details ->
                inappPrice(details)?.let { out[details.productId] = it }
            }
        }
        if (subscriptionIds.isNotEmpty()) {
            queryDetailsBatch(client, subscriptionIds, BillingClient.ProductType.SUBS).forEach { details ->
                subsPrice(details)?.let { out[details.productId] = it }
            }
        }
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

    private fun inappPrice(details: ProductDetails): PriceInfo? {
        val offer = details.oneTimePurchaseOfferDetails ?: return null
        return PriceInfo(
            priceString = offer.formattedPrice,
            price = offer.priceAmountMicros / 1_000_000.0,
            currencyCode = offer.priceCurrencyCode,
        )
    }

    private fun subsPrice(details: ProductDetails): PriceInfo? {
        // First base-plan offer, first pricing phase — the headline recurring price.
        val phase = details.subscriptionOfferDetails
            ?.firstOrNull()
            ?.pricingPhases
            ?.pricingPhaseList
            ?.firstOrNull()
            ?: return null
        return PriceInfo(
            priceString = phase.formattedPrice,
            price = phase.priceAmountMicros / 1_000_000.0,
            currencyCode = phase.priceCurrencyCode,
        )
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
                val c = client ?: throw StoreProblemException("billing client gone")
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
                            StoreProblemException("billing setup failed ${result.responseCode}: ${result.debugMessage}"),
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
                        StoreProblemException("queryProductDetails failed ${result.responseCode}: ${result.debugMessage}"),
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
                        StoreProblemException("queryPurchases failed ${result.responseCode}: ${result.debugMessage}"),
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
                        StoreProblemException("consume failed ${result.responseCode}: ${result.debugMessage}"),
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
                        StoreProblemException("acknowledge failed ${result.responseCode}: ${result.debugMessage}"),
                    )
                }
            }
        }
}
