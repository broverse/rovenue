# Alan 3 — Security & Compliance

> **Status:** Design (2026-04-20) · **Priority:** 3/6 (early — SOC 2 yoluna uygun)
> **Target:** PCI-adjacent güvenlik postürü, SOC 2 Type II hazırlığı, KVKK/GDPR uyumu

---

## 1. Karar gerekçesi

### 1.1 Rovenue'nun tehdit modeli

Rovenue subscription data'sı tutar; kredi kartı PAN'i **tutmaz** (Apple/Google/Stripe'ın tuttuğunu referanslar). Bu bizi PCI DSS'ten muaf bırakır ama "PCI-adjacent" tehditler gerçektir:

- **Webhook spoofing.** Saldırgan Apple/Google/Stripe'a benzer payload üreten bir HTTP çağrısı yaparsa, doğrulamasız uygulama sahte bir subscription aktivasyonu kabul eder. Self-hosted bir revenue management sistemi için tek vektör budur ve doğrulama sızdırırsa gerçek mali kayıp doğurur.
- **Store credential exfiltration.** `projects.appleCredentials` ve benzerleri JWT imzalama anahtarlarını, Google service account JSON'larını ve Stripe secret key'ini içerir. Bu anahtarlar sızınca saldırgan **rovenue üstünden değil, doğrudan store'dan** para/abonelik manipüle edebilir — rovenue yetkisiz sahtecilikte tek dayanak noktası haline gelir.
- **Tenant isolation kayması.** Multi-tenant SaaS (hosted rovenue) senaryosunda bir tenant'ın verisini başka tenant görürse, bu GDPR Art. 32 ihlali + güven kaybı. Self-host'ta bile rovenue'yu ajanslar/agency'ler müşterilerine hizmet etmek için kullanıyor olabilir.
- **Admin action tamperability.** Bir çalışan müşteri kaydını sildi mi, kredi/entitlement hediye etti mi? Audit log cevap vermezse SOC 2 CC7 kontrolleri geçilmez.
- **Session takeover + cross-origin.** Dashboard cookie-based auth kullanıyor; CSRF / SameSite yanlış ayarlanırsa tek bir oltalama linki hesap ele geçirir.

Rovenue'nun güvenlik hedefi bu beş vektörü **sistematik** (tek tek middleware değil, tek bir tehdit modeline göre) kapatmak.

### 1.2 Mevcut durum

Rovenue'da şu an neler var (repo'dan okunabiliyor):

- `apps/api/src/services/apple/apple-webhook.ts` — JWS verification (Apple App Store Server Notifications V2). Bir süre önce "unified webhook signature verification middleware" commit'i geldi (`9b1f2f2`). İyi start.
- `apps/api/src/lib/crypto.ts` muhtemel olarak — AES-256-GCM utility (commit `6b23c31` "feat(crypto): AES-256-GCM utility + key rotation"). Store credentials için alan-düzeyi şifreleme mevcut.
- `apps/api/src/middleware/rate-limit.ts` — Rate limiter var.
- `apps/api/src/middleware/idempotency` — Idempotency middleware retry-critical endpoint'ler için (commit `cc2db8b`).
- `apps/api/src/lib/audit.ts` — Audit log var, `AuditLog` tablosu mevcut.

**Eksikler ve zayıflıklar:**

- Apple JWS verification'ın x5c zincirini **root certificate pinning** ile bitiriyor mu emin değil — test edilmeli.
- Google Play RTDN Pub/Sub message authentication mevcut mu? Manuel kontrol gerekiyor (JWT Bearer ile Pub/Sub push subscription doğrulaması).
- Webhook replay protection **timestamp tolerance + nonce cache** kombinasyonu yerine yalnızca signature kontrolü yapıyor olabilir — Stripe tarzı `t=... v1=...` header parsing eksik.
- Audit log **append-only trigger + hash chain** yok. Rovenue'nun CreditLedger'da disiplini var ama aynı pattern audit log'a uygulanmamış; bir operator DB-level update yaparsa audit log sessizce değişir.
- Secrets management: Coolify environment variable'larının limitleri var — dosya boyutu, escape sorunları. Infisical/Vault self-host alternatifi değerlendirilmeli.
- Tenant-based rate limiting yerine IP-based global rate limit var (`globalIpRateLimit`). Bir müşterinin API key'i diğerinin quota'sını yiyebilir.
- KVKK/GDPR için data residency işaretleme yok; bir müşterinin kaydını silerken append-only CreditLedger ve AuditLog'daki kayıtlar silinmez (right-to-be-forgotten çakışıyor).

### 1.3 Bu alanın kararları

Beş ayrı ama birbiriyle ilişkili eksen:

1. **Kaynak kimliği doğrulama:** Apple, Google, Stripe webhook'ları için tek bir `VerifiedWebhook` middleware'i — her store'un imzasına özgü validator'lar, ortak contract.
2. **Replay protection:** Tüm webhook kaynakları için timestamp + nonce (Redis TTL) + HMAC kombinasyonu. Idempotency middleware'den ayrı bir katman.
3. **Field-level encryption:** Mevcut AES-256-GCM'i envelope encryption pattern'ine taşı (data key + master key ayrımı), key rotation için explicit versioning.
4. **Audit log hardening:** Append-only + Merkle-style hash chain + periodic anchor. Silinmez, oynanamaz.
5. **Rate limiting re-architecture:** Global IP-based → per-tenant + per-endpoint, Redis sliding window, surge protection.

Ek olarak GDPR/KVKK için **data residency tagging** + **right-to-be-forgotten** flow'u (hard delete edilemeyen tablolar için anonimleştirme).

### 1.4 AGPLv3 uyumu

Kullanılacak kütüphaneler:
- `jose` (MIT) — JWT/JWS/x509 operasyonları.
- `nanoid` (MIT) — nonce.
- `@noble/hashes` (MIT) — Merkle chain için SHA-256.
- `rate-limiter-flexible` (ISC) — Redis sliding window.
- `ioredis` (MIT) — mevcut.

Vault/Infisical self-host AGPLv3 ile uyumlu (Vault MPL 2.0, Infisical MIT). Ticari SaaS'leri (AWS Secrets Manager, GCP Secret Manager) opsiyonel alternatif olarak dokümantasyonda geç.

---

## 2. Mimari diyagram

```mermaid
graph TB
    subgraph "Inbound webhooks"
        A1[Apple ASSN V2] --> B1[verifyApple middleware]
        A2[Google Pub/Sub RTDN] --> B2[verifyGoogle middleware]
        A3[Stripe] --> B3[verifyStripe middleware]
        B1 --> C[replay guard\n(Redis nonce cache)]
        B2 --> C
        B3 --> C
        C --> D[Idempotency middleware]
        D --> E[Handler]
    end

    subgraph "Credential storage"
        F[Plain credential]
        F --> G[Data Key encrypt\nAES-256-GCM]
        G --> H[Master Key encrypt DEK\nenvelope]
        H --> I[(projects.*Credentials jsonb)]
        J[KMS / Infisical] -.provides.-> H
    end

    subgraph "Audit chain"
        K[Handler write] --> L[audit() helper]
        L --> M[Previous hash read]
        M --> N[Row + hash commit]
        N --> O[(audit_log)]
        O --> P[Nightly anchor job]
        P --> Q[Published Merkle root]
    end

    subgraph "Rate limiting"
        R[Request] --> S[Tenant resolver]
        S --> T[Sliding window check]
        T --> U[Redis bucket]
        T --> V[Handler or 429]
    end
```

---

## 3. Apple App Store Server Notifications V2 — JWS verification

### 3.1 Protokol özeti

Apple her subscription state değişikliğinde V2 bildiriminde bir JWT (`signedPayload`) gönderir. Bu JWT'nin header'ı `x5c` field'ında bir X.509 certificate chain içerir (leaf + intermediate + root). Doğrulama üç adım:

1. `x5c` zincirini parse et; leaf → intermediate → root.
2. Root'un Apple'ın yayınladığı "Apple Root CA - G3" sertifikasıyla **tam eşleşip eşleşmediğini** kontrol et (pinning, sadece CA listesine güvenmek yetmez).
3. Leaf'in public key'iyle JWT imzasını doğrula. İçerideki `signedTransactionInfo` ve `signedRenewalInfo` da ayrı JWT'lerdir — aynı chain ile doğrulanır.

### 3.2 Kod

```typescript
// apps/api/src/middleware/webhooks/verify-apple.ts
import { importX509, jwtVerify, decodeProtectedHeader } from "jose";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

// Apple Root CA - G3 certificate (PEM). Pinned in the repo; rotated
// manually when Apple announces a new root (roughly every decade).
// Fingerprint check below catches drift if the file is tampered.
const APPLE_ROOT_CA_PEM = readFileSync(
  new URL("./apple-root-ca-g3.pem", import.meta.url),
  "utf8",
);

// Expected SHA-256 fingerprint of the root. Hard-coded so even a
// repo poisoner cannot swap the PEM file silently.
const APPLE_ROOT_SHA256 =
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c7a8d1ba7e3e5f4eae1f9b2c7dc"; // example placeholder

function verifyRootFingerprint(rootCert: X509Certificate): void {
  const fp = createHash("sha256").update(rootCert.raw).digest("hex");
  if (fp !== APPLE_ROOT_SHA256) {
    throw new HTTPException(500, {
      message: "Apple root CA fingerprint mismatch — deployment tampered",
    });
  }
}

// Verify an Apple V2 signed payload. Returns the decoded JWT claims
// on success; throws HTTPException on any failure (caller already
// short-circuits on failure, so no success/failure branching here).
export async function verifyApplePayload(signedPayload: string): Promise<{
  notificationType: string;
  notificationUUID: string;
  data: {
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    bundleId: string;
    environment: "Sandbox" | "Production";
  };
}> {
  const header = decodeProtectedHeader(signedPayload);
  const x5c = header.x5c as string[] | undefined;

  if (!x5c || x5c.length < 2) {
    throw new HTTPException(400, {
      message: "Apple payload missing x5c certificate chain",
    });
  }

  // Parse the chain. Apple sends [leaf, intermediate, root] in DER
  // base64 encoding (no PEM wrapper).
  const chain = x5c.map(
    (b64) => new X509Certificate(Buffer.from(b64, "base64")),
  );
  const [leaf, intermediate, root] = chain;

  // Pin the root — not just validate the chain. Chain-of-trust
  // failures are useful but insufficient; a misissued cert signed
  // by a compromised intermediate would pass chain validation.
  verifyRootFingerprint(root);

  // Verify each link in the chain: leaf issued by intermediate,
  // intermediate issued by root.
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) {
    throw new HTTPException(400, {
      message: "Leaf certificate not issued by intermediate",
    });
  }
  if (
    !intermediate.checkIssued(root) ||
    !intermediate.verify(root.publicKey)
  ) {
    throw new HTTPException(400, {
      message: "Intermediate certificate not issued by pinned root",
    });
  }

  // Check expiry windows for the entire chain.
  const now = Date.now();
  for (const cert of chain) {
    if (now < cert.validFromDate.getTime() || now > cert.validToDate.getTime()) {
      throw new HTTPException(400, {
        message: "Certificate in chain is expired or not yet valid",
      });
    }
  }

  // Finally verify the JWT signature using the leaf's public key.
  const leafPem = leaf.toString(); // PEM
  const key = await importX509(leafPem, "ES256");
  const { payload } = await jwtVerify(signedPayload, key, {
    algorithms: ["ES256"],
  });

  return payload as never;
}
```

### 3.3 Middleware entegrasyonu

```typescript
// apps/api/src/routes/webhooks/apple.ts
import { Hono } from "hono";
import { verifyApplePayload } from "../../middleware/webhooks/verify-apple";
import { replayGuard } from "../../middleware/webhooks/replay-guard";

export const appleWebhookRoute = new Hono()
  .post("/", replayGuard({ source: "apple" }), async (c) => {
    const raw = await c.req.json<{ signedPayload: string }>();
    const payload = await verifyApplePayload(raw.signedPayload);

    // Now safe to process. The handler does not re-verify.
    await processAppleNotification(payload);
    return c.json({ data: { received: true } });
  });
```

### 3.4 `signedTransactionInfo` nested JWT

Apple payload'ının içinde de JWT var — aynı chain'le doğrulanır:

```typescript
async function unpackTransactionInfo(signedTxInfo: string, leaf: X509Certificate) {
  const key = await importX509(leaf.toString(), "ES256");
  const { payload } = await jwtVerify(signedTxInfo, key, {
    algorithms: ["ES256"],
  });
  return payload;
}
```

Leaf cert'i parent verification'da bir kez çıkardıktan sonra nested payload'lar için yeniden fetch etmeye gerek yok.

---

## 4. Google Play Real-time Developer Notifications

### 4.1 Protokol özeti

Google Play RTDN'ler Pub/Sub push subscription üstünden gelir:

1. Pub/Sub message'ı HTTP POST olarak `/webhooks/google` endpoint'imize gönderir.
2. Request header'ında `Authorization: Bearer <JWT>` — bu JWT Google tarafından imzalanmış, audience'ı bizim webhook URL'imiz.
3. Message body'sinde base64-encoded `purchaseToken` ve `subscriptionNotification` var.

Doğrulama üç katman:

1. **JWT signature & claims.** `aud` = webhook URL'imiz, `iss` = `accounts.google.com` / `https://accounts.google.com`, `exp` gelecekte.
2. **Service account identity.** Token'ın `email` claim'i Pub/Sub subscription'ımızın ayarlarındaki service account mail'iyle eşleşmeli (yani sadece bizim seçtiğimiz service account push yapabilir).
3. **Purchase token cross-check.** Body'deki `purchaseToken`'ı Google Play Developer API (`purchasesv2.subscriptionsv2:get`) ile doğrula — payload'ı sadece güvenmeyip gerçek subscription state'ini Google'dan oku.

### 4.2 Kod

```typescript
// apps/api/src/middleware/webhooks/verify-google.ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { env } from "../../lib/env";

// Google's OAuth2 public keys. jose caches the JWKS with a short
// TTL so repeated verifications don't hammer Google.
const googleJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export function verifyGoogle(): MiddlewareHandler {
  return async (c, next) => {
    const authz = c.req.header("Authorization");
    if (!authz?.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing Pub/Sub Bearer token" });
    }
    const token = authz.slice(7);

    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, googleJwks, {
        issuer: ["accounts.google.com", "https://accounts.google.com"],
        audience: env.GOOGLE_WEBHOOK_AUDIENCE, // e.g. https://api.rovenue.com/webhooks/google
      });
      payload = result.payload;
    } catch (err) {
      throw new HTTPException(401, {
        message: "Invalid Pub/Sub Bearer token",
      });
    }

    // Ensure the push subscription is using the service account we
    // configured in the Pub/Sub topic, not someone who managed to
    // mint a Google token for our audience.
    if (payload.email !== env.GOOGLE_PUBSUB_SERVICE_ACCOUNT) {
      throw new HTTPException(401, {
        message: "Pub/Sub token from unexpected service account",
      });
    }

    // Optional but recommended: check email_verified claim.
    if (payload.email_verified !== true) {
      throw new HTTPException(401, {
        message: "Pub/Sub service account email not verified",
      });
    }

    await next();
  };
}
```

### 4.3 Handler + subscriptionsv2 cross-check

```typescript
export const googleWebhookRoute = new Hono().post(
  "/",
  verifyGoogle(),
  replayGuard({ source: "google" }),
  async (c) => {
    const body = await c.req.json<GooglePubSubMessage>();
    const data = JSON.parse(
      Buffer.from(body.message.data, "base64").toString("utf8"),
    ) as GoogleRtdnPayload;

    // Never trust payload fields as authoritative. Fetch current
    // state from Play Developer API using the projectId + purchase
    // token. The payload is just a hint that state has changed.
    if (data.subscriptionNotification) {
      const subState = await playApi.getSubscriptionState({
        packageName: data.packageName,
        subscriptionId: data.subscriptionNotification.subscriptionId,
        token: data.subscriptionNotification.purchaseToken,
      });
      await processGoogleSubscription(subState);
    }

    return c.json({ data: { received: true } });
  },
);
```

---

## 5. Stripe webhook doğrulama

Stripe `Stripe-Signature` header'ı `t=...,v1=...,v1=...` formatında timestamp + HMAC imzaları içerir. Rovenue'nun mevcut implementation'ı `apps/api/src/services/stripe/stripe-webhook.ts` içinde — commit geçmişi kontrol edilirse muhtemelen Stripe SDK'sı (`stripe.webhooks.constructEvent`) veya elle implementation kullanılıyor.

**Minimum şart:**

- `tolerance` 5 dakika (Stripe default'u 5 dakika, bunu düşürmek DST/clock drift riski).
- Constant-time HMAC comparison.
- `Stripe-Signature` parse'ı esnek (birden fazla `v1=...` olabilir; anahtar rotasyonu sırasında ikisi aynı anda geçerli olur).

Bir middleware'a sarılmışsa aşağıdaki genel replay-guard şemasıyla uyumlu kalsın.

---

## 6. Genel replay protection middleware

Apple/Google/Stripe sonrası ortak katman: nonce idempotency + timestamp window.

```typescript
// apps/api/src/middleware/webhooks/replay-guard.ts
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { redis } from "../../lib/redis";

type ReplayOpts = {
  source: "apple" | "google" | "stripe";
  // Maximum accepted age of the notification. Stores that send
  // on-time notifications can afford a tight window; 5 minutes is
  // common in webhook ecosystems and matches Stripe's default.
  toleranceSeconds?: number;
};

export function replayGuard(opts: ReplayOpts): MiddlewareHandler {
  const tolerance = opts.toleranceSeconds ?? 300;

  return async (c, next) => {
    // Each source exposes a unique event id:
    //   Apple:  notificationUUID (body)
    //   Google: message.messageId (body)
    //   Stripe: event.id (body)
    // These fields are parsed in the respective verify middlewares
    // and stashed on the context before reaching here.
    const eventId = c.get("webhookEventId");
    const eventTs = c.get("webhookEventTimestamp"); // unix seconds

    if (!eventId || !eventTs) {
      throw new HTTPException(500, {
        message: "replayGuard: webhookEventId/Timestamp not set by verifier",
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - eventTs);
    if (skew > tolerance) {
      throw new HTTPException(400, {
        message: `Webhook timestamp outside tolerance (${skew}s > ${tolerance}s)`,
      });
    }

    // Atomic SETNX with TTL = 2 * tolerance. If this exact event id
    // was seen before (within window), reject. After TTL expires,
    // the entry is garbage-collected — safe because the timestamp
    // check already bounds the window.
    const key = `webhook:seen:${opts.source}:${eventId}`;
    const added = await redis.set(key, "1", "EX", tolerance * 2, "NX");
    if (added !== "OK") {
      throw new HTTPException(200, {
        // Returning 200 with a no-op body is the defensive choice:
        // the store keeps retrying if we 4xx, but we've already
        // processed this event. Prefer idempotent 200.
        message: "Duplicate webhook — already processed",
      });
    }

    await next();
  };
}
```

Not: `webhookEventId` ve `webhookEventTimestamp`'ı her source'a ait verifier middleware'i `c.set(...)` ile koyar. Bu disiplin rovenue'nun mevcut "unified webhook signature verification" commit'inin pattern'ine eklenir.

---

## 7. Field-level encryption + envelope pattern

### 7.1 Mevcut zayıflık

Rovenue'da AES-256-GCM utility var (`apps/api/src/lib/crypto.ts`). Tipik implementation: `ENCRYPTION_KEY` env var'ı 32-byte hex; tüm credentials bu tek anahtarla şifrelenir. Problem:

- **Key rotation pahalı.** Anahtar değişirse tüm şifreli row'ları yeniden şifrelemek gerek. Rovenue'da bunun için migration pattern'i yok.
- **Tek compromise = hepsi açık.** Anahtar sızarsa tüm credentials okunur.
- **Audit trace yok.** Hangi anahtar versiyonuyla şifrelendiği kayıt dışı.

### 7.2 Envelope encryption

Pattern:

1. **Master Key (MK):** Bir defaya mahsus üretilir (32-byte random), Infisical/Vault/Coolify env'de saklanır.
2. **Data Encryption Key (DEK):** Her credential için random 32-byte üretilir.
3. **Encrypted credential = AES-GCM(DEK, plaintext)**.
4. **Encrypted DEK = AES-GCM(MK, DEK)**.
5. Veritabanında saklanan: `{ version: 2, iv, ct, tag, encDek }`.

Avantajlar:
- Master key rotation için yalnızca tüm `encDek`'leri yeniden sarmak yeter (credential data'sını yeniden şifrelemeye gerek yok).
- Farklı DEK'ler sayesinde bir DEK sızarsa yalnızca tek kayıt açılır.
- Version field'ı sayesinde eski şifrelemelerle yenileri bir arada yaşayabilir.

### 7.3 Kod

```typescript
// apps/api/src/lib/crypto/envelope.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";

export type Envelope = {
  v: 2;
  iv: string; // base64
  ct: string; // base64 (ciphertext of plaintext)
  tag: string; // base64 (auth tag over ct)
  dek: {
    iv: string;
    ct: string; // base64 (ciphertext of DEK under master key)
    tag: string;
    mkv: number; // master key version, enables rotation
  };
};

type KeyProvider = {
  current: () => { key: Buffer; version: number };
  byVersion: (v: number) => Buffer;
};

export function encryptEnvelope(
  plaintext: string,
  keys: KeyProvider,
): Envelope {
  const dek = randomBytes(32);
  const { key: mk, version: mkv } = keys.current();

  // Encrypt plaintext with DEK
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, dek, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();

  // Encrypt DEK with Master Key
  const dekIv = randomBytes(12);
  const dc = createCipheriv(ALG, mk, dekIv);
  const dekCt = Buffer.concat([dc.update(dek), dc.final()]);
  const dekTag = dc.getAuthTag();

  return {
    v: 2,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
    dek: {
      iv: dekIv.toString("base64"),
      ct: dekCt.toString("base64"),
      tag: dekTag.toString("base64"),
      mkv,
    },
  };
}

export function decryptEnvelope(env: Envelope, keys: KeyProvider): string {
  const mk = keys.byVersion(env.dek.mkv);

  // Decrypt DEK
  const dc = createDecipheriv(ALG, mk, Buffer.from(env.dek.iv, "base64"));
  dc.setAuthTag(Buffer.from(env.dek.tag, "base64"));
  const dek = Buffer.concat([
    dc.update(Buffer.from(env.dek.ct, "base64")),
    dc.final(),
  ]);

  // Decrypt plaintext
  const c = createDecipheriv(ALG, dek, Buffer.from(env.iv, "base64"));
  c.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([c.update(Buffer.from(env.ct, "base64")), c.final()]);
  return pt.toString("utf8");
}
```

### 7.4 Key rotation

```typescript
// apps/api/src/scripts/rotate-master-key.ts
// Re-wrap every envelope's DEK under the new master key. The DEK
// and ciphertext themselves are not re-encrypted, so this is cheap
// even with millions of rows.
async function rotateMasterKey(newVersion: number) {
  const credentials = await db
    .select()
    .from(projects)
    .where(isNotNull(projects.appleCredentials));

  for (const row of credentials) {
    const env = row.appleCredentials as Envelope;
    if (env.dek.mkv === newVersion) continue; // already rotated

    const plain = decryptEnvelope(env, keyProvider);
    const rewrapped = encryptEnvelope(plain, {
      ...keyProvider,
      current: () => ({ key: keyProvider.byVersion(newVersion), version: newVersion }),
    });
    await db
      .update(projects)
      .set({ appleCredentials: rewrapped })
      .where(eq(projects.id, row.id));
  }
}
```

Çok sayıda kayıt varsa batch'le + rate limit'le; bu script production'da bir kez manuel veya CI job olarak çalışır.

### 7.5 Backward compat

Rovenue mevcut `v: 1` (single-key) envelope'larını decrypt edebilmeli. Decrypt fonksiyonu `v` field'ına göre dallanır:

```typescript
export function decryptAny(env: LegacyEnvelope | Envelope, keys: KeyProvider): string {
  if (env.v === 1) return decryptLegacy(env, keys);
  if (env.v === 2) return decryptEnvelope(env, keys);
  throw new Error(`Unknown envelope version: ${env.v}`);
}
```

Yeni kayıtlar v2 yazar; eski v1'ler okunmaya devam eder; opsiyonel migration script'i v1'leri v2'ye çevirir.

---

## 8. Audit log — tamper-evident chain

### 8.1 Problem

Mevcut `audit_log` tablosu `action`, `resource`, `before`, `after`, `createdAt` gibi alanları tutar. Eğer bir operator postgresql üstünden `UPDATE audit_log SET after = ...` yaparsa fark edilmez. SOC 2 CC7 "System Monitoring" kontrolü için audit log **integrity guarantee** ister.

### 8.2 Çözüm: hash chain + periodic anchor

Her audit row'u bir önceki row'un hash'ini içerir. Zincir doğruluğu kontrol edilince tek bir row değiştirildiğinde chain kırılır. Periodic olarak (nightly) son row'un hash'i harici bir sisteme (Slack, GitHub Gist, opsiyonel bir public transparency log) yayınlanır — böylece DB-level hileyle **tüm zincir yeniden yazılsa bile** dışarıda bırakılan "anchor" uyumsuz olur.

### 8.3 Schema değişikliği

```typescript
// packages/db/src/schema/audit-log.ts (Drizzle)
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId"),
    userId: text("userId"),
    action: text("action").notNull(),
    resource: text("resource").notNull(),
    resourceId: text("resourceId"),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    // New columns for the chain:
    prevHash: text("prevHash").notNull(),
    rowHash: text("rowHash").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    prevHashIdx: uniqueIndex("audit_log_prev_hash_idx").on(t.prevHash),
    byProject: index("audit_log_project_created_idx").on(t.projectId, t.createdAt),
  }),
);
```

### 8.4 Writer

```typescript
// apps/api/src/lib/audit.ts
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const GENESIS_HASH = "0".repeat(64); // hash of row N-1 for the first row

export async function audit(
  input: AuditInput,
  tx: Tx = db, // drizzle transaction or db
): Promise<void> {
  const id = createId();
  const createdAt = new Date();

  // Serialize the full row (minus rowHash itself) into a canonical
  // JSON string. The ordering and formatting must be deterministic
  // so the same logical row always hashes the same way. JSON.stringify
  // with sorted keys works for our flat shape; switch to a canonical
  // JSON library if we ever nest rich objects.
  const canonical = canonicalJson({
    id,
    projectId: input.projectId ?? null,
    userId: input.userId ?? null,
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: input.metadata ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: createdAt.toISOString(),
  });

  // Lock the latest row so concurrent writers chain in a total order.
  // The locked row's hash becomes our prevHash. Postgres SERIALIZABLE
  // isolation alone isn't enough because two transactions could pick
  // the same "latest" and produce rows with identical prevHash — then
  // both would fail the unique index on rowHash, which is worse.
  const [last] = await tx
    .select({ rowHash: auditLog.rowHash })
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(1)
    .for("update");

  const prevHash = last?.rowHash ?? GENESIS_HASH;
  const rowHash = bytesToHex(sha256(`${prevHash}|${canonical}`));

  await tx.insert(auditLog).values({
    id,
    projectId: input.projectId ?? null,
    userId: input.userId ?? null,
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId ?? null,
    before: input.before,
    after: input.after,
    metadata: input.metadata,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    prevHash,
    rowHash,
    createdAt,
  });
}

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(obj as object).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as any)[k])}`)
    .join(",")}}`;
}
```

### 8.5 Postgres-level append-only

Trigger'la yedekli:

```sql
CREATE OR REPLACE FUNCTION audit_log_reject_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
```

Bu trigger `SUPERUSER` tarafından bypass edilebilir (ALTER TABLE ... DISABLE TRIGGER). Operasyonel disipline bağlı — ama süperuser'ı günlük işlemde kullanmamak policy'dir.

### 8.6 Verifier + anchor job

```typescript
// apps/api/src/workers/audit-verifier.ts
// Runs nightly via BullMQ. Walks the entire chain end-to-end,
// recomputes each rowHash from the previous, flags any break.
// Publishes the latest rowHash to an external location so a
// full-chain rewrite cannot go unnoticed.
export async function verifyAndAnchor() {
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(asc(auditLog.createdAt));

  let expected = GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== expected) {
      await alertOps(
        `Audit chain broken at ${row.id}: expected prev=${expected}, got ${row.prevHash}`,
      );
      return;
    }
    const canonical = serializeForHash(row);
    const recomputed = bytesToHex(sha256(`${row.prevHash}|${canonical}`));
    if (recomputed !== row.rowHash) {
      await alertOps(`Audit row ${row.id} hash mismatch — tampered`);
      return;
    }
    expected = row.rowHash;
  }

  // Publish the tip. Slack webhook, GitHub gist commit, or a public
  // transparency log endpoint — pick whichever is operationally
  // simplest and hardest for an insider to suppress.
  await publishAnchor({
    timestamp: new Date().toISOString(),
    lastRowId: rows[rows.length - 1]?.id,
    lastRowHash: expected,
  });
}
```

Milyonlarca row olduğunda tam walk pahalı — bu durumda **checkpoint pattern** uygula: Her 10K row'da bir intermediate anchor yayınla, verification bu checkpoint'ten başlar.

---

## 9. Secrets management

### 9.1 Coolify env var'ın sınırları

Coolify projeye environment variable'ları UI/CLI üzerinden ekleriyor. Sınırlar:

- **Length limit:** Systemd environment files tipik olarak 4KB satır limiti. Google service account JSON'ı (~2.3KB) sığar ama Apple privateKey + multiple projects hızla limiti zorlar.
- **No rotation without redeploy.** Env var değişince container restart gerekir. Zero-downtime rotation yapılamaz.
- **No audit of reads.** Hangi deployment hangi secret'ı ne zaman okudu — Coolify log'lamıyor.
- **No granular access.** Tüm container'lar tüm env var'ları görür; process isolation yok.

### 9.2 Infisical self-host (AGPLv3 uyumlu, MIT)

Infisical bir secret management platform'u. Self-host Docker Compose ile Coolify'a deploy edilebilir. Entegrasyon:

```typescript
// apps/api/src/lib/secrets.ts
import { InfisicalClient } from "@infisical/sdk";

const infisical = new InfisicalClient({
  siteUrl: process.env.INFISICAL_URL!,
  auth: {
    universalAuth: {
      clientId: process.env.INFISICAL_CLIENT_ID!,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET!,
    },
  },
});

// Cached fetch. Secrets in Infisical have their own rotation
// workflow; we refresh from cache every 60s unless an explicit
// rotation event tells us to invalidate.
const cache = new Map<string, { value: string; fetchedAt: number }>();
const TTL = 60_000;

export async function getSecret(key: string): Promise<string> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL) return cached.value;

  const secret = await infisical.getSecret({
    secretName: key,
    projectId: process.env.INFISICAL_PROJECT_ID!,
    environment: process.env.NODE_ENV === "production" ? "prod" : "dev",
  });
  cache.set(key, { value: secret.secretValue, fetchedAt: Date.now() });
  return secret.secretValue;
}
```

### 9.3 Master key için farklı muamele

Master encryption key (MK) Infisical'da tutulur; **DEK'ler asla**. DEK'ler her zaman credential'ın yanında encrypted halde DB'de. Infisical compromise olsa bile atacker MK'yi alır, DB'yi de çalması lazım — iki ayrı breach lazım, security-in-depth.

### 9.4 SDK-RN'e key delivery

SDK-RN public API key kullanır (per-project, `rov_pub_*`). Bu key plain-text client'a dağıtılır (React Native app bundle'ında); runtime'da rotate etmek için SDK `Rovenue.rotateKey(newKey)` API'si sunar. Secret API key (`rov_sec_*`) sadece server-to-server, SDK-RN'de asla.

---

## 10. Rate limiting — tenant-based sliding window

### 10.1 Mevcut + hedef

Rovenue'da `globalIpRateLimit` var — tek global bucket IP başına. Sorun: multi-tenant'ta bir tenant'ın agresif trafiği diğerini etkiler; tek kötü kullanıcı herkesi yavaşlatır.

Hedef:

- **SDK endpoint'leri** (`/v1/*`): per-apiKey rate limit. Her project kendi quota'sını tüketir.
- **Dashboard endpoint'leri** (`/dashboard/*`): per-user rate limit. Bir user'ın sessizce başka tenant'ı etkileyemez.
- **Webhook endpoint'leri** (`/webhooks/*`): per-source (apple/google/stripe) rate limit yüksek tavanla (stores high-volume retries yapabilir).
- **Global surge guard**: tüm katmanlar üstünde, server koruma için emniyet vanası.

### 10.2 `rate-limiter-flexible` entegrasyonu

```typescript
// apps/api/src/middleware/rate-limit-v2.ts
import { RateLimiterRedis } from "rate-limiter-flexible";
import { redis } from "../lib/redis";
import type { MiddlewareHandler } from "hono";

// One limiter per category; each has its own Redis key namespace
// and its own window/points configuration.
const limiters = {
  sdk: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl:sdk",
    points: 1000, // requests
    duration: 60, // seconds (sliding window)
  }),
  dashboard: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl:dashboard",
    points: 300,
    duration: 60,
  }),
  webhook: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl:webhook",
    points: 10_000,
    duration: 60,
  }),
} as const;

export function rateLimit(
  category: keyof typeof limiters,
  keyFn: (c: any) => string,
): MiddlewareHandler {
  return async (c, next) => {
    const key = keyFn(c);
    try {
      const result = await limiters[category].consume(key, 1);
      c.header("X-RateLimit-Limit", String(result.remainingPoints + 1));
      c.header("X-RateLimit-Remaining", String(result.remainingPoints));
      c.header(
        "X-RateLimit-Reset",
        String(Math.ceil((Date.now() + result.msBeforeNext) / 1000)),
      );
      await next();
    } catch (err) {
      // Rate limited. `err` from rate-limiter-flexible has
      // msBeforeNext. Translate into a proper 429.
      c.header("Retry-After", String(Math.ceil(err.msBeforeNext / 1000)));
      c.header("X-RateLimit-Remaining", "0");
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests" } },
        429,
      );
    }
  };
}

// Usage:
v1Route.use(
  "*",
  rateLimit("sdk", (c) => c.get("apiKey")?.id ?? "anonymous"),
);
dashboardRoute.use(
  "*",
  rateLimit("dashboard", (c) => c.get("user")?.id ?? "anonymous"),
);
```

### 10.3 Surge protection (global emergency brake)

Per-category bucket'lar yetersiz olduğunda (100K SDK key aynı anda agresif olursa), process-wide bir guard:

```typescript
// apps/api/src/middleware/surge-guard.ts
const surgeLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: "rl:surge",
  points: 50_000, // total requests/min across all tenants
  duration: 60,
});

export const surgeGuard: MiddlewareHandler = async (c, next) => {
  try {
    await surgeLimiter.consume("global", 1);
    await next();
  } catch {
    return c.json(
      { error: { code: "server_overloaded", message: "Please try again shortly" } },
      503,
    );
  }
};
```

### 10.4 Quota farkları per tier

Hosted rovenue'da tier'lara göre farklı point value'ları gerekir. `keyFn` + per-tenant config combo:

```typescript
rateLimit("sdk", (c) => {
  const key = c.get("apiKey");
  return `${key.id}:${key.tier}`; // tier'a göre farklı bucket
});
```

Hatta tier başına ayrı limiter tanımla: `limiters.sdkFree`, `limiters.sdkGrowth`, `limiters.sdkEnterprise`.

---

## 11. CSRF / SameSite

### 11.1 Better Auth default'ları

Better Auth cookie'leri `SameSite=Lax` + `Secure` + `HttpOnly` default'ta ayarlıyor. Dashboard CORS'ta `credentials: "include"` kullanıyor.

**Riskler ve doğrulama:**

- **`SameSite=Lax`**: cross-site GET'leri cookie'yle yapabilir, POST/PATCH/DELETE için cookie gönderilmez. Dashboard login callback URL'i (`/api/auth/callback/google`) **GET** olduğu için OAuth flow'u çalışır. State-changing endpoint'lerde cookie-based auth sadece same-origin istek ile çalışır — CSRF doğal olarak kapalı.
- **`SameSite=None`'a düşürmek istersek** (örn. dashboard ayrı subdomain + top-level domain arası), Better Auth config'inde explicit `cookieOptions.sameSite: "none"`. Bu durumda CSRF token gerekli — Better Auth v1.1+ `csrfToken` middleware sunar.
- **Preflight origin check**: rovenue `cors()` middleware'i `env.DASHBOARD_URL`'i allowlist'te tutuyor. Production deploy'unda localhost'ı bırakmamak için koruma var (gördük), iyi.

### 11.2 Double-submit token pattern (cookie-less endpoint'ler için)

SDK ve webhook endpoint'leri cookie kullanmıyor — rate limit, API key auth, signature verification zaten yeterli. Dashboard için mevcut Better Auth setup yeterli.

### 11.3 Test — CSRF saldırı simülasyonu

```typescript
test("cross-origin POST without CSRF token is rejected", async () => {
  const res = await app.request("/dashboard/projects", {
    method: "POST",
    headers: {
      origin: "https://evil.com",
      cookie: validSessionCookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "x", slug: "x" }),
  });
  expect(res.status).toBe(403);
});
```

---

## 12. Data residency, KVKK / GDPR

### 12.1 Subscriber PII

Rovenue'da `subscribers.attributes` JSONB alanı serbest-form kullanıcı attribute'ları tutuyor (email, name, vb.). KVKK + GDPR:

- **Minimization.** SDK attribute field'larını opsiyonel, rovenue varsayılanda saklamamalı. Müşteri explicit opt-in ile PII'yi gönderir.
- **Residency tagging.** Her subscriber'a `region` field'ı ekle (`"eu"`, `"us"`, `"tr"`, vb.). Self-host'ta tek-region deploy eder, hosted rovenue'da region-specific cluster'lar destekler.
- **Right to access.** Bir user'a ait tüm data'yı export eden endpoint (`GET /dashboard/subscribers/:id/export`) — JSON dump + referans'lar.
- **Right to be forgotten.** Hard delete mümkün olmayan tablolarda (credit_ledger, audit_log, revenue_events append-only) **anonimleştirme**: `subscriberId`'yi stable bir hash'e çevir, `attributes`'ı boşalt, email'i de hash'le. PII gider ama integrity korunur.

### 12.2 Anonymize kod

```typescript
// apps/api/src/services/gdpr/anonymize.ts
export async function anonymizeSubscriber(subscriberId: string): Promise<void> {
  const anonymousId = `anon_${bytesToHex(sha256(subscriberId)).slice(0, 24)}`;

  await db.transaction(async (tx) => {
    // 1. Replace PII in the subscribers row but keep the row so
    //    foreign keys in purchases/access/ledger don't break.
    await tx
      .update(subscribers)
      .set({
        attributes: {},
        appUserId: anonymousId, // was the customer-controlled identifier
        deletedAt: new Date(),
      })
      .where(eq(subscribers.id, subscriberId));

    // 2. Audit log entry — deleted_at is not the erasure, audit is.
    await audit(
      {
        action: "subscriber.anonymized",
        resource: "subscriber",
        resourceId: subscriberId,
        metadata: { anonymousId, reason: "gdpr_request" },
      },
      tx,
    );
  });
}
```

Purchase / credit_ledger / audit_log rows are left intact — subscriberId hâlâ FK ama artık anonim. Bu GDPR Art. 17 için yeterli (data "no longer attributable to the data subject").

### 12.3 KVKK notları (Türkiye-spesifik)

- **VERBIS kaydı.** Rovenue'yu Türkiye'de SaaS olarak sunan şirket için VERBIS'e data processor olarak kayıt zorunlu (kullanıcı kişisel verisini işliyorsunuz).
- **Açık rıza.** SDK'ya geçirilen attribute'lar (email, telefon) için uygulama tarafından açık rıza alınmalı; rovenue dashboard'u bunu hatırlatan bir checklist gösterebilir.
- **Cross-border transfer.** Hosted rovenue Hetzner (Frankfurt) üstünde çalışıyorsa Türkiye'den AB'ye veri aktarımı Kişisel Verileri Koruma Kurulu'nun "yeterli ülke" listesine uymalı — AB şu an listede değil, standart sözleşme maddeleri gerekli (SCC benzeri KVKK sözleşmesi).
- **Retention.** Subscription data'sı vergi yasaları (VUK) gereği 5 yıl saklanır; KVKK Art. 7 "silme/imhâ/anonimleştirme" bu süre sonunda tetiklenir. Nightly job retention policy'i uygular.

---

## 13. Deployment + Docker notları

### 13.1 Container güvenliği

```dockerfile
# Run as non-root. The default node image uses UID 1000 for `node`.
USER node

# Drop all capabilities except NET_BIND_SERVICE if binding <1024.
# (Coolify exposes --cap-drop flag in service config.)

# Mount /tmp as tmpfs; never persistent disk writes for runtime.
VOLUME /tmp
```

### 13.2 TLS termination

Coolify önünde Traefik TLS'i termine ediyor. Backend HTTP, **Trust Forwarded Headers** etkin olduğunda `X-Forwarded-Proto: https` güvenilir. Hono `trustProxy` config'i (veya Cloudflare önündeysek `cf-connecting-ip` okuması) explicit.

### 13.3 Postgres TLS

Hetzner Postgres bağlantısını `sslmode=require` ile zorla. Drizzle pool config:

```typescript
new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
});
```

---

## 14. Test stratejisi

### 14.1 Webhook verification fuzzing

Kritik. Her verifier için negatif test suite:

```typescript
// apps/api/tests/security/apple-webhook-fuzz.test.ts
describe("Apple JWS verifier rejects malformed inputs", () => {
  test.each([
    { name: "missing x5c", payload: jwtWithoutX5c() },
    { name: "invalid root", payload: jwtWithWrongRoot() },
    { name: "expired leaf", payload: jwtWithExpiredCert() },
    { name: "swapped intermediate", payload: jwtWithSwappedIntermediate() },
    { name: "wrong algorithm", payload: jwtHS256InsteadOfES256() },
    { name: "chain length 1", payload: jwtSelfSigned() },
    { name: "bit-flipped signature", payload: jwtWithCorruptedSignature() },
  ])("$name", async ({ payload }) => {
    await expect(verifyApplePayload(payload)).rejects.toThrow();
  });
});
```

Her senaryoda test helper'ı bir certificate chain üretir (`node-forge` veya `@peculiar/x509` ile) — gerçek Apple cert'i sadece pozitif test için.

### 14.2 Audit chain tamper test

```typescript
test("tampered audit row is detected", async () => {
  await audit({ action: "test.a", resource: "x" });
  const [row] = await db.select().from(auditLog).limit(1);

  // Simulate an insider bypassing triggers (for test purposes only).
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`);
  await db
    .update(auditLog)
    .set({ after: { forged: true } })
    .where(eq(auditLog.id, row.id));
  await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`);

  await expect(verifyAuditChain()).rejects.toThrow(/hash mismatch/);
});
```

### 14.3 Rate limit test

```typescript
test("tenant A cannot exhaust tenant B quota", async () => {
  const tenantA = "key_a";
  const tenantB = "key_b";

  // Burn tenant A's quota
  for (let i = 0; i < 1000; i++) {
    await app.request("/v1/subscribers", { headers: { Authorization: `Bearer ${tenantA}` } });
  }

  // Tenant A now rate-limited
  const resA = await app.request("/v1/subscribers", { headers: { Authorization: `Bearer ${tenantA}` } });
  expect(resA.status).toBe(429);

  // Tenant B is unaffected
  const resB = await app.request("/v1/subscribers", { headers: { Authorization: `Bearer ${tenantB}` } });
  expect(resB.status).toBe(200);
});
```

### 14.4 Crypto round-trip

```typescript
test("envelope encryption round-trips", () => {
  const plain = "sensitive string";
  const env = encryptEnvelope(plain, keys);
  expect(decryptEnvelope(env, keys)).toBe(plain);
});

test("rotation preserves plaintext", () => {
  const env = encryptEnvelope("x", keys);
  const rotated = rewrapEnvelope(env, keys, 2); // MK v1 -> v2
  expect(decryptEnvelope(rotated, keys)).toBe("x");
});
```

---

## 15. Potansiyel tuzaklar

### T1 — JWT algoritma confusion

Apple ES256, Google RS256, Stripe HMAC-SHA256. Her verifier `algorithms: ["expected"]` ile beyaz liste yapmalı; `alg: none` veya hatalı alg bypass'ı kolay.

### T2 — Clock skew

Coolify container'ları NTP'den senkronize olsun (Debian-based image'lar `systemd-timesyncd` default açık). Clock drift 5 dakikadan fazlaysa tüm webhook'lar ret olur. Alerting: `audit.clock_skew_ms` metric.

### T3 — Master key loss

MK kaybolursa TÜM credentials unrecoverable. MK'yi iki ayrı yerde tut (Infisical + offline encrypted backup, Shamir secret sharing opsiyonel). Bu olay için runbook yaz.

### T4 — Audit chain hole

Bir insider hem trigger'ı devre dışı bırakıp hem de chain'i yeniden yazarsa fark edilir mi? Evet — dış anchor (§8.6) dün gece publish edilen hash'i biliyor, bugün walk yaptığında anchor'a kadarki zincir eşleşmezse breach alarm. Anchor publish eden kanal saldırgan tarafından kontrol edilmemeli (Slack webhook değil, GitHub gist + 2FA'lı bot veya public transparency log).

### T5 — Rate limiter Redis down

Redis düşerse tüm rate limiter açılır mı, kapanır mı? `rate-limiter-flexible` fail-open default ama rovenue için **fail-closed** tercih edilir (overload senaryosunda sistem korunur). Config:

```typescript
new RateLimiterRedis({
  storeClient: redis,
  insuranceLimiter: new RateLimiterMemory({ points: 100, duration: 60 }),
  // Fallback to in-process limiter per instance. Coarser but non-fatal.
});
```

### T6 — Envelope format versioning unutulmuş

Yeni envelope schema'sı deploy edilmeden decrypt'e `v` check'i eklenmezse `v: undefined` için undefined behavior. `decryptAny`'de default case mutlaka throw.

### T7 — Idempotency key çakışması

Idempotency middleware + replay guard farklı key namespace'leri kullanmalı. Aksi halde bir webhook'un nonce'u business-level idempotency key'iyle çakışır, yanlış cache hit verir.

### T8 — Pub/Sub JWT kritik claims eksikse

Google Pub/Sub token'ının `email_verified` field'ı yoksa `undefined === true` false olur, fail-safe. Ama bazen kurumsal Google Workspace token'larında `email_verified` eksik olabiliyor — test environment'ında explicit kontrol.

### T9 — Sertifika pinning hot-fix

Apple Root CA değişirse (decade'da bir), pinning hard-coded fingerprint sahte vermeye başlar. Monitoring: her gün bir canary notification işle, başarısızsa acil değil ama uyarı.

### T10 — Sensitive data logging

`requestLoggerMiddleware` body'yi loglarsa credentials plain log'a düşebilir. Bizim loglama masking'i zorunlu:

```typescript
const REDACTED_FIELDS = [
  "privateKey", "webhookSecret", "secretKey", "serviceAccount",
  "appleCredentials", "googleCredentials", "stripeCredentials",
];

function redactLogPayload(obj: unknown): unknown {
  // Recursive clone replacing sensitive keys with [REDACTED]
}
```

### T11 — Hash chain DoS

Aggressive audit write concurrency: `FOR UPDATE` lock her audit insert'inde tutulur. Trafik yoğun sistemde bu bottleneck. Çözüm: audit log'u ayrı BullMQ queue'ya at, writer tek process'te serialize etsin. Latency tolerate edilebilir (audit gerçek-zamanlı olmak zorunda değil, "eventually recorded within N seconds" yeter).

---

## 16. Sonraki adım

Implementation plan dosyası: `docs/superpowers/plans/2026-04-21-security-compliance.md` (tamamlandı 2026-04-23, branch `feat/alan-3-security-compliance`).

Tamamlanan iş:

- Apple JWS + fingerprint pinning ✅ (Task 2.1 + 2.2, sticky-error cache + 503 translation)
- Google Pub/Sub auth ✅ (pre-existing, dev-mode body peek eklendi Task 1.3'te)
- Replay guard middleware ✅ (Task 1.2 + 1.3)
- Audit chain + trigger + verifier ✅ (pre-existing, `audit.ts`)
- Rate limiter v2 ✅ (Task 3.1 per-user dashboard limiter + Task 3.2 in-memory insurance fallback + sweep)
- Anonymization flow ✅ (Task 4.1 service + Task 4.2 endpoint, peppered HMAC + audit, cross-project bypass fix)
- GDPR right-to-access ✅ (Task 4.3 export service + endpoint)

Out of scope (ayrı plan/spec):

- Envelope encryption + rotation (§7) — ops KMS kararı gerekli.
- Infisical integration (§9) — ops self-host kararı gerekli.

Gerçekleşen: 11 task + 10 review-driven fixup commits, 36 yeni test (346 → 382 geçen, 1 skipped fixture).

---

*Alan 3 sonu. Sonraki: Alan 4 — TimescaleDB Integration.*
