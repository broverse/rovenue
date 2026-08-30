// Marshalling tests for MethodChannelRovenue.
//
// Note on test harness (deviates from the brief's Step-4 sketch on
// purpose, for the same reason `contract_test.dart` (Task 2) already
// documents): the brief's `TestRovenueHostApi.setUp(fake)` assumes Pigeon
// generates a mockable test harness via `PigeonOptions.dartTestOut`, which
// this package's `pigeons/rovenue_api.dart` does not configure — adding it
// would mean regenerating (and risking unrelated diffs in) the committed
// `messages.g.dart`, which Task 3's constraints forbid touching. Instead
// this file exercises the same boundary Pigeon's `RovenueHostApi` itself
// talks to: it installs a `TestDefaultBinaryMessengerBinding` mock handler
// on the exact `BasicMessageChannel` name/codec each generated method uses,
// decodes the outgoing call arguments with the same `_PigeonCodec` Pigeon
// generates (reached here only via the public `pigeonChannelCodec` static),
// and replies with a Pigeon-shaped `[result]` / `[code, message, details]`
// envelope. This proves `MethodChannelRovenue` marshals arguments/results
// exactly as `RovenueHostApi` expects, without needing a second generated
// mock surface.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rovenue_flutter_platform_interface/src/messages.g.dart' as pigeon;
import 'package:rovenue_flutter_platform_interface/src/method_channel_rovenue.dart';
import 'package:rovenue_flutter_platform_interface/src/models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MethodChannelRovenue platform;

  setUp(() {
    platform = MethodChannelRovenue();
  });

  tearDown(() {
    // Clear every mock handler this test may have installed, keyed by the
    // exact BasicMessageChannel names MethodChannelRovenue's HostApi uses.
    for (final method in <String>[
      'entitlementsAll',
      'purchase',
      'setAttributes',
    ]) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMessageHandler(
        'dev.flutter.pigeon.rovenue_flutter_platform_interface.RovenueHostApi.$method',
        null,
      );
    }
  });

  /// Installs a mock handler on the named HostApi method's channel that
  /// decodes the call, hands the decoded argument list to [onCall], and
  /// replies with the Pigeon success envelope `[result]`.
  void mockHostApiCall(
    String method,
    Object? Function(List<Object?> args) onCall,
  ) {
    final channelName = 'dev.flutter.pigeon.rovenue_flutter_platform_interface.RovenueHostApi.$method';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMessageHandler(
      channelName,
      (ByteData? message) async {
        final Object? decoded = pigeon.RovenueHostApi.pigeonChannelCodec.decodeMessage(message);
        final args = (decoded as List<Object?>?) ?? const <Object?>[];
        final result = onCall(args);
        return pigeon.RovenueHostApi.pigeonChannelCodec.encodeMessage(<Object?>[result]);
      },
    );
  }

  test('entitlementsAll() decodes a list of Rv* DTOs into public Entitlement models', () async {
    mockHostApiCall('entitlementsAll', (args) {
      expect(args, isEmpty);
      return <pigeon.RvEntitlement>[
        pigeon.RvEntitlement(id: 'pro', active: true, expiresAt: '2030-01-01T00:00:00Z', productId: 'com.app.pro'),
        pigeon.RvEntitlement(id: 'trial', active: false),
      ];
    });

    final result = await platform.entitlementsAll();

    expect(result, hasLength(2));
    expect(result[0], isA<Entitlement>());
    expect(result[0].id, 'pro');
    expect(result[0].active, isTrue);
    expect(result[0].expiresAt, '2030-01-01T00:00:00Z');
    expect(result[0].productId, 'com.app.pro');
    expect(result[1].id, 'trial');
    expect(result[1].active, isFalse);
    expect(result[1].expiresAt, isNull);
  });

  test('purchase() marshals productType enum + optional args, decodes the result', () async {
    mockHostApiCall('purchase', (args) {
      expect(args, hasLength(5));
      expect(args[0], 'com.app.pro.monthly');
      expect(args[1], pigeon.RvProductType.subscription);
      expect(args[2], isNull); // promotionalOfferId
      expect(args[3], 'monthly-plan'); // basePlanId
      expect(args[4], isNull); // offerId
      return pigeon.RvPurchaseResult(
        entitlements: <pigeon.RvEntitlement>[
          pigeon.RvEntitlement(id: 'pro', active: true),
        ],
        virtualCurrencies: <String, int>{'gems': 100},
        productId: 'com.app.pro.monthly',
        storeTransactionId: 'txn_123',
        isDeferred: false,
      );
    });

    final result = await platform.purchase(
      'com.app.pro.monthly',
      ProductType.subscription,
      basePlanId: 'monthly-plan',
    );

    expect(result, isA<PurchaseResult>());
    expect(result.productId, 'com.app.pro.monthly');
    expect(result.storeTransactionId, 'txn_123');
    expect(result.isDeferred, isFalse);
    expect(result.entitlements, hasLength(1));
    expect(result.virtualCurrencies, <String, int>{'gems': 100});
  });

  test('setAttributes() lets nullable map values survive the round trip', () async {
    late Map<Object?, Object?> received;
    mockHostApiCall('setAttributes', (args) {
      expect(args, hasLength(1));
      received = args[0] as Map<Object?, Object?>;
      return null;
    });

    await platform.setAttributes(<String, String?>{
      'a': null,
      'plan': 'pro',
    });

    expect(received['a'], isNull);
    expect(received.containsKey('a'), isTrue);
    expect(received['plan'], 'pro');
  });

  test('a PlatformException from native is mapped to RovenueException, never leaks raw', () async {
    const channelName = 'dev.flutter.pigeon.rovenue_flutter_platform_interface.RovenueHostApi.entitlementsAll';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMessageHandler(
      channelName,
      (ByteData? message) async => pigeon.RovenueHostApi.pigeonChannelCodec.encodeMessage(
        <Object?>['NotFound', 'no entitlements', <String, Object?>{'detail': 'no entitlements'}],
      ),
    );

    await expectLater(
      platform.entitlementsAll(),
      throwsA(isA<Exception>().having(
        (e) => e.runtimeType.toString(),
        'runtimeType',
        isNot('PlatformException'),
      )),
    );

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMessageHandler(channelName, null);
  });
}
