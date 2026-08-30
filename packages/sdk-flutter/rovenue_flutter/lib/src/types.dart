// Re-exports of `rovenue_flutter_platform_interface`'s public surface —
// models, [RovenueException]/[RovenueErrorKind] — so app code depends only
// on `package:rovenue_flutter/rovenue_flutter.dart` and never has to reach
// into the platform-interface package directly. No Flutter-specific extras
// exist yet; this file is the single seam to add them (e.g. Widget-facing
// helpers) without touching the barrel or the platform-interface package.
export 'package:rovenue_flutter_platform_interface/rovenue_flutter_platform_interface.dart'
    show
        RovenueErrorKind,
        RovenueException,
        RovenueUser,
        Entitlement,
        ProductType,
        ProductCategory,
        PeriodUnit,
        PaymentMode,
        DiscountType,
        RecurrenceMode,
        PackageType,
        SessionEventKind,
        RovenueChangeKind,
        RovenueLogLevel,
        RovenuePeriod,
        IntroPrice,
        Discount,
        PricingPhase,
        SubscriptionOption,
        StoreProduct,
        RovenuePackage,
        Offering,
        Offerings,
        PresentedContext,
        Paywall,
        ExperimentAssignment,
        PurchaseResult,
        FunnelClaim,
        ClaimInstallParams,
        RovenueChangeEvent,
        RovenueLogRecord;
