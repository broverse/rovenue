# Funnel Attribution SDK Client — Decomposition Map

**Date:** 2026-06-20
**Status:** Decomposition approved; sub-project specs to follow (A first)
**Type:** Top-level decomposition (NOT a single-project spec). Each sub-project
below gets its own brainstorm → spec → plan → implementation cycle.

## Purpose

Build the **SDK client path** for the onboarding-funnel install-attribution
system. The backend is already production-ready (3 claim endpoints, 8 tables,
fingerprint/referrer/magic-link services, 8 outbox event types, dashboard
builder). The SDK client side is **greenfield — zero scaffolding** (unlike the
`track()` work, there are no M7-style wire types to reuse).

Goal: a paying web-funnel user gets their entitlements + funnel answers in the
app after install, recovered **deterministically** (no device fingerprinting).

## Guiding decisions (locked during brainstorming)

1. **Deterministic only — no device fingerprinting.** Apple's fingerprinting
   ban (DPLA §3.3.9 / Guideline 5.1.2) is unconditional, not advertising-scoped,
   and unfixable by consent/disclosure. It is actively enforced (cost Adjust an
   SDK rebuild in 2021) and for an SDK vendor risks symbol-level detection that
   taints **every customer app**. ATT is favorable (same-company first-party is
   not "tracking") but irrelevant to the fingerprinting gate. → The SDK collects
   **no device signals** (no locale/timezone/screen/model) on iOS.
2. **SDK is headless.** Rust core + Swift/Kotlin/RN façades, no UI (consistent
   with the rest of the SDK). The host app builds the email/claim-code UI; the
   SDK owns the claim + the resolution callback.
3. **SDK owns first-launch orchestration (MMP-grade).** Like Adjust/AppsFlyer,
   the SDK runs an automatic, once-per-install, deterministic resolution
   pipeline and fires a callback with the resolved `{ subscriberId, entitlements,
   funnelAnswers }`. The app only registers a listener + supplies fallback UI.
4. **Identity is the guaranteed terminal, not a sad fallback.** Our advantage
   over generic MMPs: the user is a **paying user with a captured email**
   (`funnel_answers` / `email_hash`). MMPs attribute anonymous ad clicks and
   degrade to "generic first launch"; we close the gap deterministically via
   login-match → email magic-link → manual claim code.

## Platform asymmetry (the core constraint)

| | Android | iOS |
|---|---|---|
| OS-level deferred channel | **Yes** — Play Install Referrer carries the token through install (deterministic, Google-sanctioned) | **No** — App Store passes nothing; SKAdNetwork/AdAttributionKit carry no per-user token |
| Cold-install recovery | Install Referrer (reliable workhorse) | Side-channel only: clipboard (best-effort) / App Clip (heavy) → then identity |

This is why Android-deferred (B) and iOS-deferred (C) are **separate
sub-projects with different reliability tiers**, not one "deferred" unit.

### How the MMPs actually do iOS cold install (state of the art, 2024–2025)

- **Branch** — on-device **clipboard (NativeLink)**: web CTA tap copies the URL
  to the clipboard; first launch reads it (`checkPasteboardOnInstall()`). Handles
  the iOS 16+ paste-consent banner via a **tap-to-continue interstitial** or
  Apple's **`UIPasteControl`** (which grants access with no banner). Plus App
  Clips for the deterministic, Apple-sanctioned path.
- **AppsFlyer / Adjust** — **server-side click-to-install matching** (UDL
  `didResolveDeepLink` / Adjust `/session` ODDL). Only as deterministic as the
  underlying shared ID; without IDFA/fingerprint it **degrades to probabilistic
  short-window IP matching**, kept as an opt-in fallback, payload stripped to
  routing-only params.
- **Universal truth:** no guaranteed deterministic iOS cold-install recovery;
  all three document the fallback as "generic first launch / web fallback URL."

We adopt **Branch's clipboard model as primary** and a **constrained server-side
IP match as fallback**, with **identity as the guaranteed terminal** (stronger
than the MMP fallback because we have a paying identity).

## iOS cold-install recovery chain (locked)

Priority order on first launch:

1. **Direct Universal Link** (app already installed / warm) — token in the URL.
2. **Clipboard (NativeLink-style)** — web funnel writes the token to the
   clipboard on a user-gesture CTA; first launch reads it. Handle the iOS 16+
   banner with a tap-to-continue interstitial / `UIPasteControl` — **not** a
   blind `UIPasteboard` read. Best-effort.
3. **Server-side IP match (fallback)** — last **1 hour**, **IP-only**,
   **unique-match-only**: the server matches the claim request's IP against
   click-time `funnel_deferred_claims` rows. Grant **only if exactly one
   unclaimed candidate** from that IP in the window; on multiple candidates
   (shared NAT/CGNAT) → **no grant**, fall through (prevents leaking one user's
   purchase to another). The SDK collects **no device signals** — IP is observed
   server-side from the request. The existing multi-signal `fingerprint.ts` is
   reduced to IP-only for iOS (Android unaffected). Note: iCloud Private Relay
   masks Safari IP, so this fires for a minority of iOS users → most fall to (4).
4. **Identity (guaranteed terminal):** login-match (app auth: user signs in with
   the funnel email → server matches via `email_hash` → auto-claim, zero extra
   friction) → email magic-link (`claimViaEmail`) → manual claim code (floor).

Android cold install: Install Referrer (B) resolves deterministically; identity
is the fallback if a referrer is absent.

## Sub-projects

| # | Sub-project | Scope | Depends on |
|---|---|---|---|
| **A** | **Claim core + install lifecycle** | Rust core: 3 claim methods (`claimFunnelToken`, `claimInstall`, `claimViaEmail`) + `install_id` generate/persist + idempotent **once-per-install** claim state (persisted: pending/claimed/failed) + retry + result caching + `FunnelClaimResolved` observer event (reuses existing `ChangeEvent`/observer machinery) + entitlements/funnel-answers hydration. Swift/Kotlin/RN façades. **No native collection — inputs are parameters.** | — (foundation) |
| **B** | **Android deferred source** | Kotlin native: Play Install Referrer API full lifecycle (connect / one-shot read / parse `rovenue_funnel_token` / errors) → feeds `claimInstall`. | A |
| **C** | **iOS deferred source** | iOS native: clipboard read (NativeLink-style, gesture-gated via tap-to-continue / `UIPasteControl`) + **web-side clipboard write** on the funnel CTA (cross-cutting, public funnel page). Server-side IP-only unique-match fallback (backend tweak: reduce `fingerprint.ts` to IP-only + 1h window + unique-match guard for iOS). App Clip path **documented only** (SDK cannot ship a customer's App Clip). **No fingerprint.** | A |
| **D** | **Direct deep-link resolution** | Universal Link / App Link token extraction → `claimFunnelToken`. Cross-platform resolver + app linking-config wiring guidance. | A |
| **E** | **First-launch orchestration + callback (the brain)** | Deterministic priority pipeline (direct deep link → platform deferred source → surface "identity needed"), once-per-install, connection/resolution timeout, fires `FunnelClaimResolved`. **This is the SDK's job — the core of being MMP-grade.** | A, B, C, D |
| **F** | **Email + claim-code path** | `claimViaEmail` (in A) + magic-link return deep link completing the claim + manual claim-code entry (needs a small backend "code → token" mapping; today only email/token exist). App builds the UI; SDK owns claim + callback. Login-match (identity #4) integration guidance. | A, D |
| **G** | **App Store compliance** | Privacy manifest, no-fingerprint guarantee, required-reason-API audit (do **not** touch system boot time / uptime — its approved reason bars off-device transmission). Cross-cutting checklist applied across C/E. | C, E |

**Build order:** A → (B ∥ C ∥ D, all depend only on A) → E (orchestrates B/C/D)
→ F → G (parallel where it touches C/E).

## What's already done (no work needed)

- Backend: 3 claim endpoints, magic-link (`/public/magic/:nonce`), universal
  redirect (`/universal/funnels/open/:token`), token/fingerprint/install-referrer
  services, 8 outbox event types — all production-ready.
- Database: 8 tables + repositories (`funnel_claim_tokens`,
  `funnel_deferred_claims`, sessions, answers, etc.).
- Dashboard: funnel builder (26 components). (Full ClickHouse analytics +
  template marketplace remain — separate, out of this SDK scope.)

## Backend changes implied by these decisions (small)

- Reduce iOS matching in `fingerprint.ts` to **IP-only + 1h window +
  unique-match guard** (sub-project C). Android referrer path unchanged.
- Add a **manual claim-code → token** mapping for the floor fallback
  (sub-project F).
- Public funnel page writes the token to the clipboard on the CTA (sub-project
  C, web side).

## Next step

Brainstorm **sub-project A (Claim core + install lifecycle)** in full → its own
design spec → implementation plan.
