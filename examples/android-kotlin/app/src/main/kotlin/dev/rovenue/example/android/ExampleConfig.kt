// ExampleConfig.kt — Rovenue SDK example configuration.
//
// EDIT THESE VALUES before pointing this app at a real project.
//
// `apiKey` is a placeholder public key (the same convention the Flutter,
// React Native, and iOS examples use) — every SDK call in this app is
// wrapped in try/catch and its outcome (success or failure) is appended to
// the on-screen log, so the app stays useful to poke at even without a live
// backend or a real key.
//
// `baseUrl` depends on WHERE this app is running:
//   - Android Emulator — the emulator does NOT share the host's network
//     namespace the way the iOS Simulator does. `10.0.2.2` is the
//     emulator's special alias for the host loopback interface, so
//     `http://10.0.2.2:3000` reaches a `docker compose up` API running on
//     your dev machine. Using `localhost` here would resolve to the
//     emulator itself, not your machine — a classic Android footgun. This
//     is the default below.
//   - Physical device — `10.0.2.2` only exists inside the emulator. On a
//     real device, point `baseUrl` at your machine's LAN IP instead, e.g.
//     `http://192.168.1.23:3000`, with the device on the same network.
//   - A real deployment — use `https://` (e.g. `https://edge.rovenue.io`)
//     and set `baseUrl = null` to fall back to the SDK's compiled-in
//     default, or pass the real HTTPS URL explicitly.
//
// Plain `http://` (no TLS) is blocked by Android's cleartext-traffic policy
// by default. This project's AndroidManifest.xml carries a narrow
// `networkSecurityConfig` exception (res/xml/network_security_config.xml)
// that allows insecure loads to the single host `10.0.2.2` only — Android's
// analogue of the iOS example's ATS exception for `localhost`. That
// exception is a local-dev convenience — a shipped app talking to a real
// (HTTPS) Rovenue deployment does not need it and should not keep it.
package dev.rovenue.example.android

object ExampleConfig {
    /** Placeholder public API key. Replace with a real project key from
     *  your Rovenue dashboard to exercise this app against a live backend. */
    const val apiKey: String = "rov_pub_example_public_key"

    /** `null` uses the SDK's compiled-in default (`https://api.rovenue.io`).
     *  Set to your local API's URL for local development — see the
     *  emulator-vs-device comment above. */
    val baseUrl: String? = "http://10.0.2.2:3000"

    /** The placement this example resolves and shows via
     *  `RovenuePaywallView`. Change to match a placement configured in your
     *  project's dashboard. */
    const val placementIdentifier: String = "onboarding"
}
