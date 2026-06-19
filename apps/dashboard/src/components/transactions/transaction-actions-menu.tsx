import { Menu } from "@base-ui-components/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { Copy, FileJson, MoreHorizontal, User, CreditCard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { buttonVariants } from "../../ui/button";
import type { Transaction } from "./types";

const POPUP_CLASS =
  "min-w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground";

/**
 * "..." overflow menu for the transaction inspector.
 * Provides: Copy transaction ID, Copy payload JSON, View subscriber,
 * View subscription (D1: no dedicated purchase route — routes to subscriber detail).
 */
export function TransactionActionsMenu({
  projectId,
  tx,
  payload,
}: {
  projectId: string;
  tx: Transaction;
  payload: unknown;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  const goToSubscriber = () =>
    void navigate({
      to: "/projects/$projectId/subscribers/$id",
      params: { projectId, id: tx.subscriberId },
    });

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(buttonVariants({ variant: "light", size: "icon" }))}
        aria-label={t("transactions.inspector.more", "More actions")}
      >
        <MoreHorizontal size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className={POPUP_CLASS}>
            <Menu.Item
              className={ITEM_CLASS}
              onClick={() => copy(tx.id)}
            >
              <Copy size={13} />
              <span className="flex-1">
                {t("transactions.inspector.menu.copyId", "Copy transaction ID")}
              </span>
            </Menu.Item>

            <Menu.Item
              className={ITEM_CLASS}
              onClick={() => copy(JSON.stringify(payload, null, 2))}
            >
              <FileJson size={13} />
              <span className="flex-1">
                {t(
                  "transactions.inspector.menu.copyPayload",
                  "Copy payload JSON",
                )}
              </span>
            </Menu.Item>

            <div className="my-1 h-px bg-rv-divider" />

            <Menu.Item className={ITEM_CLASS} onClick={goToSubscriber}>
              <User size={13} />
              <span className="flex-1">
                {t(
                  "transactions.inspector.menu.viewSubscriber",
                  "View subscriber",
                )}
              </span>
            </Menu.Item>

            {/* D1: No dedicated subscription detail route exists.
                "View subscription" navigates to the subscriber detail page
                (same route as View subscriber). Update to a purchase route
                if one is added in a future task. */}
            <Menu.Item className={ITEM_CLASS} onClick={goToSubscriber}>
              <CreditCard size={13} />
              <span className="flex-1">
                {t(
                  "transactions.inspector.menu.viewSubscription",
                  "View subscription",
                )}
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
