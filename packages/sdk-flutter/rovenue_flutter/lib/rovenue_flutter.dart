/// Rovenue Flutter SDK — subscription, entitlement, and paywall client for
/// the open-source Rovenue backend (RevenueCat/Adapty-style API).
///
/// This is the app-facing package of a federated plugin. It re-exports the
/// shared Dart API defined in `rovenue_flutter_platform_interface`; the
/// actual native work happens in the `rovenue_flutter_ios` and
/// `rovenue_flutter_android` platform packages, which wrap the shared Rust
/// core (`librovenue`) already used by the Swift and Kotlin SDKs.
///
/// Use the [Rovenue.instance] singleton. `RovenuePaywallView` hosts the
/// native builder-paywall renderer (SwiftUI on iOS, Android Views on
/// Android) as a platform view — see `src/paywall_view.dart`.
library rovenue_flutter;

export 'src/funnel_token.dart' show extractFunnelToken;
export 'src/paywall_view.dart' show RovenueColorScheme, RovenuePaywallView;
export 'src/rovenue.dart' show Rovenue;
export 'src/types.dart';
