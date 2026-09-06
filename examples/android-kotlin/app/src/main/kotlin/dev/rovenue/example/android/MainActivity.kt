// Rovenue Kotlin SDK example app.
//
// Exercises the public `Rovenue` (packages/sdk-kotlin) surface end-to-end,
// mirroring the same flow the Flutter example
// (packages/sdk-flutter/example), the React Native example
// (examples/sample-rn-expo), and the iOS example (examples/ios-swift) all
// demonstrate, so every example app teaches one flow rather than a dialect
// per platform:
//
//   configure -> identify -> offerings -> paywall (RovenuePaywallView)
//   -> purchase -> entitlement reaction -> restore
//
// plus an on-screen event log. See ui/HomeScreen.kt for the flow itself and
// ExampleConfig.kt for the values you edit before pointing this at a real
// project (API key, base URL).
//
// MainActivity is a plain ComponentActivity (not a themed wrapper) — it
// matters here because RovenuePaywallView's purchase flow walks the
// hosting View's Context chain looking for an Activity
// (`Context.findActivity()` in RovenuePaywallView.kt) to launch Play
// Billing. Compose's `AndroidView` inflates its child with this Activity as
// the Context, so that walk always finds it.
package dev.rovenue.example.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import dev.rovenue.example.android.ui.HomeScreen
import dev.rovenue.example.android.ui.RovenueExampleTheme

class MainActivity : ComponentActivity() {
    private val viewModel: HomeViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            RovenueExampleTheme {
                HomeScreen(viewModel = viewModel, activity = this)
            }
        }
    }
}
