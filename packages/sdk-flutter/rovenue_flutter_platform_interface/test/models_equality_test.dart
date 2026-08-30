// Value-equality coverage for the public models that previously had
// `toString()` only (Task 6 carry-forward item #1): StoreProduct, Offering,
// Offerings, Paywall, SubscriptionOption, PurchaseResult — plus
// RovenuePackage and PresentedContext, whose own equality had to be added
// too because Offering/Paywall embed them and list/field equality is only
// meaningful if the nested types compare by value as well.
//
// These models cross into `rovenue_flutter` app code that will put them in
// `setState`/`ValueNotifier`/`didUpdateWidget` comparisons, so `==`/
// `hashCode` must (a) treat two structurally-identical-but-different
// instances as equal and (b) treat any single-field change as unequal.
// PurchaseResult gets the most thorough coverage per the brief ("matters
// most") since it nests a `List<Entitlement>`.
import 'package:flutter_test/flutter_test.dart';
import 'package:rovenue_flutter_platform_interface/src/models.dart';

StoreProduct _product({String id = 'com.app.pro.monthly'}) => StoreProduct(
      id: id,
      type: ProductType.subscription,
      productCategory: ProductCategory.subscription,
      displayName: 'Pro Monthly',
      isFamilyShareable: false,
      discounts: const <Discount>[],
    );

SubscriptionOption _option({String id = 'monthly'}) => SubscriptionOption(
      id: id,
      tags: const <String>['tag1'],
      isBasePlan: true,
      isPrepaid: false,
      pricingPhases: const <PricingPhase>[],
    );

void main() {
  group('RovenuePackage', () {
    test('equal when fields match', () {
      final a = RovenuePackage(identifier: 'pkg', packageType: PackageType.monthly, product: _product());
      final b = RovenuePackage(identifier: 'pkg', packageType: PackageType.monthly, product: _product());
      expect(a, equals(b));
      expect(a.hashCode, equals(b.hashCode));
    });

    test('unequal when the nested product differs', () {
      final a = RovenuePackage(identifier: 'pkg', product: _product(id: 'a'));
      final b = RovenuePackage(identifier: 'pkg', product: _product(id: 'b'));
      expect(a, isNot(equals(b)));
    });
  });

  group('Offering', () {
    test('equal when the package list matches by value, not identity', () {
      final a = Offering(identifier: 'default', isDefault: true, packages: <RovenuePackage>[
        RovenuePackage(identifier: 'pkg', product: _product()),
      ]);
      final b = Offering(identifier: 'default', isDefault: true, packages: <RovenuePackage>[
        RovenuePackage(identifier: 'pkg', product: _product()),
      ]);
      expect(identical(a.packages, b.packages), isFalse);
      expect(a, equals(b));
      expect(a.hashCode, equals(b.hashCode));
    });

    test('unequal when a package list differs', () {
      final a = Offering(identifier: 'default', isDefault: true, packages: <RovenuePackage>[
        RovenuePackage(identifier: 'pkg1', product: _product()),
      ]);
      final b = Offering(identifier: 'default', isDefault: true, packages: <RovenuePackage>[
        RovenuePackage(identifier: 'pkg2', product: _product()),
      ]);
      expect(a, isNot(equals(b)));
    });
  });

  group('Offerings', () {
    test('equal by value across independent instances', () {
      Offerings build() => const Offerings(current: 'default', offerings: <Offering>[
            Offering(identifier: 'default', isDefault: true, packages: <RovenuePackage>[]),
          ]);
      expect(build(), equals(build()));
      expect(build().hashCode, equals(build().hashCode));
    });

    test('unequal when current differs', () {
      const a = Offerings(current: 'default', offerings: <Offering>[]);
      const b = Offerings(current: 'promo', offerings: <Offering>[]);
      expect(a, isNot(equals(b)));
    });
  });

  group('PresentedContext', () {
    test('equal by value; unequal on a single differing field', () {
      const a = PresentedContext(placementId: 'p', paywallId: 'w', revision: 1);
      const b = PresentedContext(placementId: 'p', paywallId: 'w', revision: 1);
      const c = PresentedContext(placementId: 'p', paywallId: 'w', revision: 2);
      expect(a, equals(b));
      expect(a.hashCode, equals(b.hashCode));
      expect(a, isNot(equals(c)));
    });
  });

  group('Paywall', () {
    Paywall build({int revision = 1}) => Paywall(
          placementIdentifier: 'home',
          placementRevision: revision,
          configFormatVersion: 1,
          offering: const Offering(identifier: 'default', isDefault: true, packages: <RovenuePackage>[]),
          presentedContext: const PresentedContext(placementId: 'home', paywallId: 'w', revision: 1),
          servedFromFallback: false,
        );

    test('equal by value including nested offering/presentedContext', () {
      expect(build(), equals(build()));
      expect(build().hashCode, equals(build().hashCode));
    });

    test('unequal when a scalar field differs', () {
      expect(build(revision: 1), isNot(equals(build(revision: 2))));
    });
  });

  group('SubscriptionOption', () {
    test('equal by value including pricing-phase and tag lists', () {
      expect(_option(), equals(_option()));
      expect(_option().hashCode, equals(_option().hashCode));
    });

    test('unequal when tags differ', () {
      const a = SubscriptionOption(
        id: 'monthly',
        tags: <String>['a'],
        isBasePlan: true,
        isPrepaid: false,
        pricingPhases: <PricingPhase>[],
      );
      const b = SubscriptionOption(
        id: 'monthly',
        tags: <String>['b'],
        isBasePlan: true,
        isPrepaid: false,
        pricingPhases: <PricingPhase>[],
      );
      expect(a, isNot(equals(b)));
    });
  });

  group('StoreProduct', () {
    test('equal by value across independent instances', () {
      expect(_product(), equals(_product()));
      expect(_product().hashCode, equals(_product().hashCode));
    });

    test('unequal when price differs', () {
      const a = StoreProduct(
        id: 'p',
        type: ProductType.subscription,
        productCategory: ProductCategory.subscription,
        displayName: 'Pro',
        isFamilyShareable: false,
        discounts: <Discount>[],
        price: 9.99,
      );
      const b = StoreProduct(
        id: 'p',
        type: ProductType.subscription,
        productCategory: ProductCategory.subscription,
        displayName: 'Pro',
        isFamilyShareable: false,
        discounts: <Discount>[],
        price: 19.99,
      );
      expect(a, isNot(equals(b)));
    });

    test('unequal when discounts list differs', () {
      const discount = Discount(
        price: 4.99,
        period: RovenuePeriod(value: 1, unit: PeriodUnit.month, iso8601: 'P1M'),
        numberOfPeriods: 1,
        paymentMode: PaymentMode.payAsYouGo,
        type: DiscountType.introductory,
      );
      const a = StoreProduct(
        id: 'p',
        type: ProductType.subscription,
        productCategory: ProductCategory.subscription,
        displayName: 'Pro',
        isFamilyShareable: false,
        discounts: <Discount>[discount],
      );
      const b = StoreProduct(
        id: 'p',
        type: ProductType.subscription,
        productCategory: ProductCategory.subscription,
        displayName: 'Pro',
        isFamilyShareable: false,
        discounts: <Discount>[],
      );
      expect(a, isNot(equals(b)));
    });
  });

  group('PurchaseResult — matters most (nested Entitlement list)', () {
    // Deliberately NOT `const` at the list level: a const list literal would
    // be canonicalized by the compiler, making `a.entitlements` and
    // `b.entitlements` the same object across two `build()` calls and
    // defeating the point of this test (proving structural, not identity,
    // equality). Individual `Map` entries are still plain literals for the
    // same reason.
    PurchaseResult build() =>
        // ignore: prefer_const_constructors
        PurchaseResult(
          // ignore: prefer_const_literals_to_create_immutables
          entitlements: <Entitlement>[
            const Entitlement(id: 'pro', active: true, expiresAt: '2030-01-01T00:00:00Z', productId: 'com.app.pro'),
          ],
          // ignore: prefer_const_literals_to_create_immutables
          virtualCurrencies: <String, int>{'gems': 100},
          productId: 'com.app.pro.monthly',
          storeTransactionId: 'txn_123',
          isDeferred: false,
        );

    test('two independently-built instances with equal nested lists/maps are equal', () {
      final a = build();
      final b = build();
      expect(identical(a.entitlements, b.entitlements), isFalse);
      expect(a, equals(b));
      expect(a.hashCode, equals(b.hashCode));
    });

    test('unequal when a nested entitlement differs', () {
      final a = build();
      const b = PurchaseResult(
        entitlements: <Entitlement>[
          Entitlement(id: 'pro', active: false, expiresAt: '2030-01-01T00:00:00Z', productId: 'com.app.pro'),
        ],
        virtualCurrencies: <String, int>{'gems': 100},
        productId: 'com.app.pro.monthly',
        storeTransactionId: 'txn_123',
        isDeferred: false,
      );
      expect(a, isNot(equals(b)));
    });

    test('unequal when virtualCurrencies map differs', () {
      final a = build();
      final b = PurchaseResult(
        entitlements: a.entitlements,
        virtualCurrencies: const <String, int>{'gems': 200},
        productId: a.productId,
        storeTransactionId: a.storeTransactionId,
        isDeferred: a.isDeferred,
      );
      expect(a, isNot(equals(b)));
    });

    test('unequal when isDeferred differs', () {
      final a = build();
      final b = PurchaseResult(
        entitlements: a.entitlements,
        virtualCurrencies: a.virtualCurrencies,
        productId: a.productId,
        storeTransactionId: a.storeTransactionId,
        isDeferred: true,
      );
      expect(a, isNot(equals(b)));
    });
  });
}
