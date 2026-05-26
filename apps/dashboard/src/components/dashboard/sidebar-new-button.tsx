import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import {
  Box,
  ChevronDown,
  Flag,
  FlaskConical,
  Key,
  Plus,
  Webhook,
} from "lucide-react";

const POPUP_CLASS =
  "min-w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground";

export function SidebarNewButton() {
  const { t } = useTranslation();

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={t("topbar.newMenu.trigger")}
        className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md bg-rv-accent-500 px-2.5 text-[13px] font-medium text-white outline-none transition hover:bg-rv-accent-600 focus-visible:ring-2 focus-visible:ring-rv-accent-500"
      >
        <Plus size={14} />
        <span className="flex-1 text-left">{t("topbar.newMenu.trigger")}</span>
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} side="bottom" align="start" className="z-50">
          <Menu.Popup className={POPUP_CLASS}>
            <NewMenuItem icon={<Box size={13} />} label={t("topbar.newMenu.product")} kbd="C P" />
            <NewMenuItem icon={<FlaskConical size={13} />} label={t("topbar.newMenu.experiment")} kbd="C E" />
            <NewMenuItem icon={<Flag size={13} />} label={t("topbar.newMenu.featureFlag")} kbd="C F" />
            <div className="my-1 h-px bg-rv-divider" />
            <NewMenuItem icon={<Webhook size={13} />} label={t("topbar.newMenu.webhook")} />
            <NewMenuItem icon={<Key size={13} />} label={t("topbar.newMenu.apiKey")} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
