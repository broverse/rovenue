import { useState } from "react";
import { Menu } from "@base-ui-components/react/menu";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  MoreHorizontal,
  Pencil,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";
import { useUpdateOffering } from "../../lib/hooks/useProjectOfferings";
import type { Offering } from "./types";

type Props = {
  projectId: string;
  offering: Offering;
  onEdit: () => void;
  onDelete: () => void;
};

const POPUP_CLASS =
  "min-w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

const DANGER_ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-danger outline-none data-[highlighted]:bg-rv-danger/10 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

/**
 * "More actions" dropdown for the selected offering. Owns its own
 * transient state (copy feedback, default-toggle pending) but delegates
 * edit + delete to dialogs at the route level.
 */
export function OfferingActionsMenu({
  projectId,
  offering,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const update = useUpdateOffering(projectId);
  const [copiedKey, setCopiedKey] = useState<"identifier" | "id" | null>(null);

  const copy = async (kind: "identifier" | "id", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(kind);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === kind ? null : current));
      }, 1400);
    } catch {
      // Clipboard unavailable (insecure context). No-op — the menu still closes.
    }
  };

  const toggleDefault = () => {
    if (update.isPending) return;
    update.mutate({ id: offering.id, isDefault: !offering.isDefault });
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(buttonVariants({ variant: "light", size: "icon" }))}
        aria-label={t("offerings.actions.more", "More actions")}
      >
        <MoreHorizontal size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className={POPUP_CLASS}>
            <Menu.Item className={ITEM_CLASS} onClick={onEdit}>
              <Pencil size={13} />
              <span className="flex-1">
                {t("offerings.menu.edit", "Edit offering")}
              </span>
            </Menu.Item>

            <Menu.Item
              className={ITEM_CLASS}
              onClick={toggleDefault}
              disabled={update.isPending}
            >
              {offering.isDefault ? <StarOff size={13} /> : <Star size={13} />}
              <span className="flex-1">
                {offering.isDefault
                  ? t("offerings.menu.unsetDefault", "Remove as default")
                  : t("offerings.menu.setDefault", "Set as default")}
              </span>
            </Menu.Item>

            <div className="my-1 h-px bg-rv-divider" />

            <Menu.Item
              className={ITEM_CLASS}
              closeOnClick={false}
              onClick={() => copy("identifier", offering.key)}
            >
              {copiedKey === "identifier" ? (
                <Check size={13} className="text-rv-success" />
              ) : (
                <Copy size={13} />
              )}
              <span className="flex-1">
                {copiedKey === "identifier"
                  ? t("offerings.menu.copied", "Copied")
                  : t("offerings.menu.copyIdentifier", "Copy identifier")}
              </span>
              <span className="font-rv-mono text-[11px] text-rv-mute-500">
                {offering.key}
              </span>
            </Menu.Item>

            <Menu.Item
              className={ITEM_CLASS}
              closeOnClick={false}
              onClick={() => copy("id", offering.id)}
            >
              {copiedKey === "id" ? (
                <Check size={13} className="text-rv-success" />
              ) : (
                <Copy size={13} />
              )}
              <span className="flex-1">
                {copiedKey === "id"
                  ? t("offerings.menu.copied", "Copied")
                  : t("offerings.menu.copyId", "Copy offering ID")}
              </span>
            </Menu.Item>

            <div className="my-1 h-px bg-rv-divider" />

            <Menu.Item className={DANGER_ITEM_CLASS} onClick={onDelete}>
              <Trash2 size={13} />
              <span className="flex-1">
                {t("offerings.menu.delete", "Delete offering")}
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
