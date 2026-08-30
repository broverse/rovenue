import 'package:flutter/services.dart';

/// The normalized error taxonomy shared across every Rovenue SDK façade.
///
/// These 24 values are exactly `ErrorKind` in
/// `packages/core-rs/src/librovenue.udl` (the Rust core's FFI error
/// projection, `RovenueErrorFfi.Generic`); [unknown] is this Dart binding's
/// own 25th value, used only when a native `PlatformException.code` does not
/// match any of the 24 known names (e.g. a newer core shipped ahead of this
/// package).
enum RovenueErrorKind {
  networkUnavailable,
  timeout,
  rateLimited,
  serverError,
  invalidApiKey,
  forbidden,
  notFound,
  invalidRequest,
  conflict,
  invalidArgument,
  insufficientCredits,
  funnelTokenNotFound,
  funnelTokenExpired,
  funnelTokenAlreadyClaimed,
  purchaseCanceled,
  productNotAvailable,
  alreadyOwned,
  paymentDeclined,
  storeServiceUnavailable,
  ineligible,
  receiptInvalid,
  storeProblem,
  storage,
  internal,

  /// Not part of `librovenue.udl`'s `ErrorKind` — synthesized here for any
  /// `PlatformException.code` this package does not recognise, so app code
  /// never has to handle a raw [PlatformException].
  unknown,
}

/// Maps each of the 24 `ErrorKind` variant names (see [RovenueErrorKind])
/// to its Dart enum value. Keys are exactly the strings the native side
/// sends as `PlatformException.code` (identical to the UDL enum member
/// names, e.g. `"NetworkUnavailable"`).
const Map<String, RovenueErrorKind> _kindByCode = <String, RovenueErrorKind>{
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

/// The exception type every public Rovenue Flutter API throws. App code
/// should catch this instead of [PlatformException] — the method channel
/// layer never lets a raw [PlatformException] escape to callers.
class RovenueException implements Exception {
  const RovenueException({
    required this.kind,
    required this.detail,
    this.serverCode,
    this.httpStatus,
    this.retryable = false,
  });

  /// Normalized error category (see [RovenueErrorKind]).
  final RovenueErrorKind kind;

  /// Human-readable detail message, always non-null (falls back to the
  /// [kind]'s name when the native side sent none).
  final String detail;

  /// Server-issued error code, when the error originated from an API
  /// response (e.g. `"E42"`).
  final String? serverCode;

  /// HTTP status code, when the error originated from an API response.
  final int? httpStatus;

  /// Whether the operation that produced this error is safe to retry.
  final bool retryable;

  @override
  String toString() =>
      'RovenueException(kind: ${kind.name}, detail: $detail, serverCode: $serverCode, httpStatus: $httpStatus, retryable: $retryable)';
}

/// Converts a [PlatformException] raised by the native Rovenue plugin into
/// a typed [RovenueException]. Exported so the `rovenue_flutter_ios` /
/// `rovenue_flutter_android` impl packages (and any future platform impl)
/// can reuse the same mapping if they ever need to intercept a
/// [PlatformException] outside of [MethodChannelRovenue].
RovenueException rovenueExceptionFrom(PlatformException e) {
  final kind = _kindByCode[e.code] ?? RovenueErrorKind.unknown;

  final details = e.details;
  final Map<Object?, Object?>? detailsMap = details is Map ? details : null;

  final detail = (detailsMap?['detail'] as String?) ?? e.message ?? kind.name;
  final serverCode = detailsMap?['serverCode'] as String?;
  final httpStatus = switch (detailsMap?['httpStatus']) {
    final int v => v,
    final num v => v.toInt(),
    _ => null,
  };
  final retryable = detailsMap?['retryable'] as bool? ?? false;

  return RovenueException(
    kind: kind,
    detail: detail,
    serverCode: serverCode,
    httpStatus: httpStatus,
    retryable: retryable,
  );
}
