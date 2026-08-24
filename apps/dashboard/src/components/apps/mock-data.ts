import { BarChart3, CircleCheck, LayoutGrid, Megaphone, MessageSquare, Radar } from "lucide-react";
import type { AppDescriptor, CategoryId, RailEntry } from "./types";

/** Catalog id for the CUSTOM_WEBHOOK provider's card (Task 12). Distinct
 *  from the pre-existing single-endpoint "custom webhook" feature
 *  (ConfiguredWebhookCard / CustomWebhookModal, project.webhookUrl) — this
 *  one is the multi-connection integrations-framework provider. */
export const CUSTOM_WEBHOOK_APP_ID = "custom-webhook";

/**
 * Static catalog of integrations Rovenue ships with.
 *
 * The two outbound ad-platform integrations plus the generic
 * outgoing-webhook provider were the first wired end-to-end (M0–M9 plan,
 * branch `feat/integrations-meta-tiktok`, extended by Task 12); AMPLITUDE
 * (Wave-1 Task 5) is the first `analytics`-category entry; APPSFLYER
 * (Wave-1 Task 7) is the first `attribution`-category entry; SLACK
 * (Wave-1 Task 9) is the first `communication`-category entry. Other
 * surfaces — lifecycle, data, automation, etc. — are still out of scope.
 * When a new provider lands, add it here with its own `custom` brand mark in
 * `app-logo.tsx` if it needs a vector logo instead of a glyph.
 */
export const APPS: ReadonlyArray<AppDescriptor> = [
  {
    id: "meta-capi",
    category: "ads",
    vendorKey: "meta",
    logo: {
      // Meta brand blue (2024 refresh).
      background: "#0866FF",
      glyph: "",
      custom: "meta",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: "tiktok-events",
    category: "ads",
    vendorKey: "bytedance",
    logo: {
      // TikTok official mark on black.
      background: "#000",
      glyph: "",
      custom: "tiktok",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: CUSTOM_WEBHOOK_APP_ID,
    category: "automation",
    vendorKey: "rovenue",
    logo: {
      background: "#6D28D9",
      glyph: "W",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: "amplitude",
    category: "analytics",
    vendorKey: "amplitude",
    logo: {
      // Amplitude brand blue.
      background: "#0148FE",
      glyph: "A",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: "mixpanel",
    category: "analytics",
    vendorKey: "mixpanel",
    logo: {
      // Mixpanel brand purple.
      background: "#7856FF",
      glyph: "M",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: "appsflyer",
    category: "attribution",
    vendorKey: "appsflyer",
    logo: {
      // AppsFlyer brand blue.
      background: "#0F1F41",
      glyph: "AF",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: "adjust",
    category: "attribution",
    vendorKey: "adjust",
    logo: {
      // Adjust brand red.
      background: "#EC1C50",
      glyph: "AJ",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: "slack",
    category: "communication",
    vendorKey: "slack",
    logo: {
      // Slack "Aubergine" brand purple.
      background: "#4A154B",
      glyph: "S",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
  {
    id: "firebase-ga4",
    category: "analytics",
    // en.json has no dedicated "firebase" vendors.* entry — "google" is the
    // correct existing key (Google LLC), matching Task 10 controller
    // ruling's "use whichever exists".
    vendorKey: "google",
    logo: {
      // Firebase brand amber/orange.
      background: "#FFA000",
      glyph: "F",
    },
    status: "available",
    tag: "new",
    featured: true,
  },
];

export const RAIL_ENTRIES: ReadonlyArray<RailEntry> = [
  { kind: "item", id: "all", icon: LayoutGrid },
  { kind: "item", id: "connected", icon: CircleCheck },
  { kind: "section", labelKey: "byUseCase" },
  { kind: "item", id: "ads", icon: Megaphone },
  { kind: "item", id: "analytics", icon: BarChart3 },
  { kind: "item", id: "attribution", icon: Radar },
  { kind: "item", id: "communication", icon: MessageSquare },
];

export const HOMEPAGE_SECTIONS: ReadonlyArray<CategoryId> = [
  "ads",
  "analytics",
  "attribution",
  "communication",
];

/** Public documentation site — linked from the docs / API-reference CTAs. */
export const DOCS_URL = "https://docs.rovenue.io";
