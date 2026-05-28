import {
  Box,
  CirclePlus,
  Flag,
  FlaskConical,
  Funnel,
  KeyRound,
  LayoutGrid,
  LineChart,
  // Plug, // Re-enable when integrations (Meta CAPI / TikTok Events) backend lands.
  Receipt,
  RotateCw,
  Search,
  Settings,
  Target,
  Trophy,
  Users,
  Users2,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  id: string;
  /** i18n key resolved by the Sidebar via `t()`. */
  labelKey: string;
  icon: LucideIcon;
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
      { id: "dashboard", labelKey: "sidebar.items.dashboard", icon: LayoutGrid, to: "/projects/$projectId" },
      { id: "live", labelKey: "sidebar.items.live", icon: Zap, to: "/projects/$projectId/live-events", badgeLive: true },
    ],
  },
  {
    sectionKey: "catalog",
    items: [
      {
        id: "products",
        labelKey: "sidebar.items.products",
        icon: Box,
        to: "/projects/$projectId/products",
      },
      {
        id: "access",
        labelKey: "sidebar.items.access",
        icon: KeyRound,
        to: "/projects/$projectId/access",
      },
    ],
  },
  {
    sectionKey: "customers",
    items: [
      { id: "subscribers", labelKey: "sidebar.items.subscribers", icon: Users, to: "/projects/$projectId/subscribers" },
      { id: "subscriptions", labelKey: "sidebar.items.subscriptions", icon: RotateCw, to: "/projects/$projectId/subscriptions" },
      {
        id: "transactions",
        labelKey: "sidebar.items.transactions",
        icon: Receipt,
        to: "/projects/$projectId/transactions",
      },
    ],
  },
  {
    sectionKey: "growth",
    items: [
      {
        id: "funnels",
        labelKey: "sidebar.items.funnels",
        icon: Funnel,
        to: "/projects/$projectId/funnels",
        badge: "web",
      },
      {
        id: "experiments",
        labelKey: "sidebar.items.experiments",
        icon: FlaskConical,
        to: "/projects/$projectId/experiments",
        badge: "3",
      },
      { id: "flags", labelKey: "sidebar.items.flags", icon: Flag, to: "/projects/$projectId/feature-flags" },
      {
        id: "audiences",
        labelKey: "sidebar.items.audiences",
        icon: Target,
        to: "/projects/$projectId/audiences",
      },
      { id: "cohorts", labelKey: "sidebar.items.cohorts", icon: Users2, to: "/projects/$projectId/cohorts" },
    ],
  },
  {
    sectionKey: "ledger",
    items: [
      {
        id: "credits",
        labelKey: "sidebar.items.credits",
        icon: CirclePlus,
        to: "/projects/$projectId/credits",
      },
    ],
  },
  {
    sectionKey: "insights",
    items: [
      {
        id: "charts",
        labelKey: "sidebar.items.charts",
        icon: LineChart,
        to: "/projects/$projectId/charts",
      },
      {
        id: "queries",
        labelKey: "sidebar.items.queries",
        icon: Search,
        to: "/projects/$projectId/queries",
      },
      {
        id: "leaderboards",
        labelKey: "sidebar.items.leaderboards",
        icon: Trophy,
        to: "/projects/$projectId/leaderboards",
      },
    ],
  },
  // Hidden until Meta CAPI / TikTok Events backend ships — UI catalog
  // exists but no provider modules / connect endpoints are merged yet.
  // {
  //   sectionKey: "integrations",
  //   items: [
  //     { id: "apps", labelKey: "sidebar.items.apps", icon: Plug, to: "/projects/$projectId/apps" },
  //   ],
  // },
  {
    sectionKey: "admin",
    items: [
      {
        id: "settings",
        labelKey: "sidebar.items.settings",
        icon: Settings,
        to: "/projects/$projectId/settings",
      },
    ],
  },
];

