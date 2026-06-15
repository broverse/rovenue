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
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.queryProductDetails
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
            .enablePendingPurchases()
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
        val outcome = client.queryProductDetails(params)
        if (outcome.billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
            throw StoreProblemException(
                "queryProductDetails failed ${outcome.billingResult.responseCode}: ${outcome.billingResult.debugMessage}",
            )
        }
        return outcome.productDetailsList?.firstOrNull()
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
