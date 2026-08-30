/// Common platform interface for the `rovenue_flutter` federated plugin.
///
/// Defines the Dart-level contract that `rovenue_flutter_ios` and
/// `rovenue_flutter_android` each implement by wrapping the shared Rust
/// core (`librovenue`) through their native `Rovenue`/`dev.rovenue:sdk`
/// libraries. The app-facing `rovenue_flutter` package depends on this
/// package and dispatches through `RovenueFlutterPlatform.instance`.
///
/// No public API is implemented yet — this package currently only
/// establishes the federated-plugin skeleton and build tooling.
library rovenue_flutter_platform_interface;
