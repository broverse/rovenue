// Rovenue Swift SDK example app.
//
// Exercises the public `Rovenue` (packages/sdk-swift) surface end-to-end,
// mirroring the same flow the Flutter example (packages/sdk-flutter/example)
// and the React Native example (examples/sample-rn-expo) demonstrate, so all
// three example apps teach one flow rather than three dialects:
//
//   configure -> identify -> offerings -> paywall (RovenuePaywallView)
//   -> purchase -> entitlement reaction -> restore
//
// plus an on-screen event log. See ContentView.swift for the flow itself and
// Config.swift for the two values you edit before pointing this at a real
// project (API key, base URL).
import SwiftUI

@main
struct RovenueExampleApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
