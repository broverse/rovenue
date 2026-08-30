// Failing-tests-first coverage for the app-facing `Rovenue` façade (Task 6,
// Step 1). Installs a fake `RovenuePlatform` (a hand-written subclass, per
// the brief — no mocking package needed since `RovenuePlatform`'s default
// constructor already chains through `PlatformInterface`'s token check) via
// `RovenuePlatform.instance = fake` and asserts the façade's contract:
//  - purchase(product, option: opt) forwards the five underlying fields.
//  - entitlementsAll() passes platform models through unchanged.
//  - changes yields events from the fake and two simultaneous listeners
//    share one underlying subscription.
//  - a thrown RovenueException propagates unwrapped (no re-wrapping).
//  - funnelClaims replay decision (see rovenue.dart's doc comments): a
//    late-joining second listener still receives the most recent claim.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:rovenue_flutter/rovenue_flutter.dart';
import 'package:rovenue_flutter_platform_interface/rovenue_flutter_platform_interface.dart';

void main() {
  late _FakeRovenuePlatform fake;
  late Rovenue rovenue;

  setUp(() {
    fake = _FakeRovenuePlatform();
    RovenuePlatform.instance = fake;
    rovenue = Rovenue.instance;
  });

  tearDown(() {
    fake.dispose();
  });

  group('purchase()', () {
    const product = StoreProduct(
      id: 'com.app.pro.monthly',
      type: ProductType.subscription,
      productCategory: ProductCategory.subscription,
      displayName: 'Pro Monthly',
      isFamilyShareable: false,
      discounts: <Discount>[],
    );

    test('forwards productId, productType, promotionalOfferId, basePlanId, offerId', () async {
      const option = SubscriptionOption(
        id: 'opt',
        basePlanId: 'monthly-plan',
        offerId: 'intro-offer',
        tags: <String>[],
        isBasePlan: true,
        isPrepaid: false,
        pricingPhases: <PricingPhase>[],
      );

      await rovenue.purchase(product, promotionalOfferId: 'promo1', option: option);

      expect(fake.capturedProductId, 'com.app.pro.monthly');
      expect(fake.capturedProductType, ProductType.subscription);
      expect(fake.capturedPromotionalOfferId, 'promo1');
      expect(fake.capturedBasePlanId, 'monthly-plan');
      expect(fake.capturedOfferId, 'intro-offer');
    });

    test('omits basePlanId/offerId when no option is given', () async {
      await rovenue.purchase(product);

      expect(fake.capturedProductId, product.id);
      expect(fake.capturedPromotionalOfferId, isNull);
      expect(fake.capturedBasePlanId, isNull);
      expect(fake.capturedOfferId, isNull);
    });
  });

  test('entitlementsAll() passes the platform models through unchanged', () async {
    fake.entitlementsAllResult = const <Entitlement>[
      Entitlement(id: 'pro', active: true, expiresAt: '2030-01-01T00:00:00Z', productId: 'com.app.pro'),
      Entitlement(id: 'trial', active: false),
    ];

    final result = await rovenue.entitlementsAll();

    expect(result, fake.entitlementsAllResult);
  });

  test('a thrown RovenueException propagates unwrapped (no re-wrapping)', () async {
    await expectLater(
      rovenue.entitlement('missing'),
      throwsA(isA<RovenueException>().having((e) => e.kind, 'kind', RovenueErrorKind.notFound)),
    );
  });

  group('changes stream', () {
    test(
        'yields events from the fake and two simultaneous listeners share one underlying '
        'subscription', () async {
      final receivedA = <RovenueChangeEvent>[];
      final receivedB = <RovenueChangeEvent>[];

      final subA = rovenue.changes.listen(receivedA.add);
      final subB = rovenue.changes.listen(receivedB.add);

      expect(fake.changesAccessCount, 1,
          reason: 'both Dart-side listeners must share one underlying platform subscription');

      const event = RovenueChangeEvent(kind: RovenueChangeKind.entitlementsChanged);
      fake.emitChange(event);
      await Future<void>.delayed(Duration.zero);

      expect(receivedA, <RovenueChangeEvent>[event]);
      expect(receivedB, <RovenueChangeEvent>[event]);

      await subA.cancel();
      await subB.cancel();
    });
  });

  group('funnelClaims stream — replay decision', () {
    // Decision (see rovenue.dart doc comments): funnelClaims gets
    // last-value replay because a resolved claim's payload (subscriber id +
    // collected funnel answers) cannot be reconstructed from any other API
    // once missed — unlike `changes`/`logs`, which stay plain broadcast
    // because their target state is always re-readable on demand.
    test('a late-joining second listener still receives the most recent claim', () async {
      final receivedFirst = <FunnelClaim>[];
      final subFirst = rovenue.funnelClaims.listen(receivedFirst.add);

      const claim = FunnelClaim(subscriberId: 'sub_1', funnelAnswersJson: '{"q1":"yes"}');
      fake.emitFunnelClaim(claim);
      await Future<void>.delayed(Duration.zero);
      expect(receivedFirst, <FunnelClaim>[claim]);

      // Attaches AFTER the claim already fired — without replay this
      // listener would see nothing, and a funnel claim cannot be re-fetched
      // any other way.
      final receivedSecond = <FunnelClaim>[];
      final subSecond = rovenue.funnelClaims.listen(receivedSecond.add);
      await Future<void>.delayed(Duration.zero);

      expect(receivedSecond, <FunnelClaim>[claim]);
      expect(fake.funnelClaimsAccessCount, 1, reason: 'still one underlying platform subscription');

      await subFirst.cancel();
      await subSecond.cancel();
    });
  });
}

/// Hand-written fake `RovenuePlatform` (per the brief — a real subclass, not
/// a generated mock) that records calls and lets tests drive the streams
/// directly.
class _FakeRovenuePlatform extends RovenuePlatform {
  String? capturedProductId;
  ProductType? capturedProductType;
  String? capturedPromotionalOfferId;
  String? capturedBasePlanId;
  String? capturedOfferId;

  PurchaseResult purchaseResultToReturn = const PurchaseResult(
    entitlements: <Entitlement>[],
    virtualCurrencies: <String, int>{},
    productId: 'com.app.pro.monthly',
    storeTransactionId: 'txn_1',
    isDeferred: false,
  );

  @override
  Future<PurchaseResult> purchase(
    String productId,
    ProductType productType, {
    String? promotionalOfferId,
    String? basePlanId,
    String? offerId,
  }) async {
    capturedProductId = productId;
    capturedProductType = productType;
    capturedPromotionalOfferId = promotionalOfferId;
    capturedBasePlanId = basePlanId;
    capturedOfferId = offerId;
    return purchaseResultToReturn;
  }

  List<Entitlement> entitlementsAllResult = const <Entitlement>[];

  @override
  Future<List<Entitlement>> entitlementsAll() async => entitlementsAllResult;

  @override
  Future<Entitlement?> entitlement(String id) async {
    throw const RovenueException(kind: RovenueErrorKind.notFound, detail: 'not found');
  }

  int changesAccessCount = 0;
  final StreamController<RovenueChangeEvent> _changesController =
      StreamController<RovenueChangeEvent>.broadcast();

  @override
  Stream<RovenueChangeEvent> get changes {
    changesAccessCount++;
    return _changesController.stream;
  }

  void emitChange(RovenueChangeEvent event) => _changesController.add(event);

  int funnelClaimsAccessCount = 0;
  final StreamController<FunnelClaim> _funnelClaimsController = StreamController<FunnelClaim>.broadcast();

  @override
  Stream<FunnelClaim> get funnelClaims {
    funnelClaimsAccessCount++;
    return _funnelClaimsController.stream;
  }

  void emitFunnelClaim(FunnelClaim claim) => _funnelClaimsController.add(claim);

  void dispose() {
    _changesController.close();
    _funnelClaimsController.close();
  }
}
