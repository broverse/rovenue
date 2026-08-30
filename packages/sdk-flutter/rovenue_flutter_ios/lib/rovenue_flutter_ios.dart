/// iOS platform implementation of the `rovenue_flutter` federated plugin.
///
/// Wraps the existing Swift façade (`Rovenue` CocoaPods pod,
/// `packages/sdk-swift`) that already sits on top of the shared Rust core
/// (`librovenue`). No public API is implemented yet — this package
/// currently only establishes the federated-plugin skeleton and build
/// tooling.
library rovenue_flutter_ios;
