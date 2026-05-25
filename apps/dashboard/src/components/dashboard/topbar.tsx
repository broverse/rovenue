import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import {
  Bell,
  Box,
  ChevronDown,
  Flag,
  FlaskConical,
  Key,
  Menu as MenuIcon,
  Plus,
  Settings,
  Webhook,
} from "lucide-react";
import { Button, buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";

type TopbarProps = {
  projectName: string;
  current: string;
  liveOn: boolean;
  onToggleLive: () => void;
  /** Mobile-only: opens the sidebar drawer. */
  onMenuClick?: () => void;
};

const POPUP_CLASS =
  "min-w-[200px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground";

/**
 * Sticky page topbar — breadcrumb on the left, live chip / new dropdown /
 * settings / notifications on the right.
 */
export function Topbar({
  projectName,
  current,
  liveOn,
  onToggleLive,
  onMenuClick,
}: TopbarProps) {
  const { t } = useTranslation();

  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-rv-divider bg-rv-bg/80 px-3 backdrop-blur-sm sm:px-4 lg:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground lg:hidden"
      >
        <MenuIcon size={18} />
      </button>

      <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-rv-mute-600">
        <span className="hidden truncate sm:inline">{projectName}</span>
        <span className="hidden text-rv-mute-400 sm:inline">/</span>
        <span className="truncate font-medium text-foreground">{current}</span>
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
        <button
          type="button"
          onClick={onToggleLive}
          aria-pressed={liveOn}
          aria-label={liveOn ? t("topbar.liveOnAria") : t("topbar.liveOffAria")}
          className="hidden h-7 cursor-pointer items-center gap-1.5 rounded-full border border-rv-success/25 bg-rv-success/10 px-2.5 text-xs font-medium text-rv-success transition hover:bg-rv-success/15 sm:inline-flex"
        >
          {liveOn && (
            <span className="relative inline-block size-1.5 rounded-full bg-rv-success">
              <span className="absolute -inset-0.5 rounded-full bg-rv-success/40 animate-rv-pulse" />
            </span>
          )}
          <span>{liveOn ? t("common.live") : t("common.paused")}</span>
        </button>

        <Menu.Root>
          <Menu.Trigger
            className={cn(buttonVariants({ variant: "solid-primary", size: "sm" }), "px-2 sm:px-3")}
            aria-label={t("topbar.newMenu.trigger")}
          >
            <Plus size={14} />
            <span className="hidden sm:inline">{t("topbar.newMenu.trigger")}</span>
            <ChevronDown size={12} className="hidden sm:inline" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4} align="end" className="z-50">
              <Menu.Popup className={POPUP_CLASS}>
                <NewMenuItem icon={<Box size={13} />} label={t("topbar.newMenu.product")} kbd="C P" />
                <NewMenuItem
                  icon={<FlaskConical size={13} />}
                  label={t("topbar.newMenu.experiment")}
                  kbd="C E"
                />
                <NewMenuItem
                  icon={<Flag size={13} />}
                  label={t("topbar.newMenu.featureFlag")}
                  kbd="C F"
                />
                <div className="my-1 h-px bg-rv-divider" />
                <NewMenuItem icon={<Webhook size={13} />} label={t("topbar.newMenu.webhook")} />
                <NewMenuItem icon={<Key size={13} />} label={t("topbar.newMenu.apiKey")} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>

        <Button variant="light" size="icon" aria-label={t("topbar.settings")} className="hidden sm:inline-flex">
          <Settings size={16} />
        </Button>
        <Button variant="light" size="icon" aria-label={t("topbar.notifications")} className="relative">
          <Bell size={16} />
          <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-rv-danger" />
        </Button>
      </div>
    </div>
  );
}

function NewMenuItem({
  icon,
  label,
  kbd,
}: {
  icon: React.ReactNode;
  label: string;
  kbd?: string;
}) {
  return (
    <Menu.Item className={ITEM_CLASS}>
      {icon}
      <span className="flex-1">{label}</span>
      {kbd && (
        <span className="inline-flex h-[18px] items-center rounded border border-rv-divider bg-rv-c4 px-1.5 font-rv-mono text-[10px] text-rv-mute-600">
          {kbd}
        </span>
      )}
    </Menu.Item>
  );
}
