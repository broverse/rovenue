// HostApiImpl.swift — `RovenueHostApi` implementation. Thin adapter from
// the Pigeon-generated completion-handler surface to the Swift façade
// (`Rovenue.shared`, `packages/sdk-swift`).
//
// Mirrors `packages/sdk-rn/ios/RovenueModule.swift` method by method — the
// differences are Pigeon `Rv*` DTOs instead of Expo's `[String: Any?]`
// dicts, `PigeonError` instead of Expo `Exception`s, and completion-handler
// style instead of Expo's `AsyncFunction`/promises.
//
// Every method that can fail funnels its catch block through `fail(_:)`
// (Mapping.swift) so the `PigeonError.code` is always one of the 24 UDL
// `ErrorKind` variant names Task 3's Dart mapper expects.

import Foundation
#if os(iOS)
  import Flutter
  import UIKit
#elseif os(macOS)
  import FlutterMacOS
#else
  #error("Unsupported platform.")
#endif
import Rovenue

final class HostApiImpl: NSObject, RovenueHostApi {
  private let eventBridge: EventBridge

  /// The version `configure` actually resolved (from an explicit
  /// `appVersion` argument, or auto-read from the host bundle), so
  /// `getAppVersion` can report back what was NOT passed explicitly.
  /// Mirrors `RovenueModule.swift`'s `resolvedAppVersion`.
  private var resolvedAppVersion: String?

  init(eventBridge: EventBridge) {
    self.eventBridge = eventBridge
  }

  // ---------------- Sync ----------------

  func configure(
    apiKey: String,
    baseUrl: String?,
    logLevel: RvLogLevel,
    appVersion: String?,
    environment: String?
  ) throws {
    let resolved =
      appVersion ?? (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)
    resolvedAppVersion = resolved
    do {
      try Rovenue.configure(
        apiKey: apiKey,
        baseUrl: baseUrl,
        logLevel: mapLogLevel(logLevel),
        appVersion: resolved,
        environment: environment
      )
    } catch {
      throw fail(error)
    }
    // Subscribe once configure() has actually produced a shared instance —
    // see EventBridge's doc comment for why this lives here rather than a
    // dedicated lifecycle hook (Pigeon has none).
    eventBridge.start()
  }

  func shutdown() throws {
    Rovenue.shared.shutdown()
  }

  func setForeground(foreground: Bool) throws {
    Rovenue.shared.setForeground(foreground)
  }

  func getVersion() throws -> String {
    Rovenue.shared.version
  }

  func getAppVersion() throws -> String? {
    resolvedAppVersion
  }

  // ---------------- Identity ----------------

  func currentUser(completion: @escaping (Result<RvUser, Error>) -> Void) {
    Task {
      let u = await Rovenue.shared.currentUser()
      completion(.success(mapUser(u)))
    }
  }

  func identify(appUserId: String, completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.identify(appUserId)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func logOut(completion: @escaping (Result<Void, Error>) -> Void) {
    guard #available(iOS 15.0, macOS 12.0, *) else {
      completion(.failure(availabilityError("logOut requires iOS 15 / macOS 12 or newer")))
      return
    }
    Task {
      do {
        try await Rovenue.shared.logOut()
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  // ---------------- Entitlements ----------------

  func entitlement(id: String, completion: @escaping (Result<RvEntitlement?, Error>) -> Void) {
    Task {
      let e = await Rovenue.shared.entitlement(id)
      completion(.success(e.map(mapEntitlement)))
    }
  }

  func entitlementsAll(completion: @escaping (Result<[RvEntitlement], Error>) -> Void) {
    Task {
      let all = await Rovenue.shared.entitlementsAll()
      completion(.success(all.map(mapEntitlement)))
    }
  }

  func refreshEntitlements(completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.refreshEntitlements()
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  // ---------------- Virtual Currencies ----------------

  func virtualCurrencies(completion: @escaping (Result<[String: Int64], Error>) -> Void) {
    Task {
      completion(.success(await Rovenue.shared.virtualCurrencyBalances()))
    }
  }

  func virtualCurrency(code: String, completion: @escaping (Result<Int64, Error>) -> Void) {
    Task {
      completion(.success(await Rovenue.shared.virtualCurrency(code)))
    }
  }

  func refreshVirtualCurrencies(completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.refreshVirtualCurrencies()
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  // ---------------- Purchases / Placements ----------------

  func getOfferings(completion: @escaping (Result<RvOfferings, Error>) -> Void) {
    guard #available(iOS 15.0, macOS 12.0, *) else {
      completion(.failure(availabilityError("Offerings require iOS 15 / macOS 12 or newer")))
      return
    }
    Task {
      do {
        let o = try await Rovenue.shared.getOfferings()
        completion(.success(mapOfferings(o)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func getPaywall(
    placementId: String, locale: String?,
    completion: @escaping (Result<RvPaywall?, Error>) -> Void
  ) {
    guard #available(iOS 15.0, macOS 12.0, *) else {
      completion(.failure(availabilityError("Placements require iOS 15 / macOS 12 or newer")))
      return
    }
    Task {
      do {
        guard let p = try await Rovenue.shared.getPaywall(placementId: placementId, locale: locale)
        else {
          completion(.success(nil))
          return
        }
        completion(.success(mapPaywall(p)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func setFallbackPlacements(json: String, completion: @escaping (Result<Int64, Error>) -> Void) {
    do {
      let n = try Rovenue.shared.setFallbackPlacements(json: json)
      completion(.success(Int64(n)))
    } catch {
      completion(.failure(fail(error)))
    }
  }

  func purchase(
    productId: String, productType: RvProductType, promotionalOfferId: String?,
    basePlanId: String?, offerId: String?,
    completion: @escaping (Result<RvPurchaseResult, Error>) -> Void
  ) {
    // basePlanId/offerId select a Play subscription offer on Android;
    // ignored on iOS — mirrors RovenueModule.swift.
    guard #available(iOS 15.0, macOS 12.0, *) else {
      completion(.failure(availabilityError("Purchases require iOS 15 / macOS 12 or newer")))
      return
    }
    // The façade re-resolves the real StoreKit product by id, so
    // displayName/price are not needed here.
    let product = StoreProduct(
      id: productId,
      type: mapProductType(productType),
      productCategory: .subscription,
      displayName: "",
      description: nil,
      priceString: nil,
      price: nil,
      currencyCode: nil,
      subscriptionPeriod: nil,
      subscriptionGroupIdentifier: nil,
      isFamilyShareable: false,
      introPrice: nil,
      discounts: [],
      isEligibleForIntroOffer: nil,
      subscriptionOptions: nil,
      defaultOption: nil,
      pricePerWeek: nil,
      pricePerMonth: nil,
      pricePerYear: nil,
      pricePerWeekString: nil,
      pricePerMonthString: nil,
      pricePerYearString: nil,
      rawStoreProduct: nil
    )
    Task {
      do {
        let r: PurchaseResult
        if let offer = promotionalOfferId {
          r = try await Rovenue.shared.purchase(product, promotionalOfferId: offer)
        } else {
          r = try await Rovenue.shared.purchase(product)
        }
        completion(.success(mapPurchaseResult(r)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func restorePurchases(completion: @escaping (Result<RvPurchaseResult, Error>) -> Void) {
    guard #available(iOS 15.0, macOS 12.0, *) else {
      completion(.failure(availabilityError("Restore requires iOS 15 / macOS 12 or newer")))
      return
    }
    Task {
      do {
        let r = try await Rovenue.shared.restorePurchases()
        completion(.success(mapPurchaseResult(r)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  // ---------------- Remote Config ----------------

  func refreshRemoteConfig(completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.refreshRemoteConfig()
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func remoteConfigBool(
    key: String, fallback: Bool, completion: @escaping (Result<Bool, Error>) -> Void
  ) {
    Task {
      completion(.success(await Rovenue.shared.remoteConfigBool(key, default: fallback)))
    }
  }

  func remoteConfigString(
    key: String, fallback: String, completion: @escaping (Result<String, Error>) -> Void
  ) {
    Task {
      completion(.success(await Rovenue.shared.remoteConfigString(key, default: fallback)))
    }
  }

  func remoteConfigInt(
    key: String, fallback: Int64, completion: @escaping (Result<Int64, Error>) -> Void
  ) {
    Task {
      completion(.success(await Rovenue.shared.remoteConfigInt(key, default: fallback)))
    }
  }

  func remoteConfigDouble(
    key: String, fallback: Double, completion: @escaping (Result<Double, Error>) -> Void
  ) {
    Task {
      completion(.success(await Rovenue.shared.remoteConfigDouble(key, default: fallback)))
    }
  }

  func remoteConfigJson(key: String, completion: @escaping (Result<String?, Error>) -> Void) {
    Task {
      completion(.success(await Rovenue.shared.remoteConfigJSON(key)))
    }
  }

  func remoteConfigKeys(completion: @escaping (Result<[String], Error>) -> Void) {
    Task {
      completion(.success(await Rovenue.shared.remoteConfigKeys()))
    }
  }

  func remoteConfigAllJson(completion: @escaping (Result<String, Error>) -> Void) {
    Task {
      completion(.success(await Rovenue.shared.remoteConfigAllJSON()))
    }
  }

  func experiment(
    key: String, completion: @escaping (Result<RvExperimentAssignment?, Error>) -> Void
  ) {
    Task {
      let a = await Rovenue.shared.experiment(key)
      completion(.success(a.map(mapExperimentAssignment)))
    }
  }

  func experimentsAll(completion: @escaping (Result<[RvExperimentAssignment], Error>) -> Void) {
    Task {
      let all = await Rovenue.shared.experimentsAll()
      completion(.success(all.map(mapExperimentAssignment)))
    }
  }

  // ---------------- Refund Shield ----------------

  func getAppAccountToken(completion: @escaping (Result<String, Error>) -> Void) {
    Task {
      do {
        let token = try await Rovenue.shared.getAppAccountToken()
        completion(.success(token))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func recordSessionEvent(
    kind: RvSessionEventKind, occurredAt: String, durationMs: Int64?,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    Task {
      do {
        try await Rovenue.shared.recordSessionEvent(
          kind: mapSessionEventKind(kind),
          occurredAt: occurredAt,
          durationMs: durationMs.map { UInt32($0) }
        )
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func flushSessionEvents(completion: @escaping (Result<Int64, Error>) -> Void) {
    Task {
      do {
        let n = try await Rovenue.shared.flushSessionEvents()
        completion(.success(Int64(n)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  // ---------------- Funnel Claim ----------------

  func claimFunnelToken(
    token: String, completion: @escaping (Result<RvFunnelClaim, Error>) -> Void
  ) {
    Task {
      do {
        let r = try await Rovenue.shared.claimFunnelToken(token)
        completion(.success(mapFunnelClaim(r)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func claimInstall(
    params: RvClaimInstallParams, completion: @escaping (Result<RvFunnelClaim?, Error>) -> Void
  ) {
    Task {
      do {
        let r = try await Rovenue.shared.claimInstall(mapClaimInstallParams(params))
        completion(.success(r.map(mapFunnelClaim)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func claimViaEmail(email: String, completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.claimViaEmail(email)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func claimFromClipboard(completion: @escaping (Result<RvFunnelClaim?, Error>) -> Void) {
    #if os(iOS)
      Task {
        let marker = "rovenue-funnel:"
        let raw: String? = await MainActor.run { UIPasteboard.general.string }
        guard let s = raw, s.hasPrefix(marker) else {
          completion(.success(nil))
          return
        }
        let token = String(s.dropFirst(marker.count))
        guard !token.isEmpty else {
          completion(.success(nil))
          return
        }
        do {
          let r = try await Rovenue.shared.claimFunnelToken(token)
          // Clear only our own marked content so it isn't re-claimed/leaked.
          await MainActor.run {
            if UIPasteboard.general.string?.hasPrefix(marker) == true {
              UIPasteboard.general.string = ""
            }
          }
          completion(.success(mapFunnelClaim(r)))
        } catch {
          completion(.failure(fail(error)))
        }
      }
    #else
      // No pasteboard-based funnel attribution on macOS; the production
      // plugin only ships for iOS (see pubspec.yaml).
      completion(.success(nil))
    #endif
  }

  func installId(completion: @escaping (Result<String, Error>) -> Void) {
    completion(.success(Rovenue.shared.installId()))
  }

  func hasResolvedFunnelClaim(completion: @escaping (Result<Bool, Error>) -> Void) {
    completion(.success(Rovenue.shared.hasResolvedFunnelClaim()))
  }

  // ---------------- Generic events ----------------

  func track(envelopeJson: String, completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.track(envelopeJson: envelopeJson)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func enqueuePaywallEvent(
    envelopeJson: String, completion: @escaping (Result<Void, Error>) -> Void
  ) {
    Task {
      do {
        try await Rovenue.shared.enqueuePaywallEvent(envelopeJson: envelopeJson)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  // ---------------- Subscriber Attributes ----------------

  func setAttributes(
    attributes: [String: String?], completion: @escaping (Result<Void, Error>) -> Void
  ) {
    Task {
      do {
        try await Rovenue.shared.setAttributes(attributes)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func setEmail(email: String?, completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.setEmail(email)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func setDisplayName(name: String?, completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.setDisplayName(name)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func setPhoneNumber(phone: String?, completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.setPhoneNumber(phone)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func setPushToken(token: String?, completion: @escaping (Result<Void, Error>) -> Void) {
    Task {
      do {
        try await Rovenue.shared.setPushToken(token)
        completion(.success(()))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }

  func flushAttributes(completion: @escaping (Result<Int64, Error>) -> Void) {
    Task {
      do {
        let n = try await Rovenue.shared.flushAttributes()
        completion(.success(Int64(n)))
      } catch {
        completion(.failure(fail(error)))
      }
    }
  }
}
