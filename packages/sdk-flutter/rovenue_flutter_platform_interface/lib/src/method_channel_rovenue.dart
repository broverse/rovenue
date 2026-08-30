// The default `RovenuePlatform` implementation. Talks to native code
// exclusively through the generated Pigeon `RovenueHostApi` /
// `RovenueFlutterApi` in `messages.g.dart`, and is the ONLY place in this
// package that imports that file — every public method here accepts/returns
// the plain Dart models in `models.dart`, and every native call is wrapped
// so a raw `PlatformException` never escapes to callers.

import 'dart:async';

import 'package:flutter/services.dart';

import 'errors.dart';
import 'messages.g.dart' as pigeon;
import 'models.dart';
import 'rovenue_platform.dart';

/// Method-channel (Pigeon-backed) implementation of [RovenuePlatform].
class MethodChannelRovenue extends RovenuePlatform {
  MethodChannelRovenue({pigeon.RovenueHostApi? hostApi}) : _hostApi = hostApi ?? pigeon.RovenueHostApi() {
    pigeon.RovenueFlutterApi.setUp(_FlutterApiListener(this));
  }

  final pigeon.RovenueHostApi _hostApi;

  final StreamController<RovenueChangeEvent> _changesController =
      StreamController<RovenueChangeEvent>.broadcast();
  final StreamController<RovenueLogRecord> _logsController =
      StreamController<RovenueLogRecord>.broadcast();
  final StreamController<FunnelClaim> _funnelClaimsController =
      StreamController<FunnelClaim>.broadcast();

  /// The most recent claim delivered by native, if any. `_FlutterApiListener`
  /// is wired up in the constructor above, so a claim can arrive (and be
  /// cached here) well before any Dart-side code ever reads [funnelClaims] —
  /// e.g. a deferred deep link resolving during app startup, before the
  /// screen that displays onboarding answers has mounted. Without this
  /// cache, that event would be silently dropped: a broadcast
  /// [StreamController] delivers only to listeners already subscribed at
  /// the moment [StreamController.add] is called, and a resolved funnel
  /// claim's payload (subscriber id + collected answers) cannot be
  /// reconstructed from any other API afterwards. [changes] and [logs] are
  /// intentionally NOT given the same treatment: both are "something
  /// changed, go re-read it" signals whose current state is always
  /// re-fetchable on demand (`entitlementsAll()`, `remoteConfigAllJson()`,
  /// etc.), so a missed notification before a listener attaches costs
  /// nothing — the next explicit read already reflects the latest state.
  FunnelClaim? _lastFunnelClaim;

  @override
  Stream<RovenueChangeEvent> get changes => _changesController.stream;

  @override
  Stream<RovenueLogRecord> get logs => _logsController.stream;

  @override
  Stream<FunnelClaim> get funnelClaims => _replayLastFunnelClaim();

  /// Yields the cached [_lastFunnelClaim] (if any) to every new subscriber
  /// before forwarding live events, so a claim resolved before this
  /// subscriber attached is never missed.
  Stream<FunnelClaim> _replayLastFunnelClaim() async* {
    final FunnelClaim? last = _lastFunnelClaim;
    if (last != null) yield last;
    yield* _funnelClaimsController.stream;
  }

  /// Runs [body], mapping any [PlatformException] it throws into a
  /// [RovenueException] via [rovenueExceptionFrom]. Every [_hostApi] call
  /// in this class goes through this wrapper — it is the one enforcement
  /// point that keeps [PlatformException] from ever reaching app code.
  Future<T> _guard<T>(Future<T> Function() body) async {
    try {
      return await body();
    } on PlatformException catch (e) {
      throw rovenueExceptionFrom(e);
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  @override
  Future<void> configure({
    required String apiKey,
    String? baseUrl,
    RovenueLogLevel logLevel = RovenueLogLevel.off,
    String? appVersion,
    String? environment,
  }) =>
      _guard(() => _hostApi.configure(
            apiKey,
            baseUrl,
            _toRvLogLevel(logLevel),
            appVersion,
            environment,
          ));

  @override
  Future<void> shutdown() => _guard(() => _hostApi.shutdown());

  @override
  Future<void> setForeground(bool foreground) => _guard(() => _hostApi.setForeground(foreground));

  @override
  Future<String> getVersion() => _guard(() => _hostApi.getVersion());

  @override
  Future<String?> getAppVersion() => _guard(() => _hostApi.getAppVersion());

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  @override
  Future<RovenueUser> currentUser() =>
      _guard(() async => _toRovenueUser(await _hostApi.currentUser()));

  @override
  Future<void> identify(String appUserId) => _guard(() => _hostApi.identify(appUserId));

  @override
  Future<void> logOut() => _guard(() => _hostApi.logOut());

  // ---------------------------------------------------------------------
  // Entitlements
  // ---------------------------------------------------------------------

  @override
  Future<Entitlement?> entitlement(String id) => _guard(() async {
        final e = await _hostApi.entitlement(id);
        return e == null ? null : _toEntitlement(e);
      });

  @override
  Future<List<Entitlement>> entitlementsAll() => _guard(() async {
        final all = await _hostApi.entitlementsAll();
        return all.map(_toEntitlement).toList(growable: false);
      });

  @override
  Future<void> refreshEntitlements() => _guard(() => _hostApi.refreshEntitlements());

  // ---------------------------------------------------------------------
  // Virtual currencies
  // ---------------------------------------------------------------------

  @override
  Future<Map<String, int>> virtualCurrencies() => _guard(() => _hostApi.virtualCurrencies());

  @override
  Future<int> virtualCurrency(String code) => _guard(() => _hostApi.virtualCurrency(code));

  @override
  Future<void> refreshVirtualCurrencies() => _guard(() => _hostApi.refreshVirtualCurrencies());

  // ---------------------------------------------------------------------
  // Purchases / placements
  // ---------------------------------------------------------------------

  @override
  Future<Offerings> getOfferings() =>
      _guard(() async => _toOfferings(await _hostApi.getOfferings()));

  @override
  Future<Paywall?> getPaywall(String placementId, {String? locale}) => _guard(() async {
        final p = await _hostApi.getPaywall(placementId, locale);
        return p == null ? null : _toPaywall(p);
      });

  @override
  Future<int> setFallbackPlacements(String json) =>
      _guard(() => _hostApi.setFallbackPlacements(json));

  @override
  Future<PurchaseResult> purchase(
    String productId,
    ProductType productType, {
    String? promotionalOfferId,
    String? basePlanId,
    String? offerId,
  }) =>
      _guard(() async => _toPurchaseResult(await _hostApi.purchase(
            productId,
            _toRvProductType(productType),
            promotionalOfferId,
            basePlanId,
            offerId,
          )));

  @override
  Future<PurchaseResult> restorePurchases() =>
      _guard(() async => _toPurchaseResult(await _hostApi.restorePurchases()));

  // ---------------------------------------------------------------------
  // Remote Config
  // ---------------------------------------------------------------------

  @override
  Future<void> refreshRemoteConfig() => _guard(() => _hostApi.refreshRemoteConfig());

  @override
  Future<bool> remoteConfigBool(String key, bool fallback) =>
      _guard(() => _hostApi.remoteConfigBool(key, fallback));

  @override
  Future<String> remoteConfigString(String key, String fallback) =>
      _guard(() => _hostApi.remoteConfigString(key, fallback));

  @override
  Future<int> remoteConfigInt(String key, int fallback) =>
      _guard(() => _hostApi.remoteConfigInt(key, fallback));

  @override
  Future<double> remoteConfigDouble(String key, double fallback) =>
      _guard(() => _hostApi.remoteConfigDouble(key, fallback));

  @override
  Future<String?> remoteConfigJson(String key) => _guard(() => _hostApi.remoteConfigJson(key));

  @override
  Future<List<String>> remoteConfigKeys() => _guard(() => _hostApi.remoteConfigKeys());

  @override
  Future<String> remoteConfigAllJson() => _guard(() => _hostApi.remoteConfigAllJson());

  @override
  Future<ExperimentAssignment?> experiment(String key) => _guard(() async {
        final e = await _hostApi.experiment(key);
        return e == null ? null : _toExperimentAssignment(e);
      });

  @override
  Future<List<ExperimentAssignment>> experimentsAll() => _guard(() async {
        final all = await _hostApi.experimentsAll();
        return all.map(_toExperimentAssignment).toList(growable: false);
      });

  // ---------------------------------------------------------------------
  // Refund Shield
  // ---------------------------------------------------------------------

  @override
  Future<String> getAppAccountToken() => _guard(() => _hostApi.getAppAccountToken());

  @override
  Future<void> recordSessionEvent(
    SessionEventKind kind,
    String occurredAt, {
    int? durationMs,
  }) =>
      _guard(() => _hostApi.recordSessionEvent(_toRvSessionEventKind(kind), occurredAt, durationMs));

  @override
  Future<int> flushSessionEvents() => _guard(() => _hostApi.flushSessionEvents());

  // ---------------------------------------------------------------------
  // Funnel attribution
  // ---------------------------------------------------------------------

  @override
  Future<FunnelClaim> claimFunnelToken(String token) =>
      _guard(() async => _toFunnelClaim(await _hostApi.claimFunnelToken(token)));

  @override
  Future<FunnelClaim?> claimInstall(ClaimInstallParams params) => _guard(() async {
        final c = await _hostApi.claimInstall(_toRvClaimInstallParams(params));
        return c == null ? null : _toFunnelClaim(c);
      });

  @override
  Future<void> claimViaEmail(String email) => _guard(() => _hostApi.claimViaEmail(email));

  @override
  Future<FunnelClaim?> claimFromClipboard() => _guard(() async {
        final c = await _hostApi.claimFromClipboard();
        return c == null ? null : _toFunnelClaim(c);
      });

  @override
  Future<String> installId() => _guard(() => _hostApi.installId());

  @override
  Future<bool> hasResolvedFunnelClaim() => _guard(() => _hostApi.hasResolvedFunnelClaim());

  // ---------------------------------------------------------------------
  // Generic events
  // ---------------------------------------------------------------------

  @override
  Future<void> track(String envelopeJson) => _guard(() => _hostApi.track(envelopeJson));

  @override
  Future<void> enqueuePaywallEvent(String envelopeJson) =>
      _guard(() => _hostApi.enqueuePaywallEvent(envelopeJson));

  // ---------------------------------------------------------------------
  // Subscriber attributes
  // ---------------------------------------------------------------------

  @override
  Future<void> setAttributes(Map<String, String?> attributes) =>
      _guard(() => _hostApi.setAttributes(attributes));

  @override
  Future<void> setEmail(String? email) => _guard(() => _hostApi.setEmail(email));

  @override
  Future<void> setDisplayName(String? name) => _guard(() => _hostApi.setDisplayName(name));

  @override
  Future<void> setPhoneNumber(String? phone) => _guard(() => _hostApi.setPhoneNumber(phone));

  @override
  Future<void> setPushToken(String? token) => _guard(() => _hostApi.setPushToken(token));

  @override
  Future<int> flushAttributes() => _guard(() => _hostApi.flushAttributes());

  // ---------------------------------------------------------------------
  // Native -> Dart event plumbing (see _FlutterApiListener below).
  // ---------------------------------------------------------------------

  void _onNativeChange(pigeon.RvChangeEvent event) =>
      _changesController.add(_toChangeEvent(event));

  void _onNativeLog(pigeon.RvLogRecord record) => _logsController.add(_toLogRecord(record));

  void _onNativeFunnelClaim(pigeon.RvFunnelClaim claim) {
    final FunnelClaim parsed = _toFunnelClaim(claim);
    _lastFunnelClaim = parsed;
    _funnelClaimsController.add(parsed);
  }
}

/// Implements the native-to-Dart `RovenueFlutterApi` and forwards each
/// callback to the owning [MethodChannelRovenue]'s stream controllers.
class _FlutterApiListener extends pigeon.RovenueFlutterApi {
  _FlutterApiListener(this._owner);

  final MethodChannelRovenue _owner;

  @override
  void onChange(pigeon.RvChangeEvent event) => _owner._onNativeChange(event);

  @override
  void onLog(pigeon.RvLogRecord record) => _owner._onNativeLog(record);

  @override
  void onFunnelClaim(pigeon.RvFunnelClaim claim) => _owner._onNativeFunnelClaim(claim);
}

// ---------------------------------------------------------------------------
// Rv* (Pigeon) <-> public model conversions.
// ---------------------------------------------------------------------------

RovenueUser _toRovenueUser(pigeon.RvUser u) =>
    RovenueUser(rovenueId: u.rovenueId, appUserId: u.appUserId);

Entitlement _toEntitlement(pigeon.RvEntitlement e) => Entitlement(
      id: e.id,
      active: e.active,
      expiresAt: e.expiresAt,
      productId: e.productId,
    );

RovenuePeriod _toPeriod(pigeon.RvPeriod p) =>
    RovenuePeriod(value: p.value, unit: _toPeriodUnit(p.unit), iso8601: p.iso8601);

IntroPrice _toIntroPrice(pigeon.RvIntroPrice p) => IntroPrice(
      price: p.price,
      priceString: p.priceString,
      currencyCode: p.currencyCode,
      period: _toPeriod(p.period),
      cycles: p.cycles,
      paymentMode: _toPaymentMode(p.paymentMode),
    );

Discount _toDiscount(pigeon.RvDiscount d) => Discount(
      identifier: d.identifier,
      price: d.price,
      priceString: d.priceString,
      currencyCode: d.currencyCode,
      period: _toPeriod(d.period),
      numberOfPeriods: d.numberOfPeriods,
      paymentMode: _toPaymentMode(d.paymentMode),
      type: _toDiscountType(d.type),
    );

PricingPhase _toPricingPhase(pigeon.RvPricingPhase p) => PricingPhase(
      price: p.price,
      priceString: p.priceString,
      currencyCode: p.currencyCode,
      billingPeriod: _toPeriod(p.billingPeriod),
      billingCycleCount: p.billingCycleCount,
      recurrenceMode: _toRecurrenceMode(p.recurrenceMode),
      paymentMode: p.paymentMode == null ? null : _toPaymentMode(p.paymentMode!),
    );

SubscriptionOption _toSubscriptionOption(pigeon.RvSubscriptionOption o) => SubscriptionOption(
      id: o.id,
      basePlanId: o.basePlanId,
      offerId: o.offerId,
      tags: o.tags,
      isBasePlan: o.isBasePlan,
      isPrepaid: o.isPrepaid,
      pricingPhases: o.pricingPhases.map(_toPricingPhase).toList(growable: false),
      freePhase: o.freePhase == null ? null : _toPricingPhase(o.freePhase!),
      introPhase: o.introPhase == null ? null : _toPricingPhase(o.introPhase!),
      fullPricePhase: o.fullPricePhase == null ? null : _toPricingPhase(o.fullPricePhase!),
    );

StoreProduct _toStoreProduct(pigeon.RvStoreProduct p) => StoreProduct(
      id: p.id,
      type: _toProductType(p.type),
      productCategory: _toProductCategory(p.productCategory),
      displayName: p.displayName,
      description: p.description,
      priceString: p.priceString,
      price: p.price,
      currencyCode: p.currencyCode,
      subscriptionPeriod: p.subscriptionPeriod == null ? null : _toPeriod(p.subscriptionPeriod!),
      subscriptionGroupIdentifier: p.subscriptionGroupIdentifier,
      isFamilyShareable: p.isFamilyShareable,
      introPrice: p.introPrice == null ? null : _toIntroPrice(p.introPrice!),
      discounts: p.discounts.map(_toDiscount).toList(growable: false),
      isEligibleForIntroOffer: p.isEligibleForIntroOffer,
      subscriptionOptions: p.subscriptionOptions?.map(_toSubscriptionOption).toList(growable: false),
      defaultOption: p.defaultOption == null ? null : _toSubscriptionOption(p.defaultOption!),
      pricePerWeek: p.pricePerWeek,
      pricePerMonth: p.pricePerMonth,
      pricePerYear: p.pricePerYear,
      pricePerWeekString: p.pricePerWeekString,
      pricePerMonthString: p.pricePerMonthString,
      pricePerYearString: p.pricePerYearString,
    );

RovenuePackage _toPackage(pigeon.RvPackage p) => RovenuePackage(
      identifier: p.identifier,
      packageType: p.packageType == null ? null : _toPackageType(p.packageType!),
      product: _toStoreProduct(p.product),
    );

Offering _toOffering(pigeon.RvOffering o) => Offering(
      identifier: o.identifier,
      isDefault: o.isDefault,
      packages: o.packages.map(_toPackage).toList(growable: false),
    );

Offerings _toOfferings(pigeon.RvOfferings o) => Offerings(
      current: o.current,
      offerings: o.offerings.map(_toOffering).toList(growable: false),
    );

PresentedContext _toPresentedContext(pigeon.RvPresentedContext c) => PresentedContext(
      placementId: c.placementId,
      paywallId: c.paywallId,
      variantId: c.variantId,
      experimentKey: c.experimentKey,
      revision: c.revision,
    );

Paywall _toPaywall(pigeon.RvPaywall p) => Paywall(
      placementIdentifier: p.placementIdentifier,
      placementRevision: p.placementRevision,
      paywallIdentifier: p.paywallIdentifier,
      paywallName: p.paywallName,
      configFormatVersion: p.configFormatVersion,
      remoteConfigJson: p.remoteConfigJson,
      remoteConfigLocale: p.remoteConfigLocale,
      builderConfigJson: p.builderConfigJson,
      offering: p.offering == null ? null : _toOffering(p.offering!),
      presentedContext: p.presentedContext == null ? null : _toPresentedContext(p.presentedContext!),
      servedFromFallback: p.servedFromFallback,
    );

ExperimentAssignment _toExperimentAssignment(pigeon.RvExperimentAssignment a) => ExperimentAssignment(
      experimentId: a.experimentId,
      key: a.key,
      variantId: a.variantId,
      variantName: a.variantName,
      valueJson: a.valueJson,
    );

PurchaseResult _toPurchaseResult(pigeon.RvPurchaseResult r) => PurchaseResult(
      entitlements: r.entitlements.map(_toEntitlement).toList(growable: false),
      virtualCurrencies: r.virtualCurrencies,
      productId: r.productId,
      storeTransactionId: r.storeTransactionId,
      isDeferred: r.isDeferred,
    );

FunnelClaim _toFunnelClaim(pigeon.RvFunnelClaim c) =>
    FunnelClaim(subscriberId: c.subscriberId, funnelAnswersJson: c.funnelAnswersJson);

pigeon.RvClaimInstallParams _toRvClaimInstallParams(ClaimInstallParams p) => pigeon.RvClaimInstallParams(
      platform: p.platform,
      locale: p.locale,
      timezone: p.timezone,
      screenDims: p.screenDims,
      deviceModel: p.deviceModel,
      installReferrer: p.installReferrer,
    );

RovenueChangeEvent _toChangeEvent(pigeon.RvChangeEvent e) =>
    RovenueChangeEvent(kind: _toChangeKind(e.kind));

RovenueLogRecord _toLogRecord(pigeon.RvLogRecord r) =>
    RovenueLogRecord(level: _toLogLevel(r.level), message: r.message, fields: r.fields);

// --- Enum conversions (public -> Rv* and Rv* -> public) ---------------------

pigeon.RvLogLevel _toRvLogLevel(RovenueLogLevel level) => switch (level) {
      RovenueLogLevel.off => pigeon.RvLogLevel.off,
      RovenueLogLevel.error => pigeon.RvLogLevel.error,
      RovenueLogLevel.warn => pigeon.RvLogLevel.warn,
      RovenueLogLevel.info => pigeon.RvLogLevel.info,
      RovenueLogLevel.debug => pigeon.RvLogLevel.debug,
      RovenueLogLevel.trace => pigeon.RvLogLevel.trace,
    };

RovenueLogLevel _toLogLevel(pigeon.RvLogLevel level) => switch (level) {
      pigeon.RvLogLevel.off => RovenueLogLevel.off,
      pigeon.RvLogLevel.error => RovenueLogLevel.error,
      pigeon.RvLogLevel.warn => RovenueLogLevel.warn,
      pigeon.RvLogLevel.info => RovenueLogLevel.info,
      pigeon.RvLogLevel.debug => RovenueLogLevel.debug,
      pigeon.RvLogLevel.trace => RovenueLogLevel.trace,
    };

pigeon.RvProductType _toRvProductType(ProductType type) => switch (type) {
      ProductType.subscription => pigeon.RvProductType.subscription,
      ProductType.consumable => pigeon.RvProductType.consumable,
      ProductType.nonConsumable => pigeon.RvProductType.nonConsumable,
    };

ProductType _toProductType(pigeon.RvProductType type) => switch (type) {
      pigeon.RvProductType.subscription => ProductType.subscription,
      pigeon.RvProductType.consumable => ProductType.consumable,
      pigeon.RvProductType.nonConsumable => ProductType.nonConsumable,
    };

ProductCategory _toProductCategory(pigeon.RvProductCategory c) => switch (c) {
      pigeon.RvProductCategory.subscription => ProductCategory.subscription,
      pigeon.RvProductCategory.nonSubscription => ProductCategory.nonSubscription,
    };

PeriodUnit _toPeriodUnit(pigeon.RvPeriodUnit u) => switch (u) {
      pigeon.RvPeriodUnit.day => PeriodUnit.day,
      pigeon.RvPeriodUnit.week => PeriodUnit.week,
      pigeon.RvPeriodUnit.month => PeriodUnit.month,
      pigeon.RvPeriodUnit.year => PeriodUnit.year,
    };

PaymentMode _toPaymentMode(pigeon.RvPaymentMode m) => switch (m) {
      pigeon.RvPaymentMode.freeTrial => PaymentMode.freeTrial,
      pigeon.RvPaymentMode.payAsYouGo => PaymentMode.payAsYouGo,
      pigeon.RvPaymentMode.payUpFront => PaymentMode.payUpFront,
    };

DiscountType _toDiscountType(pigeon.RvDiscountType t) => switch (t) {
      pigeon.RvDiscountType.introductory => DiscountType.introductory,
      pigeon.RvDiscountType.promotional => DiscountType.promotional,
      pigeon.RvDiscountType.winBack => DiscountType.winBack,
    };

RecurrenceMode _toRecurrenceMode(pigeon.RvRecurrenceMode m) => switch (m) {
      pigeon.RvRecurrenceMode.infiniteRecurring => RecurrenceMode.infiniteRecurring,
      pigeon.RvRecurrenceMode.finiteRecurring => RecurrenceMode.finiteRecurring,
      pigeon.RvRecurrenceMode.nonRecurring => RecurrenceMode.nonRecurring,
    };

PackageType _toPackageType(pigeon.RvPackageType t) => switch (t) {
      pigeon.RvPackageType.unknown => PackageType.unknown,
      pigeon.RvPackageType.custom => PackageType.custom,
      pigeon.RvPackageType.lifetime => PackageType.lifetime,
      pigeon.RvPackageType.annual => PackageType.annual,
      pigeon.RvPackageType.sixMonth => PackageType.sixMonth,
      pigeon.RvPackageType.threeMonth => PackageType.threeMonth,
      pigeon.RvPackageType.twoMonth => PackageType.twoMonth,
      pigeon.RvPackageType.monthly => PackageType.monthly,
      pigeon.RvPackageType.weekly => PackageType.weekly,
    };

pigeon.RvSessionEventKind _toRvSessionEventKind(SessionEventKind kind) => switch (kind) {
      SessionEventKind.open => pigeon.RvSessionEventKind.open,
      SessionEventKind.background => pigeon.RvSessionEventKind.background,
      SessionEventKind.close => pigeon.RvSessionEventKind.close,
    };

RovenueChangeKind _toChangeKind(pigeon.RvChangeEventKind kind) => switch (kind) {
      pigeon.RvChangeEventKind.entitlementsChanged => RovenueChangeKind.entitlementsChanged,
      pigeon.RvChangeEventKind.identityChanged => RovenueChangeKind.identityChanged,
      pigeon.RvChangeEventKind.virtualCurrenciesChanged =>
        RovenueChangeKind.virtualCurrenciesChanged,
      pigeon.RvChangeEventKind.remoteConfigChanged => RovenueChangeKind.remoteConfigChanged,
    };
