import type { ComponentType } from "react";
import {
  IconArrows,
  IconBox,
  IconChart,
  IconCohort,
  IconCoin,
  IconFlag,
  IconFlask,
  IconGrid,
  IconKey,
  IconLayers,
  IconReceipt,
  IconRotate,
  IconSearch,
  IconTag,
  IconTerminal,
  IconUsers,
  IconWebhook,
  IconZap,
  type IconProps,
} from "./icons";

type IconComponent = ComponentType<IconProps>;

export type NavItem = {
  id: string;
  /** i18n key resolved by the Sidebar via `t()`. */
  labelKey: string;
  icon: IconComponent;
  /**
   * When set, the item renders as a TanStack Router `<Link>` to this path.
   * `:projectId` is interpolated by the Sidebar before rendering.
   */
  to?: string;
  badge?: string;
  badgeLive?: boolean;
  /** Marks the route as not yet implemented; rendered with a `soon` badge. */
  soon?: boolean;
};

export type NavSection = {
  /** Stable identifier; the Sidebar renders `t(\`sidebar.sections.${sectionKey}\`)`. */
  sectionKey: string;
  items: NavItem[];
};

export const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  {
    sectionKey: "overview",
    items: [
      { id: "dashboard", labelKey: "sidebar.items.dashboard", icon: IconGrid, to: "/projects/$projectId" },
      { id: "live", labelKey: "sidebar.items.live", icon: IconZap, to: "/projects/$projectId/live-events", badgeLive: true },
    ],
  },
  {
    sectionKey: "catalog",
    items: [
      { id: "products", labelKey: "sidebar.items.products", icon: IconBox, soon: true },
      { id: "entitlements", labelKey: "sidebar.items.entitlements", icon: IconKey, soon: true },
      { id: "groups", labelKey: "sidebar.items.groups", icon: IconLayers, soon: true },
      { id: "offerings", labelKey: "sidebar.items.offerings", icon: IconTag, soon: true },
    ],
  },
  {
    sectionKey: "customers",
    items: [
      { id: "subscribers", labelKey: "sidebar.items.subscribers", icon: IconUsers, to: "/projects/$projectId/subscribers" },
      { id: "subscriptions", labelKey: "sidebar.items.subscriptions", icon: IconRotate, soon: true },
      { id: "transactions", labelKey: "sidebar.items.transactions", icon: IconReceipt, soon: true },
    ],
  },
  {
    sectionKey: "growth",
    items: [
      { id: "experiments", labelKey: "sidebar.items.experiments", icon: IconFlask, soon: true, badge: "3" },
      { id: "flags", labelKey: "sidebar.items.flags", icon: IconFlag, soon: true },
      { id: "cohorts", labelKey: "sidebar.items.cohorts", icon: IconCohort, soon: true },
    ],
  },
  {
    sectionKey: "ledger",
    items: [
      { id: "credits", labelKey: "sidebar.items.credits", icon: IconCoin, soon: true },
      { id: "adjustments", labelKey: "sidebar.items.adjustments", icon: IconArrows, soon: true },
    ],
  },
  {
    sectionKey: "insights",
    items: [
      { id: "charts", labelKey: "sidebar.items.charts", icon: IconChart, soon: true },
      { id: "queries", labelKey: "sidebar.items.queries", icon: IconSearch, soon: true },
    ],
  },
  {
    sectionKey: "integrations",
    items: [
      { id: "webhooks", labelKey: "sidebar.items.webhooks", icon: IconWebhook, soon: true },
      { id: "sdk", labelKey: "sidebar.items.sdk", icon: IconTerminal, soon: true },
    ],
  },
];
