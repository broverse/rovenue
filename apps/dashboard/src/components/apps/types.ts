import type { LucideIcon } from "lucide-react";

export type CategoryId =
  | "attribution"
  | "ads"
  | "analytics"
  | "data"
  | "lifecycle"
  | "communication"
  | "automation"
  | "identity"
  | "billing";

export type RailEntryId = CategoryId | "all" | "connected";

export type AppStatus = "connected" | "available" | "error" | "unavailable";

export type AppTag = "new" | "beta" | "partner";

export type AppLogo = {
  /** CSS background — solid color or gradient string. */
  background: string;
  /** Glyph / monogram drawn over the logo background. */
  glyph: string;
  /** Override glyph foreground color when the logo background is light. */
  textColor?: string;
  /** Render a custom vector mark instead of the glyph. */
  custom?: "apple" | "meta" | "tiktok";
};

export type AppDescriptor = {
  id: string;
  category: CategoryId;
  vendorKey: string;
  logo: AppLogo;
  status: AppStatus;
  /** Sample account label for connected items. */
  account?: string;
  /** Sample relative timestamp for connected items. */
  lastSync?: string;
  featured?: boolean;
  tag?: AppTag;
};

export type RailSectionEntry = {
  kind: "section";
  /** i18n key suffix under `apps.rail.sections`. */
  labelKey: string;
};

export type RailItemEntry = {
  kind: "item";
  id: RailEntryId;
  icon: LucideIcon;
};

export type RailEntry = RailSectionEntry | RailItemEntry;

export type CategoryCounts = Readonly<Record<RailEntryId, number>>;
