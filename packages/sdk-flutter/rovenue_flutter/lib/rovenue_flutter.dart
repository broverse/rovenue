/// Rovenue Flutter SDK — subscription, entitlement, and paywall client for
/// the open-source Rovenue backend (RevenueCat/Adapty-style API).
///
/// This is the app-facing package of a federated plugin. It re-exports the
/// shared Dart API defined in `rovenue_flutter_platform_interface`; the
/// actual native work happens in the `rovenue_flutter_ios` and
/// `rovenue_flutter_android` platform packages, which wrap the shared Rust
/// core (`librovenue`) already used by the Swift and Kotlin SDKs.
///
/// No public API is implemented yet — this package currently only
/// establishes the federated-plugin skeleton and build tooling.
library rovenue_flutter;
