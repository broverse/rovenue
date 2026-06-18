import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
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

export function SidebarNewButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Product has no dedicated route — it lives behind a modal on the products
  // page, so we route there with `?new=1` and let the page open the dialog.
  const createProduct = () =>
    void navigate({
      to: "/projects/$projectId/products",
      params: { projectId },
      search: { new: true },
    });
  const createExperiment = () =>
    void navigate({ to: "/projects/$projectId/experiments/new", params: { projectId } });
  const createFlag = () =>
    void navigate({ to: "/projects/$projectId/feature-flags/new", params: { projectId } });
  // Webhooks and API keys are managed inline on the SDK settings page.
  const goSdkSettings = () =>
    void navigate({ to: "/projects/$projectId/settings/sdk", params: { projectId } });

  // Global "c <key>" chord shortcuts (c p / c e / c f), mirroring the chips
  // shown on the menu items. Skipped while typing in a field or when a
  // modifier is held so we never steal keystrokes.
  useEffect(() => {
    let lastC = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inEditable || e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      const now = Date.now();
      if (key === "c") {
        lastC = now;
        return;
      }
      if (now - lastC >= 800) return;
      if (key === "p") {
        e.preventDefault();
        lastC = 0;
        createProduct();
      } else if (key === "e") {
        e.preventDefault();
        lastC = 0;
        createExperiment();
      } else if (key === "f") {
        e.preventDefault();
        lastC = 0;
        createFlag();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
            <NewMenuItem
              icon={<Box size={13} />}
              label={t("topbar.newMenu.product")}
              kbd="C P"
              onClick={createProduct}
            />
            <NewMenuItem
              icon={<FlaskConical size={13} />}
              label={t("topbar.newMenu.experiment")}
              kbd="C E"
              onClick={createExperiment}
            />
            <NewMenuItem
              icon={<Flag size={13} />}
              label={t("topbar.newMenu.featureFlag")}
              kbd="C F"
              onClick={createFlag}
            />
            <div className="my-1 h-px bg-rv-divider" />
            <NewMenuItem
              icon={<Webhook size={13} />}
              label={t("topbar.newMenu.webhook")}
              onClick={goSdkSettings}
            />
            <NewMenuItem
              icon={<Key size={13} />}
              label={t("topbar.newMenu.apiKey")}
              onClick={goSdkSettings}
            />
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
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  kbd?: string;
  onClick?: () => void;
}) {
  return (
    <Menu.Item className={ITEM_CLASS} onClick={onClick}>
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
