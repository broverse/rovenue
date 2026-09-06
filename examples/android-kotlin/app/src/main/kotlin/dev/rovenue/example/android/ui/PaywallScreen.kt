// PaywallScreen.kt — hosts RovenuePaywallView (packages/sdk-kotlin's
// Android-Views paywall renderer, `paywallui`) for the paywall resolved by
// HomeViewModel.resolvePaywall(), wiring all five callbacks to an
// on-screen event log. Mirrors the iOS example's PaywallSheet.swift /
// the Flutter example's PaywallScreen.
//
// NOTE on the shape difference across native SDKs: the iOS SDK's
// RovenuePaywallView (SwiftUI) and this Kotlin one both take an
// ALREADY-RESOLVED `Paywall` — the caller resolves the placement first
// (via `getPaywall`) and hands the result in. The Flutter SDK's paywall
// widget instead takes a placement identifier and resolves it internally.
// packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/
// RovenuePaywallView.kt confirms this directly: it's a plain
// `FrameLayout` (100% Android Views, no Compose) with a single
// `bind(paywall: Paywall, options: PaywallViewOptions)` method — no
// placement-identifier constructor exists.
package dev.rovenue.example.android.ui

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.rovenue.example.android.HomeViewModel
import dev.rovenue.sdk.Paywall
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.paywallui.PaywallViewOptions
import dev.rovenue.sdk.paywallui.RovenuePaywallView

@Composable
fun PaywallScreen(
    paywall: Paywall,
    viewModel: HomeViewModel,
    activity: Activity,
    onDismiss: () -> Unit,
) {
    val events = remember { mutableStateListOf<String>() }
    fun logEvent(line: String) {
        events.add(0, line)
        viewModel.appendLog("paywall: $line")
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Box(modifier = Modifier.weight(1f)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context -> RovenuePaywallView(context) },
                update = { view ->
                    view.bind(
                        paywall,
                        PaywallViewOptions(
                            onPurchaseCompleted = { result ->
                                logEvent("onPurchaseCompleted: ${result.productId}")
                                viewModel.loadOfferings()
                            },
                            onPurchaseFailed = { error ->
                                if (error is RovenueException) {
                                    logEvent("onPurchaseFailed: RovenueException(${error.kind}): ${error.message}")
                                } else {
                                    logEvent("onPurchaseFailed: $error")
                                }
                            },
                            onClose = {
                                logEvent("onClose")
                                onDismiss()
                            },
                            onRestore = {
                                logEvent("onRestore")
                                viewModel.restore(activity)
                            },
                            onUrl = { url -> logEvent("onUrl: $url") },
                        ),
                    )
                },
            )
        }

        HorizontalDivider()

        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .height(120.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .padding(8.dp),
        ) {
            items(events) { line ->
                Text(line, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
