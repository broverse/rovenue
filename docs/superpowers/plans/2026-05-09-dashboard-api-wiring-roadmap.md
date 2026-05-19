# Dashboard ↔ API Wiring Roadmap

**Tarih:** 2026-05-09
**Hedef:** Dashboard sayfalarındaki tüm mock veriyi gerçek backend'e bağlamak. Eksik domain'lere endpoint açmak.

## Mevcut durum (özet)

- **38 sayfa** var. Sadece project CRUD + subscriber detay gerçek API'ya bağlı (≈%10).
- **Account/* (12 sayfa):** backend tarafı yok. Sadece statik UI.
- **Project/$projectId/\* (18 sayfa):** UI hazır, çoğu mock besleniyor. Bir kısmının backend'i de var, sadece wiring eksik.
- **Orphan endpoint'ler:** experiments, feature-flags, audiences, audit-logs, leaderboards, members, webhooks, credentials, MRR metrics — tamamen hazır, hiçbir sayfa çağırmıyor.

## Faz 1 — Hızlı zaferler (wiring-only)

> Backend hazır, sadece dashboard hook + sayfa bağlantısı.

- [ ] `subscribers/index` → mevcut `useSubscribers` hook'unu kullan, `SUBSCRIBERS` mock'unu sil
- [ ] `experiments` → `/dashboard/experiments` CRUD + lifecycle + results
- [ ] `feature-flags` → `/dashboard/feature-flags` CRUD + toggle
- [ ] `sdk` → `/dashboard/projects/:id/credentials` + `/dashboard/webhooks/*`
- [ ] `subscribers/$id` → `credit-history`, `anonymize`, `export` butonlarını bağla
- [ ] `index` (overview) → `metrics/mrr` chart panel'i bağla, geri kalan KPI'lar Faz 3'e
- [ ] Yeni route'lar/sayfalar: `audit-logs`, `audiences`, `leaderboards`, `members` → mevcut endpoint'lere

## Faz 2 — Account / Identity

> Better Auth `user`/`account`/`session` üzerinden + yeni `personal_access_tokens` tablosu.

- [ ] `GET/PATCH /dashboard/me` (profile, locale, tz, avatar)
- [ ] `GET /dashboard/me/sessions` + `DELETE :id`
- [ ] `GET /dashboard/me/accounts` (connected OAuth) + `DELETE :provider`
- [ ] `personal_access_tokens` şeması + `GET/POST/DELETE /dashboard/me/pats`
- [ ] `POST /dashboard/me/export` (GDPR self-export — mevcut subscriber export servisini şablon al)
- [ ] `GET/PATCH /dashboard/me/preferences` (notifications + appearance — tek tablo, JSON kolonlar)
- [ ] **Skip (self-host):** billing, invoices, usage sayfaları → "self-hosted" placeholder olarak kalsın veya Faz 5'e

## Faz 3 — Analytics rollups (ClickHouse query'leri)

> Tabular ve seri verileri için CH MV'leri kullanan agreget endpoint'ler.

- [ ] `GET /dashboard/projects/:id/overview` → KPI summary, top-products, recent-activity, system-health (overview sayfasını besler)
- [ ] `GET /dashboard/projects/:id/transactions` (cursor + filtre) + volume series + store breakdown
- [ ] `GET /dashboard/projects/:id/subscriptions` + renewal-calendar + billing-issues + composition + cohort-retention
- [ ] `GET /dashboard/projects/:id/credits/rollup` → volume, packages, top-burners, ledger, liability
- [ ] `GET /dashboard/projects/:id/charts/{channels,heatmap,funnel}` + saved-views CRUD + annotations CRUD

## Faz 4 — Yeni domain'ler

> Şema + servis + route — sıfırdan.

- [ ] **Products + Product Groups dashboard CRUD** — şu an sadece SDK read-only `/v1/product-groups`. `/dashboard/projects/:id/products` ve `…/product-groups` CRUD aç. (`products` zaten DB tablosu var)
- [ ] **Cohorts** — yeni `cohorts` tablosu + builder DSL + retention/LTV CH query'leri + sync-destinations webhook'ları
- [ ] **Queries playground** — `saved_queries` tablosu + sandbox'lı CH query çalıştırıcı + schema introspection + AI suggest (opsiyonel)
- [ ] **Live events SSE** — `GET /dashboard/projects/:id/events/stream` (Redis pub/sub veya outbox tail)
- [ ] **Apps catalog/recipes** — statik catalog mu yoksa dinamik mi karar ver

## Faz 5 — Polish

- [ ] Mock-data dosyalarını sil (`components/*/mock-data.ts`)
- [ ] Hono RPC client'a tam migrasyon (şu an `api()` helper string path kullanıyor → `rpc.dashboard.…` tip-güvenli)
- [ ] E2E testler: her sayfa için en az bir happy-path

## Sıralama gerekçesi

1. **Faz 1** en yüksek ROI: hiç kod yazmadan UI'yi canlı veriye bağlıyoruz.
2. **Faz 2** kullanıcı güveni: kendi profilini düzenleyemediği bir dashboard yarım hisseder.
3. **Faz 3** paranın olduğu yer: MRR/transactions/credits — Rovenue'nun esas vaadi.
4. **Faz 4** diferansiyasyon: cohorts + queries + live events rakipleri geçtiğimiz noktalar.
5. **Faz 5** temizlik.

## Kararlar (2026-05-19 itibarıyla)

- ~~Self-hosted'da billing/invoices/usage sayfaları gerçekten gerekli mi?~~ → **Skip.** Self-host'ta gerekmiyor; mevcut statik sayfalar yerinde kalabilir, backend açılmayacak.
- ~~Apps catalog statik mi, marketplace mi olacak?~~ → **Statik.** Dinamik marketplace yok.
- ~~Live events SSE mi, WebSocket mi?~~ → **SSE.** `GET /dashboard/projects/:id/events/stream` Server-Sent Events.
- ~~Queries playground'da AI suggest gerçekten v1'de gerekli mi?~~ → **v1'de değil.** Sonraki sürümlere ertelendi.
