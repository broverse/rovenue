// Public data model classes for the `rovenue_flutter` federated plugin.
//
// These are the ONLY types that cross the boundary of this package: the
// generated Pigeon DTOs in `messages.g.dart` (the `Rv*` classes) are an
// implementation detail of `MethodChannelRovenue` and must never be
// returned from `RovenuePlatform`. Field names/shapes here are a contract
// consumed by the app-facing `rovenue_flutter` package (Task 6).
//
// Each class is a field-for-field mirror of its `Rv*` DTO counterpart in
// `messages.g.dart` (itself mirroring `packages/sdk-rn/src/specs/RovenueModule.types.ts`),
// but using plain Dart enums/types instead of the Pigeon-generated ones.

import 'package:flutter/foundation.dart' show immutable, listEquals, mapEquals;

/// Subscription vs. one-time / consumable purchase.
///
/// Mirrors `RvProductType` / `ProductTypeDTO`.
enum ProductType { subscription, consumable, nonConsumable }

/// Mirrors `RvProductCategory` / `ProductCategoryDTO`.
enum ProductCategory { subscription, nonSubscription }

/// Mirrors `RvPeriodUnit` / `PeriodUnitDTO`.
enum PeriodUnit { day, week, month, year }

/// Mirrors `RvPaymentMode` / `PaymentModeDTO`.
enum PaymentMode { freeTrial, payAsYouGo, payUpFront }

/// Mirrors `RvDiscountType` / `DiscountTypeDTO`.
enum DiscountType { introductory, promotional, winBack }

/// Mirrors `RvRecurrenceMode` / `RecurrenceModeDTO`.
enum RecurrenceMode { infiniteRecurring, finiteRecurring, nonRecurring }

/// Mirrors `RvPackageType` / `PackageTypeDTO`.
enum PackageType {
  unknown,
  custom,
  lifetime,
  annual,
  sixMonth,
  threeMonth,
  twoMonth,
  monthly,
  weekly,
}

/// The kind of app-lifecycle transition reported by `recordSessionEvent`.
///
/// Mirrors `RvSessionEventKind`.
enum SessionEventKind { open, background, close }

/// Discriminant of a `RovenueChangeEvent` (native `onChange` payload).
///
/// Mirrors `RvChangeEventKind`.
enum RovenueChangeKind {
  entitlementsChanged,
  identityChanged,
  virtualCurrenciesChanged,
  remoteConfigChanged,
}

/// Severity of a [RovenueLogRecord], forwarded from the Rust core's log
/// sink. Mirrors `RvLogLevel`.
enum RovenueLogLevel { off, error, warn, info, debug, trace }

/// The current identified (or anonymous) subscriber.
///
/// Mirrors `RvUser` / `User` (librovenue.udl).
@immutable
class RovenueUser {
  const RovenueUser({required this.rovenueId, this.appUserId});

  /// Rovenue's own opaque subscriber id — always present.
  final String rovenueId;

  /// The app's own user id, if `identify()` has been called.
  final String? appUserId;

  RovenueUser copyWith({String? rovenueId, String? appUserId}) => RovenueUser(
        rovenueId: rovenueId ?? this.rovenueId,
        appUserId: appUserId ?? this.appUserId,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RovenueUser && other.rovenueId == rovenueId && other.appUserId == appUserId;

  @override
  int get hashCode => Object.hash(rovenueId, appUserId);

  @override
  String toString() => 'RovenueUser(rovenueId: $rovenueId, appUserId: $appUserId)';
}

/// A single granted (or expired) entitlement.
///
/// Mirrors `RvEntitlement` / `Entitlement`.
@immutable
class Entitlement {
  const Entitlement({
    required this.id,
    required this.active,
    this.expiresAt,
    this.productId,
  });

  final String id;
  final bool active;

  /// ISO-8601 expiry timestamp, if the entitlement has one (absent for
  /// non-expiring/lifetime grants).
  final String? expiresAt;
  final String? productId;

  Entitlement copyWith({
    String? id,
    bool? active,
    String? expiresAt,
    String? productId,
  }) =>
      Entitlement(
        id: id ?? this.id,
        active: active ?? this.active,
        expiresAt: expiresAt ?? this.expiresAt,
        productId: productId ?? this.productId,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Entitlement &&
          other.id == id &&
          other.active == active &&
          other.expiresAt == expiresAt &&
          other.productId == productId;

  @override
  int get hashCode => Object.hash(id, active, expiresAt, productId);

  @override
  String toString() =>
      'Entitlement(id: $id, active: $active, expiresAt: $expiresAt, productId: $productId)';
}

/// A billing period, e.g. "1 month". Mirrors `RvPeriod` / `PeriodDTO`.
@immutable
class RovenuePeriod {
  const RovenuePeriod({required this.value, required this.unit, required this.iso8601});

  final int value;
  final PeriodUnit unit;

  /// The raw ISO-8601 duration string (e.g. `"P1M"`) as reported by the
  /// store.
  final String iso8601;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RovenuePeriod && other.value == value && other.unit == unit && other.iso8601 == iso8601;

  @override
  int get hashCode => Object.hash(value, unit, iso8601);

  @override
  String toString() => 'RovenuePeriod(value: $value, unit: $unit, iso8601: $iso8601)';
}

/// Mirrors `RvIntroPrice` / `IntroPriceDTO`.
@immutable
class IntroPrice {
  const IntroPrice({
    this.price,
    this.priceString,
    this.currencyCode,
    required this.period,
    required this.cycles,
    required this.paymentMode,
  });

  final double? price;
  final String? priceString;
  final String? currencyCode;
  final RovenuePeriod period;
  final int cycles;
  final PaymentMode paymentMode;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is IntroPrice &&
          other.price == price &&
          other.priceString == priceString &&
          other.currencyCode == currencyCode &&
          other.period == period &&
          other.cycles == cycles &&
          other.paymentMode == paymentMode;

  @override
  int get hashCode => Object.hash(price, priceString, currencyCode, period, cycles, paymentMode);

  @override
  String toString() =>
      'IntroPrice(price: $price, priceString: $priceString, currencyCode: $currencyCode, period: $period, cycles: $cycles, paymentMode: $paymentMode)';
}

/// Mirrors `RvDiscount` / `DiscountDTO`.
@immutable
class Discount {
  const Discount({
    this.identifier,
    this.price,
    this.priceString,
    this.currencyCode,
    required this.period,
    required this.numberOfPeriods,
    required this.paymentMode,
    required this.type,
  });

  final String? identifier;
  final double? price;
  final String? priceString;
  final String? currencyCode;
  final RovenuePeriod period;
  final int numberOfPeriods;
  final PaymentMode paymentMode;
  final DiscountType type;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Discount &&
          other.identifier == identifier &&
          other.price == price &&
          other.priceString == priceString &&
          other.currencyCode == currencyCode &&
          other.period == period &&
          other.numberOfPeriods == numberOfPeriods &&
          other.paymentMode == paymentMode &&
          other.type == type;

  @override
  int get hashCode => Object.hash(
        identifier,
        price,
        priceString,
        currencyCode,
        period,
        numberOfPeriods,
        paymentMode,
        type,
      );

  @override
  String toString() =>
      'Discount(identifier: $identifier, price: $price, priceString: $priceString, currencyCode: $currencyCode, period: $period, numberOfPeriods: $numberOfPeriods, paymentMode: $paymentMode, type: $type)';
}

/// A single phase of a subscription option's pricing schedule (e.g. a free
/// trial phase followed by a full-price phase). Mirrors `RvPricingPhase` /
/// `PricingPhaseDTO`.
@immutable
class PricingPhase {
  const PricingPhase({
    this.price,
    this.priceString,
    this.currencyCode,
    required this.billingPeriod,
    this.billingCycleCount,
    required this.recurrenceMode,
    this.paymentMode,
  });

  final double? price;
  final String? priceString;
  final String? currencyCode;
  final RovenuePeriod billingPeriod;
  final int? billingCycleCount;
  final RecurrenceMode recurrenceMode;
  final PaymentMode? paymentMode;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PricingPhase &&
          other.price == price &&
          other.priceString == priceString &&
          other.currencyCode == currencyCode &&
          other.billingPeriod == billingPeriod &&
          other.billingCycleCount == billingCycleCount &&
          other.recurrenceMode == recurrenceMode &&
          other.paymentMode == paymentMode;

  @override
  int get hashCode => Object.hash(
        price,
        priceString,
        currencyCode,
        billingPeriod,
        billingCycleCount,
        recurrenceMode,
        paymentMode,
      );

  @override
  String toString() =>
      'PricingPhase(price: $price, priceString: $priceString, currencyCode: $currencyCode, billingPeriod: $billingPeriod, billingCycleCount: $billingCycleCount, recurrenceMode: $recurrenceMode, paymentMode: $paymentMode)';
}

/// An Android subscription offer (base plan + optional offer). Mirrors
/// `RvSubscriptionOption` / `SubscriptionOptionDTO`.
@immutable
class SubscriptionOption {
  const SubscriptionOption({
    required this.id,
    this.basePlanId,
    this.offerId,
    required this.tags,
    required this.isBasePlan,
    required this.isPrepaid,
    required this.pricingPhases,
    this.freePhase,
    this.introPhase,
    this.fullPricePhase,
  });

  final String id;
  final String? basePlanId;
  final String? offerId;
  final List<String> tags;
  final bool isBasePlan;
  final bool isPrepaid;
  final List<PricingPhase> pricingPhases;
  final PricingPhase? freePhase;
  final PricingPhase? introPhase;
  final PricingPhase? fullPricePhase;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SubscriptionOption &&
          other.id == id &&
          other.basePlanId == basePlanId &&
          other.offerId == offerId &&
          listEquals(other.tags, tags) &&
          other.isBasePlan == isBasePlan &&
          other.isPrepaid == isPrepaid &&
          listEquals(other.pricingPhases, pricingPhases) &&
          other.freePhase == freePhase &&
          other.introPhase == introPhase &&
          other.fullPricePhase == fullPricePhase;

  @override
  int get hashCode => Object.hash(
        id,
        basePlanId,
        offerId,
        Object.hashAll(tags),
        isBasePlan,
        isPrepaid,
        Object.hashAll(pricingPhases),
        freePhase,
        introPhase,
        fullPricePhase,
      );

  @override
  String toString() => 'SubscriptionOption(id: $id, basePlanId: $basePlanId, offerId: $offerId)';
}

/// A purchasable store product. Mirrors `RvStoreProduct` / `StoreProductDTO`.
@immutable
class StoreProduct {
  const StoreProduct({
    required this.id,
    required this.type,
    required this.productCategory,
    required this.displayName,
    this.description,
    this.priceString,
    this.price,
    this.currencyCode,
    this.subscriptionPeriod,
    this.subscriptionGroupIdentifier,
    required this.isFamilyShareable,
    this.introPrice,
    required this.discounts,
    this.isEligibleForIntroOffer,
    this.subscriptionOptions,
    this.defaultOption,
    this.pricePerWeek,
    this.pricePerMonth,
    this.pricePerYear,
    this.pricePerWeekString,
    this.pricePerMonthString,
    this.pricePerYearString,
  });

  final String id;
  final ProductType type;
  final ProductCategory productCategory;
  final String displayName;
  final String? description;
  final String? priceString;
  final double? price;
  final String? currencyCode;
  final RovenuePeriod? subscriptionPeriod;
  final String? subscriptionGroupIdentifier;
  final bool isFamilyShareable;
  final IntroPrice? introPrice;
  final List<Discount> discounts;
  final bool? isEligibleForIntroOffer;
  final List<SubscriptionOption>? subscriptionOptions;
  final SubscriptionOption? defaultOption;
  final double? pricePerWeek;
  final double? pricePerMonth;
  final double? pricePerYear;
  final String? pricePerWeekString;
  final String? pricePerMonthString;
  final String? pricePerYearString;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is StoreProduct &&
          other.id == id &&
          other.type == type &&
          other.productCategory == productCategory &&
          other.displayName == displayName &&
          other.description == description &&
          other.priceString == priceString &&
          other.price == price &&
          other.currencyCode == currencyCode &&
          other.subscriptionPeriod == subscriptionPeriod &&
          other.subscriptionGroupIdentifier == subscriptionGroupIdentifier &&
          other.isFamilyShareable == isFamilyShareable &&
          other.introPrice == introPrice &&
          listEquals(other.discounts, discounts) &&
          other.isEligibleForIntroOffer == isEligibleForIntroOffer &&
          listEquals(other.subscriptionOptions, subscriptionOptions) &&
          other.defaultOption == defaultOption &&
          other.pricePerWeek == pricePerWeek &&
          other.pricePerMonth == pricePerMonth &&
          other.pricePerYear == pricePerYear &&
          other.pricePerWeekString == pricePerWeekString &&
          other.pricePerMonthString == pricePerMonthString &&
          other.pricePerYearString == pricePerYearString;

  // Object.hash caps at 20 positional arguments, and this model has 22
  // fields, so the hash is combined in three chunks.
  @override
  int get hashCode => Object.hash(
        Object.hash(
          id,
          type,
          productCategory,
          displayName,
          description,
          priceString,
          price,
          currencyCode,
          subscriptionPeriod,
          subscriptionGroupIdentifier,
        ),
        Object.hash(
          isFamilyShareable,
          introPrice,
          Object.hashAll(discounts),
          isEligibleForIntroOffer,
          subscriptionOptions == null ? null : Object.hashAll(subscriptionOptions!),
          defaultOption,
          pricePerWeek,
          pricePerMonth,
          pricePerYear,
        ),
        Object.hash(pricePerWeekString, pricePerMonthString, pricePerYearString),
      );

  @override
  String toString() => 'StoreProduct(id: $id, displayName: $displayName, priceString: $priceString)';
}

/// One purchasable package within an [Offering]. Mirrors `RvPackage` /
/// `PackageDTO`.
@immutable
class RovenuePackage {
  const RovenuePackage({required this.identifier, this.packageType, required this.product});

  final String identifier;
  final PackageType? packageType;
  final StoreProduct product;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RovenuePackage &&
          other.identifier == identifier &&
          other.packageType == packageType &&
          other.product == product;

  @override
  int get hashCode => Object.hash(identifier, packageType, product);

  @override
  String toString() => 'RovenuePackage(identifier: $identifier, product: $product)';
}

/// A named group of [RovenuePackage]s. Mirrors `RvOffering` / `OfferingDTO`.
@immutable
class Offering {
  const Offering({required this.identifier, required this.isDefault, required this.packages});

  final String identifier;
  final bool isDefault;
  final List<RovenuePackage> packages;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Offering &&
          other.identifier == identifier &&
          other.isDefault == isDefault &&
          listEquals(other.packages, packages);

  @override
  int get hashCode => Object.hash(identifier, isDefault, Object.hashAll(packages));

  @override
  String toString() => 'Offering(identifier: $identifier, isDefault: $isDefault)';
}

/// All configured [Offering]s plus which one is current. Mirrors
/// `RvOfferings` / `OfferingsDTO`.
@immutable
class Offerings {
  const Offerings({this.current, required this.offerings});

  final String? current;
  final List<Offering> offerings;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Offerings && other.current == current && listEquals(other.offerings, offerings);

  @override
  int get hashCode => Object.hash(current, Object.hashAll(offerings));

  @override
  String toString() => 'Offerings(current: $current, offerings: ${offerings.length})';
}

/// Which placement/paywall/experiment variant a [Paywall] was resolved
/// from. Mirrors `RvPresentedContext` / `PresentedContextDTO`.
@immutable
class PresentedContext {
  const PresentedContext({
    required this.placementId,
    required this.paywallId,
    this.variantId,
    this.experimentKey,
    required this.revision,
  });

  final String placementId;
  final String paywallId;
  final String? variantId;
  final String? experimentKey;
  final int revision;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PresentedContext &&
          other.placementId == placementId &&
          other.paywallId == paywallId &&
          other.variantId == variantId &&
          other.experimentKey == experimentKey &&
          other.revision == revision;

  @override
  int get hashCode => Object.hash(placementId, paywallId, variantId, experimentKey, revision);

  @override
  String toString() =>
      'PresentedContext(placementId: $placementId, paywallId: $paywallId, variantId: $variantId)';
}

/// A resolved paywall for a placement — either a remote-config paywall or
/// a builder paywall (`builderConfigJson`), or an offline fallback.
/// Mirrors `RvPaywall` / `PaywallDTO`.
@immutable
class Paywall {
  const Paywall({
    required this.placementIdentifier,
    required this.placementRevision,
    this.paywallIdentifier,
    this.paywallName,
    required this.configFormatVersion,
    this.remoteConfigJson,
    this.remoteConfigLocale,
    this.builderConfigJson,
    this.offering,
    this.presentedContext,
    required this.servedFromFallback,
  });

  final String placementIdentifier;
  final int placementRevision;
  final String? paywallIdentifier;
  final String? paywallName;
  final int configFormatVersion;
  final String? remoteConfigJson;
  final String? remoteConfigLocale;
  final String? builderConfigJson;
  final Offering? offering;
  final PresentedContext? presentedContext;

  /// Whether this paywall was served from the on-device offline fallback
  /// file rather than the network.
  final bool servedFromFallback;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Paywall &&
          other.placementIdentifier == placementIdentifier &&
          other.placementRevision == placementRevision &&
          other.paywallIdentifier == paywallIdentifier &&
          other.paywallName == paywallName &&
          other.configFormatVersion == configFormatVersion &&
          other.remoteConfigJson == remoteConfigJson &&
          other.remoteConfigLocale == remoteConfigLocale &&
          other.builderConfigJson == builderConfigJson &&
          other.offering == offering &&
          other.presentedContext == presentedContext &&
          other.servedFromFallback == servedFromFallback;

  @override
  int get hashCode => Object.hash(
        placementIdentifier,
        placementRevision,
        paywallIdentifier,
        paywallName,
        configFormatVersion,
        remoteConfigJson,
        remoteConfigLocale,
        builderConfigJson,
        offering,
        presentedContext,
        servedFromFallback,
      );

  @override
  String toString() =>
      'Paywall(placementIdentifier: $placementIdentifier, paywallIdentifier: $paywallIdentifier, servedFromFallback: $servedFromFallback)';
}

/// A subscriber's assignment into a running experiment. Mirrors
/// `RvExperimentAssignment` / `ExperimentAssignmentDTO`.
@immutable
class ExperimentAssignment {
  const ExperimentAssignment({
    required this.experimentId,
    required this.key,
    required this.variantId,
    required this.variantName,
    required this.valueJson,
  });

  final String experimentId;
  final String key;
  final String variantId;
  final String variantName;

  /// The variant's configured value, as a JSON-encoded string.
  final String valueJson;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ExperimentAssignment &&
          other.experimentId == experimentId &&
          other.key == key &&
          other.variantId == variantId &&
          other.variantName == variantName &&
          other.valueJson == valueJson;

  @override
  int get hashCode => Object.hash(experimentId, key, variantId, variantName, valueJson);

  @override
  String toString() =>
      'ExperimentAssignment(key: $key, variantId: $variantId, variantName: $variantName)';
}

/// The outcome of a successful `purchase()` or `restorePurchases()` call.
/// Mirrors `RvPurchaseResult` / `PurchaseResultDTO`.
@immutable
class PurchaseResult {
  const PurchaseResult({
    required this.entitlements,
    required this.virtualCurrencies,
    required this.productId,
    required this.storeTransactionId,
    required this.isDeferred,
  });

  final List<Entitlement> entitlements;
  final Map<String, int> virtualCurrencies;
  final String productId;
  final String storeTransactionId;

  /// True for a deferred purchase (e.g. Ask to Buy) that has not yet been
  /// finalized by the store.
  final bool isDeferred;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PurchaseResult &&
          listEquals(other.entitlements, entitlements) &&
          mapEquals(other.virtualCurrencies, virtualCurrencies) &&
          other.productId == productId &&
          other.storeTransactionId == storeTransactionId &&
          other.isDeferred == isDeferred;

  @override
  int get hashCode => Object.hash(
        Object.hashAll(entitlements),
        Object.hashAllUnordered(
          virtualCurrencies.entries.map((e) => Object.hash(e.key, e.value)),
        ),
        productId,
        storeTransactionId,
        isDeferred,
      );

  @override
  String toString() =>
      'PurchaseResult(productId: $productId, storeTransactionId: $storeTransactionId, isDeferred: $isDeferred)';
}

/// The result of resolving a funnel token/deep link/clipboard token to a
/// subscriber. Mirrors `RvFunnelClaim`.
@immutable
class FunnelClaim {
  const FunnelClaim({required this.subscriberId, required this.funnelAnswersJson});

  final String subscriberId;

  /// The funnel's collected answers, as a JSON-encoded string.
  final String funnelAnswersJson;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is FunnelClaim &&
          other.subscriberId == subscriberId &&
          other.funnelAnswersJson == funnelAnswersJson;

  @override
  int get hashCode => Object.hash(subscriberId, funnelAnswersJson);

  @override
  String toString() => 'FunnelClaim(subscriberId: $subscriberId)';
}

/// Optional device/install context passed to `claimInstall`. All fields
/// are optional. Mirrors `RvClaimInstallParams`.
@immutable
class ClaimInstallParams {
  const ClaimInstallParams({
    this.platform,
    this.locale,
    this.timezone,
    this.screenDims,
    this.deviceModel,
    this.installReferrer,
  });

  final String? platform;
  final String? locale;
  final String? timezone;
  final String? screenDims;
  final String? deviceModel;
  final String? installReferrer;

  @override
  String toString() => 'ClaimInstallParams(platform: $platform, locale: $locale)';
}

/// A native `onChange` event: something the SDK caches locally changed and
/// the app should refresh its own view of it. Mirrors `RvChangeEvent`.
@immutable
class RovenueChangeEvent {
  const RovenueChangeEvent({required this.kind});

  final RovenueChangeKind kind;

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is RovenueChangeEvent && other.kind == kind;

  @override
  int get hashCode => kind.hashCode;

  @override
  String toString() => 'RovenueChangeEvent(kind: $kind)';
}

/// A single log line forwarded from the Rust core's log sink. Mirrors
/// `RvLogRecord` / `LogEntryDTO`.
@immutable
class RovenueLogRecord {
  const RovenueLogRecord({required this.level, required this.message, required this.fields});

  final RovenueLogLevel level;
  final String message;
  final Map<String, String> fields;

  @override
  String toString() => 'RovenueLogRecord(level: $level, message: $message)';
}
