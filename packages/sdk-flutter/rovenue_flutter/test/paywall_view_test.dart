// Failing-tests-first coverage for the native paywall PlatformView (Task 7,
// Step 1). Two things are load-bearing here and are what the native side
// must honor byte-for-byte:
//
//  1. Creation params sent to the platform view are EXACTLY the five keys
//     `{placementIdentifier, locale, colorSchemeOverride, hasRestoreHandler,
//     hasUrlHandler}` — no paywall object, no offering. Intercepted via
//     `TestDefaultBinaryMessengerBinding` on `SystemChannels.platform_views`
//     (the same channel `AndroidView`/`UiKitView` use internally to send
//     the `create` call — see `flutter/lib/src/services/platform_views.dart`),
//     decoding the raw `params` bytes with the same `StandardMessageCodec`
//     the widget declares as its `creationParamsCodec`.
//  2. The per-view callback channel's `onPurchaseFailed` message carries the
//     flat `{code, detail, serverCode, httpStatus, retryable}` error map (the
//     same shape used everywhere else in this SDK — see Mapping.swift/
//     Mapping.kt's `fail()`), and the widget's `onPurchaseFailed` callback
//     must receive a typed `RovenueException`, never a raw
//     `PlatformException` or a bare string.
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rovenue_flutter/rovenue_flutter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() {
    messenger.setMockMethodCallHandler(SystemChannels.platform_views, null);
  });

  testWidgets('creation params are exactly the five keys, reflecting handler presence', (tester) async {
    // `debugDefaultTargetPlatformOverride` must be set AND reset inside this
    // same testWidgets callback: `TestWidgetsFlutterBinding` asserts every
    // foundation debug var is back to its default the instant the callback
    // returns — a plain top-level `tearDown()` runs too late (package:test
    // schedules it after this whole function returns, well after that
    // check already ran) and fails the test with an unrelated invariant
    // error, not the assertions below.
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(SystemChannels.platform_views, (call) async {
        calls.add(call);
        return null;
      });

      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: RovenuePaywallView(
            placementIdentifier: 'onboarding',
            onRestore: () {},
            // onUrl deliberately omitted.
          ),
        ),
      );

      final create = calls.singleWhere((c) => c.method == 'create');
      final args = (create.arguments as Map).cast<Object?, Object?>();
      final rawParams = args['params'] as Uint8List;
      final byteData = ByteData.sublistView(rawParams);
      final decoded =
          (const StandardMessageCodec().decodeMessage(byteData) as Map).cast<Object?, Object?>();

      expect(decoded.keys.toSet(), <String>{
        'placementIdentifier',
        'locale',
        'colorSchemeOverride',
        'hasRestoreHandler',
        'hasUrlHandler',
      });
      expect(decoded['placementIdentifier'], 'onboarding');
      expect(decoded['locale'], isNull);
      expect(decoded['colorSchemeOverride'], isNull);
      expect(decoded['hasRestoreHandler'], isTrue);
      expect(decoded['hasUrlHandler'], isFalse);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('onPurchaseFailed through the per-view channel yields a RovenueException', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      int? viewId;
      messenger.setMockMethodCallHandler(SystemChannels.platform_views, (call) async {
        if (call.method == 'create') {
          viewId = ((call.arguments as Map).cast<Object?, Object?>())['id'] as int;
        }
        return null;
      });

      Object? received;
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: RovenuePaywallView(
            placementIdentifier: 'onboarding',
            onPurchaseFailed: (error) => received = error,
          ),
        ),
      );

      expect(viewId, isNotNull);
      final channelName = 'dev.rovenue.flutter/paywall_view_$viewId';
      const codec = StandardMethodCodec();
      final message = codec.encodeMethodCall(const MethodCall('onPurchaseFailed', <String, Object?>{
        'code': 'PurchaseCanceled',
        'detail': 'user canceled the sheet',
        'serverCode': null,
        'httpStatus': null,
        'retryable': false,
      }));

      await messenger.handlePlatformMessage(channelName, message, (ByteData? _) {});

      expect(received, isNotNull);
      expect(received, isNot(isA<PlatformException>()));
      final exception = received! as RovenueException;
      expect(exception.kind, RovenueErrorKind.purchaseCanceled);
      expect(exception.detail, 'user canceled the sheet');
      expect(exception.retryable, isFalse);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });
}
