import { useState } from "react";
import { Menu } from "@base-ui-components/react/menu";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  KeyRound,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { DashboardAccessRow } from "@rovenue/shared";
import { Button, buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";

type Props = {
  accessRow: DashboardAccessRow | null;
  /** Number of products that currently grant this access. */
  grantingCount: number;
  onEdit: () => void;
  onDelete: () => void;
};

const POPUP_CLASS =
  "min-w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

const DANGER_ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-danger outline-none data-[highlighted]:bg-rv-danger/10 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Top header card for the selected access row. Leads with a keyed avatar so
 * the "access = a thing users hold" model reads at a glance, surfaces the
 * display name + a one-click-copy identifier, the description (or a prompt to
 * add one), and a footer strip with the at-a-glance stats. Renders an empty
 * placeholder when no row is selected.
 */
export function AccessHeader({
  accessRow,
  grantingCount,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  if (!accessRow) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-rv-divider bg-rv-c1 p-10 font-rv-mono text-[12px] text-rv-mute-500">
        {t("access.header.empty", "Select an access to inspect.")}
      </div>
    );
  }

  const copyIdentifier = async () => {
    try {
      await navigator.clipboard.writeText(accessRow.identifier);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable (insecure context) — no-op.
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-start justify-between gap-4 p-5">
        <div className="flex min-w-0 gap-3.5">
          <div className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border border-rv-accent-500/25 bg-rv-accent-500/10 text-rv-accent-500">
            <KeyRound size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[22px] font-semibold leading-7 tracking-tight">
              {accessRow.displayName}
            </h2>
            <button
              type="button"
              onClick={copyIdentifier}
              title={t("access.menu.copyIdentifier", "Copy identifier")}
              className="group mt-1 inline-flex max-w-full items-center gap-1.5 rounded border border-rv-divider bg-rv-c3 px-1.5 py-0.5 font-rv-mono text-[11px] text-rv-mute-600 transition hover:border-rv-divider-strong hover:text-foreground"
            >
              <span className="truncate">{accessRow.identifier}</span>
              {copied ? (
                <Check size={11} className="shrink-0 text-rv-success" />
              ) : (
                <Copy
                  size={11}
                  className="shrink-0 text-rv-mute-500 transition group-hover:text-rv-mute-700"
                />
              )}
            </button>

            {accessRow.description ? (
              <p className="mt-2.5 max-w-[600px] text-[13px] leading-relaxed text-rv-mute-600">
                {accessRow.description}
              </p>
            ) : (
              <button
                type="button"
                onClick={onEdit}
                className="mt-2.5 inline-flex items-center gap-1 text-[12px] text-rv-mute-500 transition hover:text-rv-accent-500"
              >
                <Plus size={12} />
                {t(
                  "access.header.addDescription",
                  "Add a description — explain what this unlocks",
                )}
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="flat" size="sm" onClick={onEdit}>
            <Pencil size={13} />
            {t("access.menu.edit", "Edit access")}
          </Button>
          <AccessActionsMenu accessRow={accessRow} onDelete={onDelete} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-rv-divider bg-rv-c2/40 px-5 py-2.5 font-rv-mono text-[11px] text-rv-mute-500">
        <span className="inline-flex items-center gap-1.5">
          <Package size={12} className="text-rv-mute-600" />
          <span className="text-rv-mute-800">{grantingCount}</span>
          {t(
            grantingCount === 1
              ? "access.stats.productOne"
              : "access.stats.productOther",
            grantingCount === 1 ? "product grants this" : "products grant this",
          )}
        </span>
        <span className="text-rv-mute-700">
          {t("access.stats.created", "Created")} {formatDate(accessRow.createdAt)}
        </span>
      </div>
    </div>
  );
}

function AccessActionsMenu({
  accessRow,
  onDelete,
}: {
  accessRow: DashboardAccessRow;
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
