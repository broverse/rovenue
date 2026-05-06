import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import {
  IconBell,
  IconBox,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconFlag,
  IconFlask,
  IconKey,
  IconPlus,
  IconSettings,
  IconWebhook,
} from "./icons";
import { Button, buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";

const RANGES = [
  "Today",
  "Last 7 days",
  "Last 28 days",
  "Last 90 days",
  "MTD",
  "QTD",
  "YTD",
  "Custom…",
] as const;

export type DateRange = (typeof RANGES)[number];

const RANGE_KEYS: Record<DateRange, string> = {
  "Today": "topbar.ranges.today",
  "Last 7 days": "topbar.ranges.last7",
  "Last 28 days": "topbar.ranges.last28",
  "Last 90 days": "topbar.ranges.last90",
  "MTD": "topbar.ranges.mtd",
  "QTD": "topbar.ranges.qtd",
  "YTD": "topbar.ranges.ytd",
  "Custom…": "topbar.ranges.custom",
};

type TopbarProps = {
  projectName: string;
  current: string;
  range: DateRange;
  onRangeChange: (next: DateRange) => void;
  liveOn: boolean;
  onToggleLive: () => void;
};

const POPUP_CLASS =
  "min-w-[200px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground";

/**
 * Sticky page topbar — breadcrumb + date range on the left, live chip / new
 * dropdown / settings / notifications on the right.
 */
export function Topbar({
  projectName,
  current,
  range,
  onRangeChange,
  liveOn,
  onToggleLive,
}: TopbarProps) {
  const { t } = useTranslation();

  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-rv-divider bg-rv-bg/80 px-6 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 text-[13px] text-rv-mute-600">
        <span>{projectName}</span>
        <span className="text-rv-mute-400">/</span>
        <span className="font-medium text-foreground">{current}</span>

        <Menu.Root>
          <Menu.Trigger className="ml-2 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-[13px] text-rv-mute-600 transition hover:border-rv-divider hover:bg-rv-c2 hover:text-foreground">
            <IconCalendar size={13} />
            <span>{t(RANGE_KEYS[range])}</span>
            <IconChevronDown size={12} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4} align="start" className="z-50">
              <Menu.Popup className={POPUP_CLASS}>
                <div className="px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-rv-mute-500">
                  {t("topbar.dateRange")}
                </div>
                {RANGES.map((r) => (
                  <Menu.Item
                    key={r}
                    onClick={() => onRangeChange(r)}
                    className={ITEM_CLASS}
                  >
                    {r === range ? <IconCheck size={13} /> : <span className="size-[13px]" />}
                    <span>{t(RANGE_KEYS[r])}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleLive}
          aria-pressed={liveOn}
          aria-label={liveOn ? t("topbar.liveOnAria") : t("topbar.liveOffAria")}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-rv-success/25 bg-rv-success/10 px-2.5 text-xs font-medium text-rv-success transition hover:bg-rv-success/15"
        >
          {liveOn && (
            <span className="relative inline-block size-1.5 rounded-full bg-rv-success">
              <span className="absolute -inset-0.5 rounded-full bg-rv-success/40 animate-rv-pulse" />
            </span>
          )}
          <span>{liveOn ? t("common.live") : t("common.paused")}</span>
        </button>

        <Menu.Root>
          <Menu.Trigger className={cn(buttonVariants({ variant: "solid-primary", size: "sm" }))}>
            <IconPlus size={14} />
            <span>{t("topbar.newMenu.trigger")}</span>
            <IconChevronDown size={12} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4} align="end" className="z-50">
              <Menu.Popup className={POPUP_CLASS}>
                <NewMenuItem icon={<IconBox size={13} />} label={t("topbar.newMenu.product")} kbd="C P" />
                <NewMenuItem
                  icon={<IconFlask size={13} />}
                  label={t("topbar.newMenu.experiment")}
                  kbd="C E"
                />
                <NewMenuItem
                  icon={<IconFlag size={13} />}
                  label={t("topbar.newMenu.featureFlag")}
                  kbd="C F"
                />
                <div className="my-1 h-px bg-rv-divider" />
                <NewMenuItem icon={<IconWebhook size={13} />} label={t("topbar.newMenu.webhook")} />
                <NewMenuItem icon={<IconKey size={13} />} label={t("topbar.newMenu.apiKey")} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>

        <Button variant="light" size="icon" aria-label={t("topbar.settings")}>
          <IconSettings size={16} />
        </Button>
        <Button variant="light" size="icon" aria-label={t("topbar.notifications")} className="relative">
          <IconBell size={16} />
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
