// Config.swift — Rovenue SDK example configuration.
//
// EDIT THESE TWO VALUES before pointing this app at a real project.
//
// `apiKey` is a placeholder public key (the same convention the Flutter and
// React Native examples use) — every SDK call in this app is wrapped in
// do/catch and its outcome (success or failure) is appended to the
// on-screen log, so the app stays useful to poke at even without a live
// backend or a real key.
//
// `baseURL` depends on WHERE this app is running:
//   • iOS Simulator — the simulator shares the Mac's network stack, so
//     `http://localhost:3000` reaches a `docker compose up` API running on
//     the host machine directly. This is the default below.
//   • Physical device — on a device, `localhost` means the device itself,
//     not your Mac. Point `baseURL` at your Mac's LAN IP instead, e.g.
//     `http://192.168.1.23:3000`, and make sure the device is on the same
//     network as the API.
//   • A real deployment — use `https://` (e.g. `https://edge.rovenue.io`)
//     and set `baseURL = nil` to fall back to the SDK's compiled-in
//     default, or pass the real HTTPS URL explicitly.
//
// Plain `http://` (no TLS) is blocked by App Transport Security by default.
// This project's Info.plist carries a narrow `NSAppTransportSecurity`
// exception that allows insecure loads to the single host `localhost` only
// (see `NSExceptionDomains` → `localhost` → `NSExceptionAllowsInsecureHTTPLoads`).
// That exception is a local-dev convenience — a shipped app talking to a
// real (HTTPS) Rovenue deployment does not need it and should not keep it.
enum ExampleConfig {
    /// Placeholder public API key. Replace with a real project key from
    /// your Rovenue dashboard to exercise this app against a live backend.
    static let apiKey = "rov_pub_example_public_key"

    /// `nil` uses the SDK's compiled-in default (`https://api.rovenue.io`).
    /// Set to your local API's URL for local development — see the comment
    /// above for the simulator-vs-device distinction.
    static let baseURL: String? = "http://localhost:3000"

    /// The placement this example resolves and shows via
    /// `RovenuePaywallView`. Change to match a placement configured in your
    /// project's dashboard.
    static let placementIdentifier = "onboarding"
}
