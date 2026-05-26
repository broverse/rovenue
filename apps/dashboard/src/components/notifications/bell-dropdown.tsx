import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Menu } from "../../ui/menu";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationFeed,
  useUnreadCount,
} from "../../lib/hooks/useNotifications";
import { NotificationRow } from "./notification-row";

// =============================================================
// Bell dropdown — topbar notification surface
// =============================================================
//
// Renders the unread badge (max "99+") on the trigger and a
// 10-item peek of the feed when opened. "Mark all as read" and
// "View all" link to the inbox page.
//
// We don't preload the feed query — the dropdown does its own
// useNotificationFeed call which is harmless when closed
// (TanStack Query lazily evaluates queryFn only when the
// component is mounted, and the dropdown is always mounted
// in the topbar to drive the badge polling).

function formatBadge(n: number): string {
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

export function BellDropdown() {
  const { t } = useTranslation();
  const unread = useUnreadCount();
  const feed = useNotificationFeed({ limit: 10 });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const badge = formatBadge(unread.data?.total ?? 0);
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const hasUnread = (unread.data?.total ?? 0) > 0;

  return (
    <Menu
      align="end"
      className="w-[360px] max-w-[calc(100vw-1.5rem)] p-0"
      trigger={() => (
        <Button
          variant="light"
          size="icon"
          aria-label={t("topbar.notifications")}
          className="relative"
        >
          <Bell size={16} />
          {hasUnread ? (
            <span
              aria-hidden
              className="absolute right-1 top-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-rv-danger px-1 text-[9px] font-medium leading-none text-white"
            >
              {badge}
            </span>
          ) : null}
        </Button>
      )}
    >
      {(close) => (
        <div className="flex max-h-[80vh] flex-col">
          <div className="flex items-center justify-between border-b border-rv-divider px-3 py-2">
            <p className="text-[12px] font-medium text-foreground">
              {t("notifications.bell.title", "Notifications")}
            </p>
            <button
              type="button"
              disabled={!hasUnread || markAll.isPending}
              onClick={() => markAll.mutate(undefined)}
              className="text-[11px] text-rv-mute-600 transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("notifications.bell.markAll", "Mark all as read")}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-1">
            {feed.isLoading ? (
              <p className="px-3 py-6 text-center text-[12px] text-rv-mute-500">
                {t("notifications.bell.loading", "Loading…")}
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-rv-mute-500">
                {t("notifications.bell.empty", "You're all caught up.")}
              </p>
            ) : (
              items.map((row) => (
                <NotificationRow
                  key={row.id}
                  row={row}
                  onMarkRead={(id) => markRead.mutate(id)}
                />
              ))
            )}
          </div>

          <div className="border-t border-rv-divider px-3 py-2 text-right">
            <Link
              to="/account/notifications/inbox"
              onClick={close}
              className="text-[11px] text-rv-mute-700 transition hover:text-foreground"
            >
              {t("notifications.bell.viewAll", "View all")}
            </Link>
          </div>
        </div>
      )}
    </Menu>
  );
}
