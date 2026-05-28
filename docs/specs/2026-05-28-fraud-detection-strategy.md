# Fraud Detection Strategy — App Store / Play Store / Stripe

**Date:** 2026-05-28
**Status:** Brainstorm / pre-spec

## 1. RevenueCat'in yaptıkları (referans)

- **Receipt validation:** StoreKit 2 JWS imza + zincir doğrulama (Apple Root CA), Play `InAppPurchase` RSA imza, Stripe webhook imza.
- **Sandbox isolation:** Sandbox receipt'ler prod projeye entitlement vermez.
- **Refund tracking:** App Store Server Notifications V2 (`REFUND`, `REFUND_REVERSED`, `REVOKE`), Google **Voided Purchases API** polling, Stripe `charge.refunded` / `charge.dispute.created`.
- **`CONSUMPTION_REQUEST` cevabı:** Apple refund talebine 12 saat içinde tüketim verisi geri yollayarak haksız refund onayını düşürür (büyük kaldıraç).
- **Refund-rate metriği:** Subscriber bazında 90 günlük refund oranı; dashboard'da "suspicious" etiketi.
- **Subscription transfer detection:** Aynı `originalTransactionId`'nin farklı `app_user_id` altında görünmesi → "transferred" işareti.
- **Promosyon teklif imzalama:** SKProductDiscount signature, abuse'a karşı per-user cap.
- **Customer block list:** Manuel ban.

## 2. Adapty'nin yaptıkları (referans)

- RC ile aynı temel: receipt validation, refund webhook'ları, sandbox isolation, block list.
- **Refund Saver:** Refund olasılığını tahmin eden ML modeli; yüksek riskli kullanıcılara paywall/teklif kısıtlama.
- **Transaction blocklist:** `original_transaction_id` bazında ban.
- **VPN / IP heuristikleri:** Sınırlı sinyal olarak skorlamada kullanılıyor.
- **Promosyon teklif tavanı:** Per-user redemption cap.

## 3. Rovenue için yapabileceklerimiz (mimariye uygun)

Mevcut taşlar lehimize çalışıyor: chain-pinned JWS doğrulayıcı, outbox → Kafka → ClickHouse, `subscriber_access` denormalized, `audit_logs` hash chain. Bunların üzerine eklenecekler:

### A. Temel (must-have, MVP)
1. **Voided Purchases poll worker** (Play): BullMQ saatlik job → `purchase.voided` outbox event → `subscriber_access` revoke + ClickHouse.
2. **App Store `CONSUMPTION_REQUEST` responder:** Apple notification gelince 12h içinde tüketim payload'ı (account tenure, refund history, sample content provided) geri yolla. En yüksek ROI'li tek özellik — RC/Adapty paywall'unun arkasında.
3. **Stripe fraud webhooks:** `radar.early_fraud_warning.created`, `charge.dispute.created`, `charge.refunded` → outbox → revoke. (Radar imzalı; Stripe tarafında zaten çalışıyor.)
4. **Sandbox/Prod ayrımı sertleştirme:** `revenue_events.environment` zorunlu; prod projede sandbox receipt entitlement vermez (audit log'a "rejected_sandbox" yaz).
5. **Receipt signature parity:** Play `InAppPurchase.json` + signature RSA doğrulaması (zaten Apple JWS yapılıyor); Stripe webhook secret rotation.

### B. Cross-account abuse tespiti
6. **`transaction_identity` tablosu:** `(project_id, original_transaction_id) → first_subscriber_id, distinct_subscriber_count, last_seen_at`. N>2 distinct subscriber → `fraud.shared_receipt` event.
7. **Trial abuse — device fingerprint:** SDK identify'ta cihaz parmak izi hash'i (vendor ID + model + locale); `(project_id, device_hash) → trial_count`. Eşik aşılırsa intro offer kapatılır.
8. **`appAccountToken` / `obfuscatedAccountId` zorunlulaması:** Her satın alma UUID'ye bağlanır; eksikse "unbound transaction" skoru.

### C. Skorlama ve dashboard
9. **Refund-rate ClickHouse mat view:** Subscriber bazında 30/90g refund ratio; threshold üstü → `fraud_score` kolonu.
10. **Anomaly query'leri:** "1 saatte 10+ subscriber üreten IP", "3+ aktif trial sub'lı device", "5+ refund/30g subscriber". Dashboard "Fraud Signals" paneli.
11. **Refund Saver-benzeri kural motoru** (v1: kural-tabanlı, v2: ML): yüksek riskli kullanıcıya paywall'da farklı teklif (no-trial / non-refundable offer family).

### D. Aksiyon ve denetlenebilirlik
12. **`subscriber_blocklist` per-project tablosu:** `original_transaction_id`, `device_hash`, `ip_hash` alanları; SDK identify + receipt validation hook'larında kontrol.
13. **Promo offer signing service:** Apple signed offers HMAC-SHA256; `(subscriber_id, offer_id)` redemption cap.
14. **Audit trail:** Her revoke/block `audit()` ile tx-içi yazılır → SHA-256 hash chain'de izlenebilir (compliance avantajı vs RC/Adapty).

## 4. Diferansiyasyon (RC/Adapty'de eksik)

- **Hash-chained audit log** her fraud aksiyonu için → enterprise/compliance satışında somut artı.
- **Self-host:** Fraud sinyalleri/IP hash'leri müşterinin kendi DB'sinde kalır (GDPR/KVKK).
- **Outbox üzerinden açık fraud event stream'i:** Müşteri kendi anti-fraud sistemini Kafka'dan besler.
- **Kural motoru'nu kullanıcı yazabilir** (config-as-code), RC'nin opak skoru gibi değil.

## 5. Önerilen sıralama

1. **Sprint 1:** A.1 (Voided Purchases worker) + A.2 (CONSUMPTION_REQUEST responder) + A.3 (Stripe fraud webhooks) — en yüksek ROI, mevcut webhook altyapısı üzerine.
2. **Sprint 2:** A.4 + A.5 + B.6 (transaction_identity) + D.12 (blocklist).
3. **Sprint 3:** B.7 + B.8 + C.9 + C.10 (skor + dashboard).
4. **Sprint 4:** C.11 (kural motoru) + D.13 (promo signing).

## 6. Açık sorular

- Device fingerprint için Rust core'da `librovenue` tarafına mı, façade'a mı bırakacağız? (Privacy + Apple App Tracking politikası gereği fingerprint sınırlı olmalı.)
- ML tabanlı Refund Saver'ı v2'de mi açacağız, yoksa kural motoru yeterli mi?
- Stripe Radar zaten ödeme tarafında çalıştığı için bizim ek skor üretmemiz gerekli mi, yoksa sadece relay mi?
