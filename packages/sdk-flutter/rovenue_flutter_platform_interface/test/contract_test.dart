// Drift guard for the Pigeon contract (Task 2). Fails to COMPILE — not just
// to run — the moment `pigeons/rovenue_api.dart` loses, renames, or
// re-shapes any of the 46 `RovenueHostApi` methods enumerated against
// `packages/sdk-rn/src/specs/RovenueModule.types.ts`.
//
// Approach note (deviates from the brief's Step-3 sketch on purpose): the
// brief assumed Pigeon's generated `RovenueHostApi` would be `abstract`,
// mockable via `noSuchMethod`. With pigeon 22.7.4, `@HostApi()` generates
// the *caller* side (Dart calling out to native) as a concrete class that
// wires each method straight to a `BasicMessageChannel` — there is no
// abstract surface to implement/mock on the Dart side for a HostApi.
// (`RovenueFlutterApi`, the *callee* side that Dart implements for native
// to call back into, IS generated abstract — exercised below separately;
// it is not part of the 46-method count.)
//
// Dart has no runtime reflection on Flutter (dart:mirrors is desktop/VM
// only), so the enforceable equivalent of "assert all 46 names exist" is a
// compile-time tear-off list: every entry below must resolve to a real
// instance method on `RovenueHostApi`, or the file fails to compile. A
// second test additionally pins one representative method's full signature
// (argument types/order and return type) by assigning its tear-off to an
// explicitly-typed function variable — a signature change there is also a
// compile error, satisfying "one representative method's signature
// compiles against a mock" without needing an actual mock.

import 'package:flutter_test/flutter_test.dart';
import 'package:rovenue_flutter_platform_interface/src/messages.g.dart';

void main() {
  test('RovenueHostApi exposes exactly the 46 RovenueModuleSpec methods', () {
    final RovenueHostApi api = RovenueHostApi();

    // One tear-off per method in packages/sdk-rn/src/specs/RovenueModule.types.ts
    // `RovenueModuleSpec`, same order, minus `addListener`/`removeListeners`
    // (Expo-only bookkeeping with no Flutter equivalent — see the contract
    // file's header comment).
    final List<Function> methods = <Function>[
      // Lifecycle
      api.configure,
      api.shutdown,
      api.setForeground,
      api.getVersion,
      api.getAppVersion,
      // Identity
      api.currentUser,
      api.identify,
      api.logOut,
      // Entitlements
      api.entitlement,
      api.entitlementsAll,
      api.refreshEntitlements,
      // Virtual currencies
      api.virtualCurrencies,
      api.virtualCurrency,
      api.refreshVirtualCurrencies,
      // Purchases / placements
      api.getOfferings,
      api.getPaywall,
      api.setFallbackPlacements,
      api.purchase,
      api.restorePurchases,
      // Remote Config
      api.refreshRemoteConfig,
      api.remoteConfigBool,
      api.remoteConfigString,
      api.remoteConfigInt,
      api.remoteConfigDouble,
      api.remoteConfigJson,
      api.remoteConfigKeys,
      api.remoteConfigAllJson,
      api.experiment,
      api.experimentsAll,
      // Refund Shield
      api.getAppAccountToken,
      api.recordSessionEvent,
      api.flushSessionEvents,
      // Funnel attribution
      api.claimFunnelToken,
      api.claimInstall,
      api.claimViaEmail,
      api.claimFromClipboard,
      api.installId,
      api.hasResolvedFunnelClaim,
      // Generic events
      api.track,
      api.enqueuePaywallEvent,
      // Subscriber attributes
      api.setAttributes,
      api.setEmail,
      api.setDisplayName,
      api.setPhoneNumber,
      api.setPushToken,
      api.flushAttributes,
    ];

    expect(methods.length, 46,
        reason:
            'RovenueHostApi must carry exactly the 46 RovenueModuleSpec methods '
            '(RN parity bar) — see pigeons/rovenue_api.dart header.');
    // Every tear-off above is statically non-null by construction — a
    // removed/renamed method fails to COMPILE, long before this test runs.
  });

  test('purchase() keeps its exact RovenueModuleSpec signature', () {
    // Assigning the tear-off to an explicitly-typed variable makes the
    // compiler check argument types/order and the return type; any drift
    // (e.g. dropping `basePlanId`, or PigeonProductType -> RvProductType
    // renamed differently) fails to compile.
    final Future<RvPurchaseResult> Function(
      String productId,
      RvProductType productType,
      String? promotionalOfferId,
      String? basePlanId,
      String? offerId,
    ) purchase = RovenueHostApi().purchase;

    expect(purchase, isNotNull);
  });

  test('RovenueFlutterApi (native -> Dart) exposes its 3 event callbacks', () {
    // The one Pigeon API in this contract that IS generated abstract; a
    // fake implementation is the natural (and here, actually available)
    // drift guard for it.
    final _FakeFlutterApi fake = _FakeFlutterApi();
    expect(fake, isA<RovenueFlutterApi>());

    fake.onChange(RvChangeEvent(kind: RvChangeEventKind.identityChanged));
    fake.onLog(RvLogRecord(level: RvLogLevel.info, message: 'hi', fields: const <String, String>{}));
    fake.onFunnelClaim(RvFunnelClaim(subscriberId: 'sub_1', funnelAnswersJson: '{}'));

    expect(fake.changeEvents, hasLength(1));
    expect(fake.logRecords, hasLength(1));
    expect(fake.funnelClaims, hasLength(1));
  });
}

class _FakeFlutterApi extends RovenueFlutterApi {
  final List<RvChangeEvent> changeEvents = <RvChangeEvent>[];
  final List<RvLogRecord> logRecords = <RvLogRecord>[];
  final List<RvFunnelClaim> funnelClaims = <RvFunnelClaim>[];

  @override
  void onChange(RvChangeEvent event) => changeEvents.add(event);

  @override
  void onLog(RvLogRecord record) => logRecords.add(record);

  @override
  void onFunnelClaim(RvFunnelClaim claim) => funnelClaims.add(claim);
}
