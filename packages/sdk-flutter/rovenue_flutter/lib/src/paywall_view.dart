// paywall_view.dart — the native paywall `PlatformView` (Task 7).
//
// Wraps the platform's native builder-paywall renderer (SwiftUI's
// `RovenuePaywallView` on iOS, `dev.rovenue.sdk.paywallui.RovenuePaywallView`
// on Android) inside a Flutter widget. Mirrors the shape of
// `packages/sdk-rn/src/paywall-view/{native-view.ts,RovenuePaywallView.tsx}`
// byte-for-byte at the wire-props level, adapted to Flutter's platform-view
// plumbing (creation params + a per-view `MethodChannel`) instead of Expo's
// prop/event system.
//
// The paywall object never crosses the bridge — only the placement
// identifier the native side re-resolves it with. See
// `.superpowers/sdd/2026-08-30-flutter-sdk/task-7-context.md`'s binding
// invariants.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:rovenue_flutter_platform_interface/rovenue_flutter_platform_interface.dart';

/// The platform-view type both native factories register under (Swift's
/// `PaywallViewFactory` / Kotlin's `PaywallViewFactory`).
const String _kViewType = 'dev.rovenue.flutter/paywall_view';

/// Color-scheme override for [RovenuePaywallView.colorScheme]. `null` (the
/// default) follows the system/device scheme, matching every other façade.
enum RovenueColorScheme { light, dark }

String? _wireColorScheme(RovenueColorScheme? scheme) => switch (scheme) {
      RovenueColorScheme.light => 'light',
      RovenueColorScheme.dark => 'dark',
      null => null,
    };

/// Hosts the native builder-paywall renderer for [placementIdentifier].
///
/// The paywall fills whatever space the parent gives it; size it with a
/// `SizedBox`/`Expanded`/etc. There is deliberately no `style`/decoration
/// prop, matching the RN renderer's public surface.
///
/// ### Updating a live widget instance
///
/// [placementIdentifier], [locale], and [colorScheme] — and whether
/// [onRestore]/[onUrl] are present at all — ARE live-updatable: changing any
/// of them on an existing instance (same [Key]) sends an `updateParams`
/// call over the view's per-instance method channel
/// (`dev.rovenue.flutter/paywall_view_<viewId>`), and the native side
/// re-resolves the paywall only when [placementIdentifier]/[locale]/
/// [colorScheme] actually changed (a pure [onRestore]/[onUrl] handler swap
/// just re-mounts with the new callbacks, no re-fetch). Swapping a callback
/// closure's identity WITHOUT changing whether it is present (e.g.
/// replacing one non-null [onPurchaseCompleted] with another) is picked up
/// automatically too, since `build` always re-reads `widget.onXxx` — no
/// remount needed for that case. If you still want to force a full
/// teardown/rebuild of the native view for any other reason, give the
/// widget a new [Key].
class RovenuePaywallView extends StatefulWidget {
  const RovenuePaywallView({
    super.key,
    required this.placementIdentifier,
    this.locale,
    this.colorScheme,
    this.onPurchaseCompleted,
    this.onPurchaseFailed,
    this.onClose,
    this.onRestore,
    this.onUrl,
  });

  final String placementIdentifier;
  final String? locale;
  final RovenueColorScheme? colorScheme;
  final void Function(PurchaseResult result)? onPurchaseCompleted;
  final void Function(RovenueException error)? onPurchaseFailed;
  final VoidCallback? onClose;

  /// Omit to HIDE restore buttons entirely (e.g. funnel-like contexts). The
  /// native side branches on whether this is present, not just non-null at
  /// call time, so its presence is sent as `hasRestoreHandler` up front.
  final VoidCallback? onRestore;

  /// The renderer never navigates itself — scheme-check before opening.
  /// Presence toggles `hasUrlHandler` the same way [onRestore] does.
  final void Function(String url)? onUrl;

  @override
  State<RovenuePaywallView> createState() => _RovenuePaywallViewState();
}

class _RovenuePaywallViewState extends State<RovenuePaywallView> {
  MethodChannel? _channel;

  Map<String, dynamic> get _creationParams => <String, dynamic>{
        'placementIdentifier': widget.placementIdentifier,
        'locale': widget.locale,
        'colorSchemeOverride': _wireColorScheme(widget.colorScheme),
        'hasRestoreHandler': widget.onRestore != null,
        'hasUrlHandler': widget.onUrl != null,
      };

  void _onPlatformViewCreated(int id) {
    final channel = MethodChannel('${_kViewType}_$id');
    channel.setMethodCallHandler(_handleMethodCall);
    _channel = channel;
  }

  Future<dynamic> _handleMethodCall(MethodCall call) async {
    switch (call.method) {
      case 'onPurchaseCompleted':
        final args = Map<Object?, Object?>.from(call.arguments as Map);
        widget.onPurchaseCompleted?.call(_purchaseResultFrom(args));
        return null;
      case 'onPurchaseFailed':
        final args = Map<Object?, Object?>.from(call.arguments as Map);
        widget.onPurchaseFailed?.call(_exceptionFrom(args));
        return null;
      case 'onCloseRequested':
        widget.onClose?.call();
        return null;
      case 'onRestoreRequested':
        widget.onRestore?.call();
        return null;
      case 'onUrlRequested':
        final args = Map<Object?, Object?>.from(call.arguments as Map);
        widget.onUrl?.call(args['url'] as String);
        return null;
      default:
        return null;
    }
  }

  @override
  void didUpdateWidget(covariant RovenuePaywallView oldWidget) {
    super.didUpdateWidget(oldWidget);
    final channel = _channel;
    if (channel == null) return;
    final needsUpdate = widget.placementIdentifier != oldWidget.placementIdentifier ||
        widget.locale != oldWidget.locale ||
        widget.colorScheme != oldWidget.colorScheme ||
        (widget.onRestore != null) != (oldWidget.onRestore != null) ||
        (widget.onUrl != null) != (oldWidget.onUrl != null);
    if (!needsUpdate) return;
    // Fire-and-forget: the native side applies this on a best-effort basis
    // (see `PaywallPlatformView.swift`/`.kt`'s `updateParams` handler) and
    // there is no meaningful failure the widget can surface here.
    unawaited(channel.invokeMethod<void>('updateParams', _creationParams));
  }

  @override
  void dispose() {
    _channel?.setMethodCallHandler(null);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return AndroidView(
          viewType: _kViewType,
          creationParams: _creationParams,
          creationParamsCodec: const StandardMessageCodec(),
          onPlatformViewCreated: _onPlatformViewCreated,
        );
      case TargetPlatform.iOS:
        return UiKitView(
          viewType: _kViewType,
          creationParams: _creationParams,
          creationParamsCodec: const StandardMessageCodec(),
          onPlatformViewCreated: _onPlatformViewCreated,
        );
      default:
        // No native paywall renderer ships for this platform.
        return const SizedBox.shrink();
    }
  }
}

/// Decodes the `{"result": {...}}` argument `onPurchaseCompleted` sends
/// (built by the native side's `dtoFromPurchaseResult`) into the public
/// [PurchaseResult] model.
PurchaseResult _purchaseResultFrom(Map<Object?, Object?> args) {
  final map = (args['result'] as Map?)?.cast<Object?, Object?>() ?? const <Object?, Object?>{};
  final entitlementsRaw = (map['entitlements'] as List?)?.cast<Object?>() ?? const <Object?>[];
  final virtualCurrenciesRaw =
      (map['virtualCurrencies'] as Map?)?.cast<Object?, Object?>() ?? const <Object?, Object?>{};
  return PurchaseResult(
    entitlements: entitlementsRaw
        .map((e) => _entitlementFrom((e as Map).cast<Object?, Object?>()))
        .toList(growable: false),
    virtualCurrencies: virtualCurrenciesRaw.map(
      (key, value) => MapEntry(key as String, (value as num).toInt()),
    ),
    productId: map['productId'] as String,
    storeTransactionId: map['storeTransactionId'] as String,
    isDeferred: map['isDeferred'] as bool? ?? false,
  );
}

Entitlement _entitlementFrom(Map<Object?, Object?> map) => Entitlement(
      id: map['id'] as String,
      active: map['active'] as bool? ?? false,
      expiresAt: map['expiresAt'] as String?,
      productId: map['productId'] as String?,
    );

/// Decodes `onPurchaseFailed`'s flat error map — `{code, detail, serverCode,
/// httpStatus, retryable}`, the SAME shape used everywhere else in this SDK
/// (see `task-7-context.md`'s binding invariants) — into a typed
/// [RovenueException]. Reuses [rovenueExceptionFrom] by wrapping the map in
/// a synthetic [PlatformException] rather than re-implementing the 24-name
/// kind lookup here, so this can never drift from
/// `rovenue_flutter_platform_interface`'s single source of truth for it.
RovenueException _exceptionFrom(Map<Object?, Object?> args) {
  final code = args['code'] as String? ?? 'Unknown';
  final detail = args['detail'] as String?;
  return rovenueExceptionFrom(
    PlatformException(
      code: code,
      message: detail,
      details: <String, Object?>{
        'detail': detail,
        'serverCode': args['serverCode'] as String?,
        'httpStatus': args['httpStatus'],
        'retryable': args['retryable'] as bool? ?? false,
      },
    ),
  );
}
