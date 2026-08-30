// HostApiImplTests.swift — unit tests for Mapping.swift's façade → Pigeon
// DTO conversions and the `fail(_:)` error mapper.
//
// Run via `swift test` (see `../Package.swift` for why this is a
// SwiftPM-only test target rather than an Xcode/`xcodebuild` one — the
// example app that would host an `xcodebuild test` target doesn't exist
// until Task 8).

import XCTest

@testable import RovenueFlutterIosCore
import Rovenue

final class HostApiImplTests: XCTestCase {

  // MARK: - Entitlement with expiresAt nil

  func testMapEntitlement_expiresAtNil() {
    let e = Entitlement(
      id: "ent_pro",
      isActive: true,
      productIdentifier: "com.rovenue.pro.monthly",
      store: "app_store",
      expiresIso: nil
    )
    let dto = mapEntitlement(e)
    XCTAssertEqual(dto.id, "ent_pro")
    XCTAssertTrue(dto.active)
    XCTAssertNil(dto.expiresAt)
    XCTAssertEqual(dto.productId, "com.rovenue.pro.monthly")
  }

  // MARK: - Offering with two packages

  func testMapOffering_twoPackages() {
    func product(_ id: String) -> StoreProduct {
      StoreProduct(
        id: id,
        type: .subscription,
        productCategory: .subscription,
        displayName: "Pro (\(id))",
        description: nil,
        priceString: "$9.99",
        price: Decimal(9.99),
        currencyCode: "USD",
        subscriptionPeriod: Period(value: 1, unit: .month, iso8601: "P1M"),
        subscriptionGroupIdentifier: "group1",
        isFamilyShareable: false,
        introPrice: nil,
        discounts: [],
        isEligibleForIntroOffer: nil,
        subscriptionOptions: nil,
        defaultOption: nil,
        pricePerWeek: nil,
        pricePerMonth: Decimal(9.99),
        pricePerYear: nil,
        pricePerWeekString: nil,
        pricePerMonthString: "$9.99",
        pricePerYearString: nil,
        rawStoreProduct: nil
      )
    }

    let offering = Offering(
      identifier: "default",
      isDefault: true,
      packages: [
        Package(identifier: "$rov_monthly", packageType: .monthly, product: product("monthly_id")),
        Package(identifier: "$rov_annual", packageType: .annual, product: product("annual_id")),
      ]
    )

    let dto = mapOffering(offering)
    XCTAssertEqual(dto.identifier, "default")
    XCTAssertTrue(dto.isDefault)
    XCTAssertEqual(dto.packages.count, 2)
    XCTAssertEqual(dto.packages[0].identifier, "$rov_monthly")
    XCTAssertEqual(dto.packages[0].packageType, .monthly)
    XCTAssertEqual(dto.packages[0].product.id, "monthly_id")
    XCTAssertEqual(dto.packages[1].identifier, "$rov_annual")
    XCTAssertEqual(dto.packages[1].packageType, .annual)
    XCTAssertEqual(dto.packages[1].product.id, "annual_id")
    // Android-only fields must stay nil on the iOS mapper.
    XCTAssertNil(dto.packages[0].product.subscriptionOptions)
    XCTAssertNil(dto.packages[0].product.defaultOption)
  }

  // MARK: - Purchase result

  func testMapPurchaseResult() {
    let entitlement = Entitlement(
      id: "ent_pro",
      isActive: true,
      productIdentifier: "monthly_id",
      store: "app_store",
      expiresIso: "2027-01-01T00:00:00Z"
    )
    let result = PurchaseResult(
      entitlements: [entitlement],
      virtualCurrencies: ["gems": 100],
      productId: "monthly_id",
      storeTransactionId: "txn_123",
      isDeferred: false
    )

    let dto = mapPurchaseResult(result)
    XCTAssertEqual(dto.entitlements.count, 1)
    XCTAssertEqual(dto.entitlements[0].id, "ent_pro")
    XCTAssertEqual(dto.entitlements[0].expiresAt, "2027-01-01T00:00:00Z")
    XCTAssertEqual(dto.virtualCurrencies["gems"], 100)
    XCTAssertEqual(dto.productId, "monthly_id")
    XCTAssertEqual(dto.storeTransactionId, "txn_123")
    XCTAssertFalse(dto.isDeferred)
  }

  // MARK: - Error conversion

  func testFail_purchaseCanceled() {
    let error = RovenueError(
      kind: .purchaseCanceled,
      message: "The user canceled the purchase sheet.",
      serverCode: nil,
      httpStatus: nil
    )
    let pigeonError = fail(error)

    XCTAssertEqual(pigeonError.code, "PurchaseCanceled")
    XCTAssertEqual(pigeonError.message, "The user canceled the purchase sheet.")

    let details = pigeonError.details as? [String: Any]
    XCTAssertEqual(details?["detail"] as? String, "The user canceled the purchase sheet.")
    XCTAssertEqual(details?["retryable"] as? Bool, false)
  }

  /// Every UDL `ErrorKind` variant must round-trip to its exact PascalCase
  /// name — this is the binding error contract from task-4-context.md.
  /// Exercises all 24 names in one pass so a future core-rs addition (which
  /// would fail to compile `ErrorKind.udlVariantName`'s exhaustive switch)
  /// is also caught here if the switch is ever relaxed with a `default:`.
  func testFail_allErrorKindsMapToUdlVariantNames() {
    let expected: [ErrorKind: String] = [
      .networkUnavailable: "NetworkUnavailable",
      .timeout: "Timeout",
      .rateLimited: "RateLimited",
      .serverError: "ServerError",
      .invalidApiKey: "InvalidApiKey",
      .forbidden: "Forbidden",
      .notFound: "NotFound",
      .invalidRequest: "InvalidRequest",
      .conflict: "Conflict",
      .invalidArgument: "InvalidArgument",
      .insufficientCredits: "InsufficientCredits",
      .funnelTokenNotFound: "FunnelTokenNotFound",
      .funnelTokenExpired: "FunnelTokenExpired",
      .funnelTokenAlreadyClaimed: "FunnelTokenAlreadyClaimed",
      .purchaseCanceled: "PurchaseCanceled",
      .productNotAvailable: "ProductNotAvailable",
      .alreadyOwned: "AlreadyOwned",
      .paymentDeclined: "PaymentDeclined",
      .storeServiceUnavailable: "StoreServiceUnavailable",
      .ineligible: "Ineligible",
      .receiptInvalid: "ReceiptInvalid",
      .storeProblem: "StoreProblem",
      .storage: "Storage",
      .internal: "Internal",
    ]
    for (kind, name) in expected {
      let error = RovenueError(kind: kind, message: "x")
      XCTAssertEqual(fail(error).code, name, "ErrorKind.\(kind) must map to \"\(name)\"")
    }
  }

  func testFail_nonRovenueError_mapsToInternal() {
    struct SomeOtherError: Error {}
    let pigeonError = fail(SomeOtherError())
    XCTAssertEqual(pigeonError.code, "Internal")
    let details = pigeonError.details as? [String: Any]
    XCTAssertEqual(details?["retryable"] as? Bool, false)
  }
}
