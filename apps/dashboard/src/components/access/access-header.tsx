import { useState } from "react";
import { Menu } from "@base-ui-components/react/menu";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type { DashboardAccessRow } from "@rovenue/shared";
import { buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";

type Props = {
  accessRow: DashboardAccessRow | null;
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
 * Top header card for the selected access row. Surfaces the display
 * name + identifier and exposes Edit / Delete actions via the dropdown
 * menu. Renders an empty placeholder when no row is selected.
 */
export function AccessHeader({ accessRow, onEdit, onDelete }: Props) {
  const { t } = useTranslation();

  if (!accessRow) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-rv-divider bg-rv-c1 p-10 font-rv-mono text-[12px] text-rv-mute-500">
        {t("access.header.empty", "Select an access to inspect.")}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[22px] font-semibold leading-7 tracking-tight">
            {accessRow.displayName}
          </h2>
          <div className="mt-0.5 font-rv-mono text-[12px] text-rv-mute-500">
            {accessRow.identifier}
          </div>
          {accessRow.description && (
            <p className="mt-2 max-w-[600px] text-[13px] text-rv-mute-600">
              {accessRow.description}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <AccessActionsMenu
            accessRow={accessRow}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </div>
    </div>
  );
}

function AccessActionsMenu({
  accessRow,
  onEdit,
  onDelete,
}: {
  accessRow: DashboardAccessRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
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

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(buttonVariants({ variant: "light", size: "icon" }))}
        aria-label={t("access.actions.more", "More actions")}
      >
        <MoreHorizontal size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className={POPUP_CLASS}>
            <Menu.Item className={ITEM_CLASS} onClick={onEdit}>
              <Pencil size={13} />
              <span className="flex-1">
                {t("access.menu.edit", "Edit access")}
              </span>
            </Menu.Item>

            <div className="my-1 h-px bg-rv-divider" />

            <Menu.Item
              className={ITEM_CLASS}
              closeOnClick={false}
              onClick={() => copy("identifier", accessRow.identifier)}
            >
              {copiedKey === "identifier" ? (
                <Check size={13} className="text-rv-success" />
              ) : (
                <Copy size={13} />
              )}
              <span className="flex-1">
                {copiedKey === "identifier"
                  ? t("access.menu.copied", "Copied")
                  : t("access.menu.copyIdentifier", "Copy identifier")}
              </span>
              <span className="font-rv-mono text-[11px] text-rv-mute-500">
                {accessRow.identifier}
              </span>
            </Menu.Item>

            <Menu.Item
              className={ITEM_CLASS}
              closeOnClick={false}
              onClick={() => copy("id", accessRow.id)}
            >
              {copiedKey === "id" ? (
                <Check size={13} className="text-rv-success" />
              ) : (
                <Copy size={13} />
              )}
              <span className="flex-1">
                {copiedKey === "id"
                  ? t("access.menu.copied", "Copied")
                  : t("access.menu.copyId", "Copy access ID")}
              </span>
            </Menu.Item>

            <div className="my-1 h-px bg-rv-divider" />

            <Menu.Item className={DANGER_ITEM_CLASS} onClick={onDelete}>
              <Trash2 size={13} />
              <span className="flex-1">
                {t("access.menu.delete", "Delete access")}
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
