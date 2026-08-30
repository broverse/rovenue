// End-to-end smoke test for the Rovenue Flutter example app (Task 8, Step
// 2). Runs headless via `flutter test integration_test/smoke_test.dart` —
// NOT `flutter drive`/device mode — so it needs no network, no store, and
// no simulator/emulator: a fake `RovenuePlatform` is installed BEFORE
// `runApp` (mirroring how `rovenue_flutter`'s own unit tests swap
// `RovenuePlatform.instance`), and `RovenuePaywallView` builds its
// `AndroidView`/`UiKitView` — which Flutter's widget-test harness already
// virtualizes without a real platform, exactly as `paywall_view_test.dart`
// in `rovenue_flutter` demonstrates — instead of touching any real native
// code.
//
// Asserts:
//  1. The widget tree builds against the fake platform.
//  2. The fake's entitlement is rendered on the home screen.
//  3. Navigating to the paywall route mounts a `RovenuePaywallView`, whose
//     `build()` produces a `PlatformViewLink` (the widget both
//     `AndroidView` and `UiKitView` build under the hood).
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:rovenue_flutter/rovenue_flutter.dart';
import 'package:rovenue_flutter_example/main.dart';
import 'package:rovenue_flutter_platform_interface/rovenue_flutter_platform_interface.dart';

/// Minimal `RovenuePlatform` fake — only the members the example app's
/// `initState`/build path actually calls are overridden; everything else
/// keeps the base class's `UnimplementedError`, which is fine as long as
/// this smoke test never exercises it (it doesn't tap "Purchase").
class _FakeRovenuePlatform extends RovenuePlatform {
  @override
  Future<void> configure({
    required String apiKey,
    String? baseUrl,
    RovenueLogLevel logLevel = RovenueLogLevel.warn,
    String? appVersion,
    String? environment,
  }) async {}

  @override
  Future<List<Entitlement>> entitlementsAll() async => const <Entitlement>[
        Entitlement(id: 'pro', active: true, productId: 'com.rovenue.pro.monthly'),
      ];

  @override
  Future<Offerings> getOfferings() async => const Offerings(
        current: 'default',
        offerings: <Offering>[
          Offering(
            identifier: 'default',
            isDefault: true,
            packages: <RovenuePackage>[
              RovenuePackage(
                identifier: 'monthly',
                packageType: PackageType.monthly,
                product: StoreProduct(
                  id: 'com.rovenue.pro.monthly',
                  type: ProductType.subscription,
                  productCategory: ProductCategory.subscription,
                  displayName: 'Pro Monthly',
                  priceString: r'$4.99',
                  isFamilyShareable: false,
                  discounts: <Discount>[],
                ),
              ),
            ],
          ),
        ],
      );

  @override
  Stream<RovenueChangeEvent> get changes => const Stream<RovenueChangeEvent>.empty();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  setUp(() {
    RovenuePlatform.instance = _FakeRovenuePlatform();
    // No real native platform exists in this headless run — mock both the
    // `create`/`dispose` calls `AndroidView`/`UiKitView` send under the
    // hood: `platform_views` (same channel + pattern `rovenue_flutter`'s
    // own `paywall_view_test.dart` uses for `create`) AND
    // `platform_views_2` (the newer Hybrid Composition v2 channel
    // `AndroidViewController.dispose` uses when the view is torn down at
    // the end of the test) — otherwise either leaks a
    // `MissingPluginException` that fails the test after it "completes".
    messenger.setMockMethodCallHandler(SystemChannels.platform_views, (call) async => null);
    messenger.setMockMethodCallHandler(SystemChannels.platform_views_2, (call) async => null);
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(SystemChannels.platform_views, null);
    messenger.setMockMethodCallHandler(SystemChannels.platform_views_2, null);
  });

  testWidgets(
    'boots against a fake platform, renders entitlements, and mounts the paywall route',
    (tester) async {
      // `RovenuePaywallView.build()` switches on `defaultTargetPlatform`
      // and only produces an `AndroidView`/`UiKitView` for android/iOS —
      // on this host (`flutter-tester` on macOS) that otherwise resolves
      // to macOS, which renders nothing. Must be set AND reset inside this
      // same `testWidgets` callback (mirrors
      // `rovenue_flutter/test/paywall_view_test.dart`): the binding
      // asserts every foundation debug var is back to its default the
      // instant the callback returns, which is too late for a plain
      // top-level `tearDown()`.
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        await tester.pumpWidget(const RovenueExampleApp());
        await tester.pumpAndSettle();

        // The fake's entitlement rendered on the home screen.
        expect(find.text('pro'), findsOneWidget);
        expect(find.textContaining('active: true'), findsOneWidget);

        // The fake's offering rendered as a purchasable product.
        expect(find.text('Pro Monthly'), findsOneWidget);

        // Navigate to the paywall route.
        await tester.tap(find.text('Open paywall (onboarding)'));
        await tester.pumpAndSettle();

        expect(find.byType(RovenuePaywallView), findsOneWidget);
        // On the currently-pinned Flutter (3.47.2), `AndroidView`/
        // `UiKitView` build a private `_AndroidPlatformView`/
        // `_UiKitPlatformView` internally, NOT a `PlatformViewLink` (that
        // class is only used by widgets that hand-roll the platform-view
        // creation/surface plumbing themselves, e.g. `google_maps_flutter`
        // — verified by reading `package:flutter/src/widgets/
        // platform_view.dart`'s `_AndroidViewState`/`_UiKitViewState.build`
        // in this checkout). Assert on the public `AndroidView` type
        // (forced above via `debugDefaultTargetPlatformOverride`) instead,
        // which is the accurate, exported equivalent of "mounts a native
        // platform view host widget" for this Flutter version.
        expect(find.byType(AndroidView), findsOneWidget);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );
}
