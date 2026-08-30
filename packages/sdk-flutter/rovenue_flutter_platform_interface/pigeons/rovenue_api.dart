// Pigeon contract for the rovenue_flutter federated plugin.
//
// This is a field-for-field mirror of the RN Expo module's TypeScript
// contract at `packages/sdk-rn/src/specs/RovenueModule.types.ts` (the M3
// Swift / M4 Kotlin public surfaces, RN's typechecking-only spec of
// record) plus the two event-only shapes RN carries in
// `packages/sdk-rn/src/types.ts` (`ChangeEvent`) and
// `packages/sdk-rn/src/api/log.ts` (`onLog` payload). Every method on
// `RovenueModuleSpec` has a same-named counterpart on `RovenueHostApi`
// below, EXCEPT the two Expo-only bookkeeping hooks `addListener` /
// `removeListeners` — Flutter's plugin channel has no equivalent, so they
// are intentionally not carried over.
//
// Also intentionally excluded (controller ruling, ledgered in
// .superpowers/sdd/2026-08-30-flutter-sdk/task-2-context.md): `getPaywallPreview`
// and `logPaywallShown`/`logPaywallClosed`, which exist in the Rust UDL but
// are not exposed by RN (the parity bar for this SDK) — preview also
// requires a dashboard-issued token this task does not plumb.
//
// Generate with:
//   cd packages/sdk-flutter/rovenue_flutter_platform_interface
//   nice -n 19 dart run pigeon --input pigeons/rovenue_api.dart

import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(PigeonOptions(
  dartOut: 'lib/src/messages.g.dart',
  swiftOut: '../rovenue_flutter_ios/ios/Classes/Messages.g.swift',
  kotlinOut:
      '../rovenue_flutter_android/android/src/main/kotlin/dev/rovenue/flutter/Messages.g.kt',
  kotlinOptions: KotlinOptions(package: 'dev.rovenue.flutter'),
  dartPackageName: 'rovenue_flutter_platform_interface',
))

// ---------------------------------------------------------------------------
// Enums — one per TS string-literal union in RovenueModule.types.ts.
// ---------------------------------------------------------------------------

/// Mirrors the `"off" | "error" | "warn" | "info" | "debug" | "trace"`
/// log-level union used by `configure()` and `LogEntryDTO.level`.
enum RvLogLevel { off, error, warn, info, debug, trace }

/// Mirrors `ProductTypeDTO` (`"subscription" | "consumable" |
/// "non_consumable"`).
enum RvProductType { subscription, consumable, nonConsumable }

/// Mirrors the `"open" | "background" | "close"` union accepted by
/// `recordSessionEvent`.
enum RvSessionEventKind { open, background, close }

/// Mirrors `ProductCategoryDTO`.
enum RvProductCategory { subscription, nonSubscription }

/// Mirrors `PeriodUnitDTO`.
enum RvPeriodUnit { day, week, month, year }

/// Mirrors `PaymentModeDTO`.
enum RvPaymentMode { freeTrial, payAsYouGo, payUpFront }

/// Mirrors `DiscountTypeDTO`.
enum RvDiscountType { introductory, promotional, winBack }

/// Mirrors `RecurrenceModeDTO`.
enum RvRecurrenceMode { infiniteRecurring, finiteRecurring, nonRecurring }

/// Mirrors `PackageTypeDTO`.
enum RvPackageType {
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

/// Mirrors `ChangeEvent` (`packages/sdk-rn/src/types.ts`) — the native
/// `onChange` event payload's `event` discriminant.
enum RvChangeEventKind {
  entitlementsChanged,
  identityChanged,
  virtualCurrenciesChanged,
  remoteConfigChanged,
}

// ---------------------------------------------------------------------------
// DTOs — one per TS type in RovenueModule.types.ts, field-for-field.
// ---------------------------------------------------------------------------

class RvUser {
  RvUser({required this.rovenueId, this.appUserId});
  String rovenueId;
  String? appUserId;
}

class RvEntitlement {
  RvEntitlement({
    required this.id,
    required this.active,
    this.expiresAt,
    this.productId,
  });
  String id;
  bool active;
  String? expiresAt;
  String? productId;
}

/// Mirrors `PeriodDTO`.
class RvPeriod {
  RvPeriod({required this.value, required this.unit, required this.iso8601});
  int value;
  RvPeriodUnit unit;
  String iso8601;
}

/// Mirrors `IntroPriceDTO`.
class RvIntroPrice {
  RvIntroPrice({
    this.price,
    this.priceString,
    this.currencyCode,
    required this.period,
    required this.cycles,
    required this.paymentMode,
  });
  double? price;
  String? priceString;
  String? currencyCode;
  RvPeriod period;
  int cycles;
  RvPaymentMode paymentMode;
}

/// Mirrors `DiscountDTO`.
class RvDiscount {
  RvDiscount({
    this.identifier,
    this.price,
    this.priceString,
    this.currencyCode,
    required this.period,
    required this.numberOfPeriods,
    required this.paymentMode,
    required this.type,
  });
  String? identifier;
  double? price;
  String? priceString;
  String? currencyCode;
  RvPeriod period;
  int numberOfPeriods;
  RvPaymentMode paymentMode;
  RvDiscountType type;
}

/// Mirrors `PricingPhaseDTO`.
class RvPricingPhase {
  RvPricingPhase({
    this.price,
    this.priceString,
    this.currencyCode,
    required this.billingPeriod,
    this.billingCycleCount,
    required this.recurrenceMode,
    this.paymentMode,
  });
  double? price;
  String? priceString;
  String? currencyCode;
  RvPeriod billingPeriod;
  int? billingCycleCount;
  RvRecurrenceMode recurrenceMode;
  RvPaymentMode? paymentMode;
}

/// Mirrors `SubscriptionOptionDTO`.
class RvSubscriptionOption {
  RvSubscriptionOption({
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
  String id;
  String? basePlanId;
  String? offerId;
  List<String> tags;
  bool isBasePlan;
  bool isPrepaid;
  List<RvPricingPhase> pricingPhases;
  RvPricingPhase? freePhase;
  RvPricingPhase? introPhase;
  RvPricingPhase? fullPricePhase;
}

/// Mirrors `StoreProductDTO`.
class RvStoreProduct {
  RvStoreProduct({
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
  String id;
  RvProductType type;
  RvProductCategory productCategory;
  String displayName;
  String? description;
  String? priceString;
  double? price;
  String? currencyCode;
  RvPeriod? subscriptionPeriod;
  String? subscriptionGroupIdentifier;
  bool isFamilyShareable;
  RvIntroPrice? introPrice;
  List<RvDiscount> discounts;
  bool? isEligibleForIntroOffer;
  List<RvSubscriptionOption>? subscriptionOptions;
  RvSubscriptionOption? defaultOption;
  double? pricePerWeek;
  double? pricePerMonth;
  double? pricePerYear;
  String? pricePerWeekString;
  String? pricePerMonthString;
  String? pricePerYearString;
}

/// Mirrors `PackageDTO`.
class RvPackage {
  RvPackage({
    required this.identifier,
    this.packageType,
    required this.product,
  });
  String identifier;
  RvPackageType? packageType;
  RvStoreProduct product;
}

/// Mirrors `OfferingDTO`.
class RvOffering {
  RvOffering({
    required this.identifier,
    required this.isDefault,
    required this.packages,
  });
  String identifier;
  bool isDefault;
  List<RvPackage> packages;
}

/// Mirrors `OfferingsDTO`.
class RvOfferings {
  RvOfferings({this.current, required this.offerings});
  String? current;
  List<RvOffering> offerings;
}

/// Mirrors `PresentedContextDTO`.
class RvPresentedContext {
  RvPresentedContext({
    required this.placementId,
    required this.paywallId,
    this.variantId,
    this.experimentKey,
    required this.revision,
  });
  String placementId;
  String paywallId;
  String? variantId;
  String? experimentKey;
  int revision;
}

/// Mirrors `PaywallDTO`.
class RvPaywall {
  RvPaywall({
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
  String placementIdentifier;
  int placementRevision;
  String? paywallIdentifier;
  String? paywallName;
  int configFormatVersion;
  String? remoteConfigJson;
  String? remoteConfigLocale;
  String? builderConfigJson;
  RvOffering? offering;
  RvPresentedContext? presentedContext;
  bool servedFromFallback;
}

/// Mirrors `ExperimentAssignmentDTO`.
class RvExperimentAssignment {
  RvExperimentAssignment({
    required this.experimentId,
    required this.key,
    required this.variantId,
    required this.variantName,
    required this.valueJson,
  });
  String experimentId;
  String key;
  String variantId;
  String variantName;
  String valueJson;
}

/// Mirrors `PurchaseResultDTO`.
class RvPurchaseResult {
  RvPurchaseResult({
    required this.entitlements,
    required this.virtualCurrencies,
    required this.productId,
    required this.storeTransactionId,
    required this.isDeferred,
  });
  List<RvEntitlement> entitlements;
  Map<String, int> virtualCurrencies;
  String productId;
  String storeTransactionId;
  bool isDeferred;
}

/// Mirrors the `{ subscriberId, funnelAnswersJson }` shape returned by
/// `claimFunnelToken` / `claimInstall` / `claimFromClipboard` and emitted by
/// the `onFunnelClaimResolved` native event.
class RvFunnelClaim {
  RvFunnelClaim({required this.subscriberId, required this.funnelAnswersJson});
  String subscriberId;
  String funnelAnswersJson;
}

/// Mirrors `claimInstall`'s `params` object — all fields optional.
class RvClaimInstallParams {
  RvClaimInstallParams({
    this.platform,
    this.locale,
    this.timezone,
    this.screenDims,
    this.deviceModel,
    this.installReferrer,
  });
  String? platform;
  String? locale;
  String? timezone;
  String? screenDims;
  String? deviceModel;
  String? installReferrer;
}

/// Mirrors the native `onChange` event payload (`{ event: ChangeEvent }`).
class RvChangeEvent {
  RvChangeEvent({required this.kind});
  RvChangeEventKind kind;
}

/// Mirrors `LogEntryDTO`.
class RvLogRecord {
  RvLogRecord({required this.level, required this.message, required this.fields});
  RvLogLevel level;
  String message;
  Map<String, String> fields;
}

// ---------------------------------------------------------------------------
// Host API — Dart calling into native (Swift / Kotlin). One method per
// `RovenueModuleSpec` member in RovenueModule.types.ts, same name, same
// order, minus `addListener`/`removeListeners` (see file header).
// ---------------------------------------------------------------------------

@HostApi()
abstract class RovenueHostApi {
  // Lifecycle
  void configure(
    String apiKey,
    String? baseUrl,
    RvLogLevel logLevel,
    String? appVersion,
    String? environment,
  );
  void shutdown();
  void setForeground(bool foreground);
  String getVersion();
  String? getAppVersion();

  // Identity
  @async
  RvUser currentUser();
  @async
  void identify(String appUserId);
  @async
  void logOut();

  // Entitlements
  @async
  RvEntitlement? entitlement(String id);
  @async
  List<RvEntitlement> entitlementsAll();
  @async
  void refreshEntitlements();

  // Virtual currencies
  @async
  Map<String, int> virtualCurrencies();
  @async
  int virtualCurrency(String code);
  @async
  void refreshVirtualCurrencies();

  // Purchases / placements
  @async
  RvOfferings getOfferings();
  @async
  RvPaywall? getPaywall(String placementId, String? locale);
  @async
  int setFallbackPlacements(String json);
  @async
  RvPurchaseResult purchase(
    String productId,
    RvProductType productType,
    String? promotionalOfferId,
    String? basePlanId,
    String? offerId,
  );
  @async
  RvPurchaseResult restorePurchases();

  // Remote Config
  @async
  void refreshRemoteConfig();
  @async
  bool remoteConfigBool(String key, bool fallback);
  @async
  String remoteConfigString(String key, String fallback);
  @async
  int remoteConfigInt(String key, int fallback);
  @async
  double remoteConfigDouble(String key, double fallback);
  @async
  String? remoteConfigJson(String key);
  @async
  List<String> remoteConfigKeys();
  @async
  String remoteConfigAllJson();
  @async
  RvExperimentAssignment? experiment(String key);
  @async
  List<RvExperimentAssignment> experimentsAll();

  // Refund Shield
  @async
  String getAppAccountToken();
  @async
  void recordSessionEvent(
    RvSessionEventKind kind,
    String occurredAt,
    int? durationMs,
  );
  @async
  int flushSessionEvents();

  // Funnel attribution
  @async
  RvFunnelClaim claimFunnelToken(String token);
  @async
  RvFunnelClaim? claimInstall(RvClaimInstallParams params);
  @async
  void claimViaEmail(String email);
  @async
  RvFunnelClaim? claimFromClipboard();
  @async
  String installId();
  @async
  bool hasResolvedFunnelClaim();

  // Generic events
  @async
  void track(String envelopeJson);
  @async
  void enqueuePaywallEvent(String envelopeJson);

  // Subscriber attributes
  @async
  void setAttributes(Map<String, String?> attributes);
  @async
  void setEmail(String? email);
  @async
  void setDisplayName(String? name);
  @async
  void setPhoneNumber(String? phone);
  @async
  void setPushToken(String? token);
  @async
  int flushAttributes();
}

// ---------------------------------------------------------------------------
// Flutter API — native (Swift / Kotlin) calling into Dart. Mirrors the RN
// Expo `onChange` / `onLog` / `onFunnelClaimResolved` native events.
// ---------------------------------------------------------------------------

@FlutterApi()
abstract class RovenueFlutterApi {
  void onChange(RvChangeEvent event);
  void onLog(RvLogRecord record);
  void onFunnelClaim(RvFunnelClaim claim);
}
