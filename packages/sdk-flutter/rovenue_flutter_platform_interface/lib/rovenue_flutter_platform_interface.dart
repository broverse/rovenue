/// Common platform interface for the `rovenue_flutter` federated plugin.
///
/// Defines the Dart-level contract that `rovenue_flutter_ios` and
/// `rovenue_flutter_android` each implement by wrapping the shared Rust
/// core (`librovenue`) through their native `Rovenue`/`dev.rovenue:sdk`
/// libraries. The app-facing `rovenue_flutter` package depends on this
/// package and dispatches through `RovenuePlatform.instance`.
///
/// Exports the public surface only: [RovenuePlatform] itself, its default
/// [MethodChannelRovenue] implementation, the public data models
/// (`models.dart`), and the typed error mapping (`errors.dart`). The
/// generated Pigeon contract (`messages.g.dart`, the `Rv*` DTOs) is
/// intentionally NOT exported — it is an implementation detail of
/// [MethodChannelRovenue] and must never leak to app code.
library rovenue_flutter_platform_interface;

export 'src/errors.dart';
export 'src/method_channel_rovenue.dart';
export 'src/models.dart';
export 'src/rovenue_platform.dart';
