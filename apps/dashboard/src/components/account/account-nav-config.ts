import { AlertOctagon, Bell, Gauge, Link2, Shield, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type AccountTabId =
  | "profile"
  | "security"
  | "notifications"
  | "connected"
  | "usage";

export type AccountSectionKey = "account" | "workspace";

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
      { id: "usage", path: "usage", labelKey: "account.nav.items.usage", icon: Gauge },
    ],
  },
];

export const ACCOUNT_TABS: ReadonlyArray<AccountTab> = ACCOUNT_NAV.flatMap((s) => s.items);

export const FALLBACK_ICON: LucideIcon = AlertOctagon;
