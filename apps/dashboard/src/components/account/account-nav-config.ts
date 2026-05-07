import {
  AlertOctagon,
  Bell,
  Database,
  FileText,
  Gauge,
  Link2,
  Palette,
  Receipt,
  Shield,
  Terminal,
  User,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type AccountTabId =
  | "profile"
  | "security"
  | "notifications"
  | "connected"
  | "billing"
  | "invoices"
  | "usage"
  | "api"
  | "team"
  | "appearance"
  | "export";

export type AccountSectionKey = "account" | "workspace" | "preferences";

export type AccountTab = {
  id: AccountTabId;
  /** Path under `/account/` (without leading slash). */
  path: AccountTabId;
  labelKey: string;
  icon: LucideIcon;
  badge?: string;
};

export type AccountNavSection = {
  key: AccountSectionKey;
  items: ReadonlyArray<AccountTab>;
};

export const ACCOUNT_NAV: ReadonlyArray<AccountNavSection> = [
  {
    key: "account",
    items: [
      { id: "profile", path: "profile", labelKey: "account.nav.items.profile", icon: User },
      { id: "security", path: "security", labelKey: "account.nav.items.security", icon: Shield },
      {
        id: "notifications",
        path: "notifications",
        labelKey: "account.nav.items.notifications",
        icon: Bell,
      },
      {
        id: "connected",
        path: "connected",
        labelKey: "account.nav.items.connected",
        icon: Link2,
      },
    ],
  },
  {
    key: "workspace",
    items: [
      { id: "billing", path: "billing", labelKey: "account.nav.items.billing", icon: Receipt },
      {
        id: "invoices",
        path: "invoices",
        labelKey: "account.nav.items.invoices",
        icon: FileText,
        badge: "24",
      },
      { id: "usage", path: "usage", labelKey: "account.nav.items.usage", icon: Gauge },
      { id: "api", path: "api", labelKey: "account.nav.items.api", icon: Terminal },
      { id: "team", path: "team", labelKey: "account.nav.items.team", icon: Users },
    ],
  },
  {
    key: "preferences",
    items: [
      {
        id: "appearance",
        path: "appearance",
        labelKey: "account.nav.items.appearance",
        icon: Palette,
      },
      {
        id: "export",
        path: "export",
        labelKey: "account.nav.items.export",
        icon: Database,
      },
    ],
  },
];

export const ACCOUNT_TABS: ReadonlyArray<AccountTab> = ACCOUNT_NAV.flatMap((s) => s.items);

export const FALLBACK_ICON: LucideIcon = AlertOctagon;
