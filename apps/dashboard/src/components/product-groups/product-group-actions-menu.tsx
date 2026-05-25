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
import { useUpdateProductGroup } from "../../lib/hooks/useProjectProductGroups";
import type { ProductGroup } from "./types";

type Props = {
  projectId: string;
  group: ProductGroup;
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
 * "More actions" dropdown for the selected product group. Owns its own
 * transient state (copy feedback, default-toggle pending) but delegates
 * edit + delete to dialogs at the route level.
 */
export function ProductGroupActionsMenu({
  projectId,
  group,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const update = useUpdateProductGroup(projectId);
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
    update.mutate({ id: group.id, isDefault: !group.isDefault });
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(buttonVariants({ variant: "light", size: "icon" }))}
        aria-label={t("productGroups.actions.more", "More actions")}
      >
        <MoreHorizontal size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className={POPUP_CLASS}>
            <Menu.Item className={ITEM_CLASS} onClick={onEdit}>
              <Pencil size={13} />
              <span className="flex-1">
                {t("productGroups.menu.edit", "Edit group")}
              </span>
            </Menu.Item>

            <Menu.Item
              className={ITEM_CLASS}
              onClick={toggleDefault}
              disabled={update.isPending}
            >
              {group.isDefault ? <StarOff size={13} /> : <Star size={13} />}
              <span className="flex-1">
                {group.isDefault
                  ? t("productGroups.menu.unsetDefault", "Remove as default")
                  : t("productGroups.menu.setDefault", "Set as default")}
              </span>
            </Menu.Item>

            <div className="my-1 h-px bg-rv-divider" />

            <Menu.Item
              className={ITEM_CLASS}
              closeOnClick={false}
              onClick={() => copy("identifier", group.key)}
            >
              {copiedKey === "identifier" ? (
                <Check size={13} className="text-rv-success" />
              ) : (
                <Copy size={13} />
              )}
              <span className="flex-1">
                {copiedKey === "identifier"
                  ? t("productGroups.menu.copied", "Copied")
                  : t("productGroups.menu.copyIdentifier", "Copy identifier")}
              </span>
              <span className="font-rv-mono text-[11px] text-rv-mute-500">
                {group.key}
              </span>
            </Menu.Item>

            <Menu.Item
              className={ITEM_CLASS}
              closeOnClick={false}
              onClick={() => copy("id", group.id)}
            >
              {copiedKey === "id" ? (
                <Check size={13} className="text-rv-success" />
              ) : (
                <Copy size={13} />
              )}
              <span className="flex-1">
                {copiedKey === "id"
                  ? t("productGroups.menu.copied", "Copied")
                  : t("productGroups.menu.copyId", "Copy group ID")}
              </span>
            </Menu.Item>

            <div className="my-1 h-px bg-rv-divider" />

            <Menu.Item className={DANGER_ITEM_CLASS} onClick={onDelete}>
              <Trash2 size={13} />
              <span className="flex-1">
                {t("productGroups.menu.delete", "Delete group")}
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
