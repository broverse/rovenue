import { CircleCheck, LayoutGrid, Megaphone } from "lucide-react";
import type { AppDescriptor, CategoryId, RailEntry } from "./types";

/**
 * Static catalog of integrations Rovenue ships with.
 *
 * Currently only the two outbound ad-platform integrations are wired
 * end-to-end (M0–M9 plan, branch `feat/integrations-meta-tiktok`).
 * Other surfaces — attribution, analytics, lifecycle, etc. — are out
 * of scope for the first integrations release. When a new provider
 * lands, add it here with its own `custom` brand mark in
 * `app-logo.tsx`.
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
];

export const RAIL_ENTRIES: ReadonlyArray<RailEntry> = [
  { kind: "item", id: "all", icon: LayoutGrid },
  { kind: "item", id: "connected", icon: CircleCheck },
  { kind: "section", labelKey: "byUseCase" },
  { kind: "item", id: "ads", icon: Megaphone },
];

export const HOMEPAGE_SECTIONS: ReadonlyArray<CategoryId> = ["ads"];

/** Public documentation site — linked from the docs / API-reference CTAs. */
export const DOCS_URL = "https://docs.rovenue.io";
