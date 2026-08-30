// Table-driven test over every `ErrorKind` variant in
// packages/core-rs/src/librovenue.udl (verified against the UDL source,
// see task-3-report.md), plus the SDK's own `unknown` fallback for a code
// the client does not recognise.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rovenue_flutter_platform_interface/src/errors.dart';

void main() {
  // Keys are exactly the `ErrorKind` enum member names from
  // packages/core-rs/src/librovenue.udl (24 entries).
  const cases = <String, RovenueErrorKind>{
    'NetworkUnavailable': RovenueErrorKind.networkUnavailable,
    'Timeout': RovenueErrorKind.timeout,
    'RateLimited': RovenueErrorKind.rateLimited,
    'ServerError': RovenueErrorKind.serverError,
    'InvalidApiKey': RovenueErrorKind.invalidApiKey,
    'Forbidden': RovenueErrorKind.forbidden,
    'NotFound': RovenueErrorKind.notFound,
    'InvalidRequest': RovenueErrorKind.invalidRequest,
    'Conflict': RovenueErrorKind.conflict,
    'InvalidArgument': RovenueErrorKind.invalidArgument,
    'InsufficientCredits': RovenueErrorKind.insufficientCredits,
    'FunnelTokenNotFound': RovenueErrorKind.funnelTokenNotFound,
    'FunnelTokenExpired': RovenueErrorKind.funnelTokenExpired,
    'FunnelTokenAlreadyClaimed': RovenueErrorKind.funnelTokenAlreadyClaimed,
    'PurchaseCanceled': RovenueErrorKind.purchaseCanceled,
    'ProductNotAvailable': RovenueErrorKind.productNotAvailable,
    'AlreadyOwned': RovenueErrorKind.alreadyOwned,
    'PaymentDeclined': RovenueErrorKind.paymentDeclined,
    'StoreServiceUnavailable': RovenueErrorKind.storeServiceUnavailable,
    'Ineligible': RovenueErrorKind.ineligible,
    'ReceiptInvalid': RovenueErrorKind.receiptInvalid,
    'StoreProblem': RovenueErrorKind.storeProblem,
    'Storage': RovenueErrorKind.storage,
    'Internal': RovenueErrorKind.internal,
  };

  test('maps every ErrorKind name (all 24 UDL variants)', () {
    expect(cases.length, 24);
    for (final entry in cases.entries) {
      final ex = rovenueExceptionFrom(PlatformException(
        code: entry.key,
        message: 'boom',
        details: <String, Object?>{
          'detail': 'boom',
          'serverCode': 'E42',
          'httpStatus': 503,
          'retryable': true,
        },
      ));
      expect(ex.kind, entry.value, reason: 'code ${entry.key}');
      expect(ex.detail, 'boom');
      expect(ex.serverCode, 'E42');
      expect(ex.httpStatus, 503);
      expect(ex.retryable, isTrue);
    }
  });

  test('unrecognised code becomes unknown without losing detail', () {
    final ex = rovenueExceptionFrom(PlatformException(code: 'SomethingNew', message: 'x'));
    expect(ex.kind, RovenueErrorKind.unknown);
    expect(ex.detail, 'x');
  });

  test('details map absent — no crash, retryable defaults false', () {
    final ex = rovenueExceptionFrom(PlatformException(code: 'Timeout', message: null));
    expect(ex.kind, RovenueErrorKind.timeout);
    expect(ex.retryable, isFalse);
  });

  test('message null and details null falls back to a non-null detail string', () {
    final ex = rovenueExceptionFrom(PlatformException(code: 'Internal'));
    expect(ex.kind, RovenueErrorKind.internal);
    expect(ex.detail, isNotEmpty);
    expect(ex.serverCode, isNull);
    expect(ex.httpStatus, isNull);
    expect(ex.retryable, isFalse);
  });

  test('RovenueException.toString includes kind and detail', () {
    final ex = rovenueExceptionFrom(PlatformException(code: 'Forbidden', message: 'nope'));
    expect(ex.toString(), contains('forbidden'));
    expect(ex.toString(), contains('nope'));
  });
}
