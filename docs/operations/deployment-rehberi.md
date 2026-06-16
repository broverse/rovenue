# Rovenue Deploy Rehberi (Adım Adım)

Bu rehber, Rovenue'yu **Docker Compose** ile (Coolify uyumlu) sıfırdan
production'a almak için gereken her şeyi sırasıyla anlatır. Tüm komutlar
repo kökünden, sunucu üzerinde çalıştırılır.

> Özet referans için ayrıca `docs/operations/deployment.md` (kısa runbook)
> ve değişmez kurallar için `docs/architecture/outbox-dispatcher.md` dosyalarına bakın.

---

## 0. Mimari — Neyi deploy ediyoruz?

Tek bir `docker-compose.yml` aşağıdaki servisleri ayağa kaldırır:

| Servis | Görevi | Port (host) |
|---|---|---|
| `caddy` | TLS termination + edge reverse proxy (ACME/Let's Encrypt) | 80, 443 |
| `api` | Hono API + **in-process outbox dispatcher** (tek instance) | 3000 |
| `dashboard` | React SPA (statik, image içinde Caddy ile servis edilir) | — (sadece edge) |
| `docs` | Fumadocs statik dokümantasyon | — (sadece edge) |
| `migrate` | Tek seferlik: Drizzle + ClickHouse migration'larını çalıştırıp çıkar | — |
| `db` | PostgreSQL 16 + pg_partman | 5433→5432 |
| `redis` | Cache + BullMQ kuyruğu | 6380→6379 |
| `clickhouse` | Analitik replika (Kafka Engine ile beslenir) | 8124→8123 |
| `redpanda` | Kafka-uyumlu streaming (outbox → CH hattı) | 19092, 9644 |
| `redpanda-console` | Topic/consumer inspector (prod'da auth arkasına alın) | 8080 |
| `notifier-worker` / `digest-scheduler` / `send-email-worker` / `send-push-worker` | Bildirim hattı worker'ları | — |

**Veri akışı:** App, OLTP yazımıyla aynı transaction'da `outbox_events`
satırı yazar → `api` içindeki outbox dispatcher bunu Redpanda'ya iter →
ClickHouse Kafka Engine topic'i tüketir. CDC yok, dual-write yok.

---

## 1. Ön gereksinimler

- [ ] **Docker + Compose v2** kurulu bir Linux host (Coolify de olur).
- [ ] **Node ≥ 22.7** (yalnızca image dışı işlemler/yerel build için; container'lar kendi runtime'ını taşır).
- [ ] **DNS A kayıtları** host IP'sine işaret etmeli:
  - `rovenue.io`, `edge.rovenue.io`, `app.rovenue.io`, `docs.rovenue.io`
  - Özel müşteri domain'leri için CNAME'ler de aynı host'a.
- [ ] **Apple Root CA `.cer` dosyaları** `./deploy/apple-certs/` içine konmalı
  (Apple Root CA G3 + Apple Inc Root). StoreKit JWS doğrulayıcı bunlar
  olmadan **fail-closed** olur; production'da zorunludur.
- [ ] 443/80 portları dışarıya açık (ACME HTTP/TLS challenge için).

---

## 2. Secret'ları hazırla — `.env`

`.env.example` dosyasını `.env`'e kopyala ve doldur:

```bash
cp .env.example .env
```

### 2a. Production'da ZORUNLU anahtarlar

Bunlar `apps/api/src/lib/env.ts` içindeki `superRefine` ile *boot anında*
doğrulanır; eksikse `api` ayağa **kalkmaz**:

| Değişken | Neden |
|---|---|
| `DATABASE_URL` | Postgres bağlantısı olmadan hiçbir istek karşılanamaz |
| `ENCRYPTION_KEY` | Store kimlik bilgilerini AES-256-GCM ile şifreler — **32-byte hex** (`openssl rand -hex 32`) |
| `BETTER_AUTH_SECRET` | Oturum şifreleme anahtarı (`openssl rand -hex 32`) |
| `UNSUB_SIGNING_KEY` | Tek-tık unsubscribe linklerini HMAC ile imzalar — **32-byte hex** |
| `APPLE_ROOT_CERTS_DIR` | Apple JWS x5c zincirini doğrular (default `/etc/rovenue/apple-certs`) |
| `PUBSUB_PUSH_AUDIENCE` | Google webhook'unun Pub/Sub OIDC token doğrulaması için — ⚠️ bkz. not |
| `CLICKHOUSE_URL` | Production'da analitik sorguları zorunlu |
| `CLICKHOUSE_PASSWORD` | Analitik reader kimlik doğrulaması |
| `KAFKA_BROKERS` | Analitik ingestion (Redpanda) zorunlu |

> ⚠️ **`PUBSUB_PUSH_AUDIENCE` `.env.example`'da listelenmiyor** ama
> production'da zorunlu. `.env`'e elle eklemeniz gerekir (Google Pub/Sub
> push subscription'ınızın audience değeri). Aksi halde `api` boot'ta
> "PUBSUB_PUSH_AUDIENCE is required in production" hatasıyla durur.

### 2b. OAuth (dashboard login için gerekli)

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

Better Auth yalnızca GitHub + Google OAuth kullanır (email/şifre yok).
OAuth uygulamalarının callback URL'lerini production domain'inize göre ayarlayın.

### 2c. Production değerlerini düzelt

`.env.example`'daki localhost default'ları production'a göre değiştirin:

```bash
NODE_ENV=production
BETTER_AUTH_URL=https://rovenue.io
DASHBOARD_URL=https://app.rovenue.io
VITE_API_URL=https://rovenue.io          # ⚠️ build-time! (bkz. 6. Değişmezler)
CANONICAL_HOSTS=rovenue.io,edge.rovenue.io,app.rovenue.io
TLS_EMAIL=ops@rovenue.io                  # gerçek operatör e-postası
OUTBOX_DISPATCHER_ENABLED=true            # sadece api'de true
TRUSTED_PROXY_COUNT=1                      # Caddy = 1 proxy
VITE_SELF_HOSTED=true                      # self-host'ta GitHub linkini gösterir
```

ClickHouse şifreleri SHA256 hash olarak verilir (`CLICKHOUSE_PASSWORD_SHA256`,
`CLICKHOUSE_READER_PASSWORD_SHA256`). Default'ları **mutlaka** değiştirin:

```bash
echo -n 'GUCLU_SIFRE' | sha256sum | awk '{print $1}'
```

### 2d. Opsiyonel ama önerilen

- **E-posta:** `EMAIL_PROVIDER=ses` (+ `AWS_SES_*`) veya `smtp` (+ `SMTP_*`), `EMAIL_FROM`.
- **iOS push:** `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT=production`.
- **Android push:** `FCM_SERVICE_ACCOUNT_JSON`.
- **FX kurları:** `OPEN_EXCHANGE_RATES_APP_ID`.
- **Platform billing (Stripe):** `BILLING_ENABLED=true` ise `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`, `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` zorunlu olur.

---

## 3. Image'ları build et

```bash
docker compose build
```

`api`, `dashboard` ve `docs` image'larını oluşturur. `dashboard` build'i
`VITE_API_URL`'i bundle'a gömer — bu değer **public api origin** olmalı
(docker-internal isim değil).

---

## 4. Veri katmanı + migration'lar

`migrate` servisi `api` ve worker'lardan önce otomatik çalışır, ama ilk
kurulumda elle çalıştırmak güvenlidir:

```bash
# Önce altyapıyı ayağa kaldır
docker compose up -d db redis clickhouse redpanda

# Drizzle (Postgres) + ClickHouse migration'larını uygula
docker compose run --rm migrate
```

`migrate` sırayla `pnpm --filter @rovenue/db db:migrate` ardından
`db:clickhouse:migrate` çalıştırıp `exit 0` verir. Hiçbir servis
migrate başarıyla bitmeden şema servis etmez (`depends_on:
service_completed_successfully`).

---

## 5. Her şeyi başlat

```bash
docker compose up -d
```

`api` + dört worker, `migrate` 0 ile çıkana kadar bekler. Caddy
`api`/`dashboard`/`docs` hazır olunca trafiği almaya başlar ve canonical
host'lar için ACME ile sertifika ister.

### (Opsiyonel) Geliştirme verisi seed et

```bash
docker compose run --rm migrate pnpm --filter @rovenue/db seed
```

---

## 6. Doğrulama (smoke test)

```bash
curl -fsS https://rovenue.io/health                              # 200 beklenir
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.rovenue.io/  # 200
curl -I https://docs.rovenue.io                                   # 200
```

Ek kontroller:

```bash
docker compose ps                          # tüm servisler healthy/up mı?
docker compose logs -f api                 # boot hatası / env validation hatası var mı?
docker compose logs migrate                # migration'lar başarılı mı?
# Redpanda console: http://<host>:8080 (prod'da auth arkasına alın!)
```

---

## 7. Değişmezler (KIRMA!)

- **Tek dispatcher:** Yalnızca `api` servisinde `OUTBOX_DISPATCHER_ENABLED=true`
  ve `replicas: 1`. Tüm worker'lar bunu `false` zorlar. İki dispatcher
  ClickHouse gelir agregatlarını **çift sayar**. `api`'yi yatay
  ölçeklemeden önce dispatcher'ı ayrı tek-replika bir worker'a taşıyın.
  Bkz. `docs/architecture/outbox-dispatcher.md`.
- **`caddy-data` volume'u kalıcı olmalı:** Kaybolursa her redeploy'da tüm
  TLS sertifikaları yeniden istenir ve Let's Encrypt rate-limit'e takılır.
- **`VITE_API_URL` build-time:** api origin'i değişirse `dashboard` image'ını
  yeniden build edin (`docker compose build dashboard`).
- **`digest-scheduler` tek replika:** BullMQ repeat-jobId idempotency sağlar
  ama birden fazla çalıştırmak tick başına işi boşa harcar.
- **ClickHouse user config'i `users.d`'de:** `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`
  env'lerini image'a vermeyin — entrypoint çakışan ikinci bir user tanımı üretir.

---

## 8. Geri alma (rollback)

```bash
docker compose down                 # named volume'ları korur (veri güvende)
git checkout <onceki-tag>
docker compose up -d --build
```

Migration'lar **ileri-yönlü**dür: şemayı değil, kodu geri alın.

---

## 9. DNS & TLS özel notları

- Canonical host'lar (`rovenue.io`, `*.rovenue.io`, `edge.rovenue.io`)
  standart ACME ile boot'ta sertifika alır.
- **Özel müşteri domain'leri** on-demand TLS kullanır; Caddy sertifika
  istemeden önce `api`'nin `internal:3001/internal/domains/check`
  endpoint'ine sorar. Bu sayede rastgele hostname spray saldırıları
  Let's Encrypt rate-limit'ini tetikleyemez.
- `INTERNAL_PORT=3001` compose'da **publish edilmez** — sadece Caddy
  docker ağı üzerinden erişebilir.

---

## Hızlı kontrol listesi

```
[ ] Docker + Compose v2, DNS A kayıtları, Apple .cer dosyaları
[ ] .env: prod-zorunlu anahtarlar (PUBSUB_PUSH_AUDIENCE dahil!) + OAuth + SHA256 CH şifreleri
[ ] NODE_ENV=production, *_URL'ler https://, OUTBOX_DISPATCHER_ENABLED=true
[ ] docker compose build
[ ] docker compose run --rm migrate
[ ] docker compose up -d
[ ] /health, app, docs smoke test 200
[ ] caddy-data volume kalıcı + redpanda-console auth arkasında
```
