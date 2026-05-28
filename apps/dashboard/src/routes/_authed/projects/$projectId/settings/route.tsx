import {
  Link,
  Outlet,
  createFileRoute,
  useChildMatches,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  CreditCard,
  FileText,
  History,
  KeyRound,
  Receipt,
  Settings as SettingsIcon,
  Sparkles,
  UserCog,
} from "lucide-react";
import { cn } from "../../../../../lib/cn";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  component: SettingsLayout,
});

const TABS = [
  {
    id: "general",
    labelKey: "settings.tabs.general",
    icon: SettingsIcon,
    to: "/projects/$projectId/settings" as const,
    match: (id: string) => id.endsWith("/settings/") || id.endsWith("/settings"),
  },
  {
    id: "rovi",
    labelKey: "settings.tabs.rovi",
    icon: Sparkles,
    to: "/projects/$projectId/settings/rovi" as const,
    match: (id: string) => id.endsWith("/settings/rovi"),
  },
  {
    id: "sdk",
    labelKey: "settings.tabs.sdk",
    icon: KeyRound,
    to: "/projects/$projectId/settings/sdk" as const,
    match: (id: string) => id.endsWith("/settings/sdk"),
  },
  {
    id: "billing",
    labelKey: "settings.tabs.billing",
    icon: Receipt,
    to: "/projects/$projectId/settings/billing" as const,
    match: (id: string) => id.endsWith("/settings/billing"),
  },
  {
    id: "paymentMethods",
    labelKey: "settings.tabs.paymentMethods",
    icon: CreditCard,
    to: "/projects/$projectId/settings/payment-methods" as const,
    match: (id: string) => id.endsWith("/settings/payment-methods"),
  },
  {
    id: "invoices",
    labelKey: "settings.tabs.invoices",
    icon: FileText,
    to: "/projects/$projectId/settings/invoices" as const,
    match: (id: string) => id.endsWith("/settings/invoices"),
  },
  {
    id: "members",
    labelKey: "settings.tabs.members",
    icon: UserCog,
    to: "/projects/$projectId/settings/members" as const,
    match: (id: string) => id.endsWith("/settings/members"),
  },
  {
    id: "auditLogs",
    labelKey: "settings.tabs.auditLogs",
    icon: History,
    to: "/projects/$projectId/settings/audit-logs" as const,
    match: (id: string) => id.endsWith("/settings/audit-logs"),
  },
] as const;

function SettingsLayout() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/settings" });
  const matches = useChildMatches();
  const activeRouteId = matches[matches.length - 1]?.routeId ?? "";
  const activeId =
    TABS.find((tab) => tab.match(activeRouteId))?.id ?? "general";

  return (
    <div className="flex flex-col gap-6">
      <nav
        aria-label={t("settings.tabs.aria", "Settings sections")}
        className="-mx-1 flex gap-1 overflow-x-auto border-b border-rv-divider pb-2 pt-1"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeId;
          return (
            <Link
              key={tab.id}
              to={tab.to}
              params={{ projectId }}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground",
                isActive && "bg-rv-accent-500/15 text-rv-accent-400 hover:bg-rv-accent-500/15 hover:text-rv-accent-400",
              )}
            >
              <Icon size={13} className="shrink-0" />
              <span>{t(tab.labelKey)}</span>
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </div>
  );
}
