/// iOS platform implementation of the `rovenue_flutter` federated plugin.
///
/// Wraps the existing Swift façade (`Rovenue` CocoaPods pod,
/// `packages/sdk-swift`) that already sits on top of the shared Rust core
/// (`librovenue`).
library rovenue_flutter_ios;

/// Dart-side plugin registrant required by the federated-plugin
/// `dartPluginClass` mechanism (see `pubspec.yaml`).
///
/// This is intentionally a no-op: `rovenue_flutter_platform_interface`'s
/// default [RovenuePlatform.instance] is already `MethodChannelRovenue`,
/// which talks to the native side purely through the Pigeon-generated
/// `RovenueHostApi`/`RovenueFlutterApi` message channels — channels that
/// are registered natively (`RovenueFlutterIosPlugin.register(with:)`,
/// see `ios/Classes/RovenueFlutterIosPlugin.swift`) the moment the Flutter
/// engine attaches, independent of any Dart-side registration step. There
/// is nothing platform-specific left for the Dart side to wire up.
class RovenueFlutterIos {
  /// Called by the generated plugin registrant. Deliberately empty — see
  /// the class doc comment.
  static void registerWith() {}
}
