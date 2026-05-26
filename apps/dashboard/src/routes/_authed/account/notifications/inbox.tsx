import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  SectionCard,
} from "../../../../components/account";
import { Button } from "../../../../ui/button";
import { Switch } from "../../../../ui/switch";
import { NotificationRow } from "../../../../components/notifications/notification-row";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationFeed,
} from "../../../../lib/hooks/useNotifications";

// File-route path: /account/notifications/inbox
export const Route = createFileRoute(
  "/_authed/account/notifications/inbox" as never,
)({
  component: InboxPage,
});

function InboxPage() {
  const { t } = useTranslation();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const feed = useNotificationFeed({ unreadOnly, limit: 20 });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const pages = feed.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);

  return (
    <AccountShell active="notifications">
      <AccountPageHeader
        title={t("notifications.inbox.title", "Inbox")}
        description={t(
          "notifications.inbox.description",
          "Every alert routed to you across projects.",
        )}
      />

      <SectionCard title={t("notifications.inbox.section", "Feed")}>
        <div className="mb-3 flex items-center justify-between border-b border-rv-divider pb-3">
          <label className="flex items-center gap-2 text-[12px] text-rv-mute-700">
            <Switch
              checked={unreadOnly}
              onChange={setUnreadOnly}
              ariaLabel={t(
                "notifications.inbox.unreadOnly",
                "Unread only",
              )}
            />
            {t("notifications.inbox.unreadOnly", "Unread only")}
          </label>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-rv-mute-500">
              {items.length}{" "}
              {t("notifications.inbox.itemsLoaded", "loaded")}
            </span>
            <Button
              variant="light"
              size="sm"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate(undefined)}
            >
              {t("notifications.bell.markAll", "Mark all as read")}
            </Button>
          </div>
        </div>

        {feed.isLoading ? (
          <p className="py-10 text-center text-[12px] text-rv-mute-500">
            {t("notifications.bell.loading", "Loading…")}
          </p>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-[12px] text-rv-mute-500">
            {t("notifications.inbox.empty", "No notifications yet.")}
          </p>
        ) : (
          <div className="flex flex-col">
            {items.map((row) => (
              <NotificationRow
                key={row.id}
                row={row}
                onMarkRead={(id) => markRead.mutate(id)}
              />
            ))}
          </div>
        )}

        {feed.hasNextPage ? (
          <div className="mt-4 text-center">
            <Button
              variant="light"
              size="sm"
              onClick={() => void feed.fetchNextPage()}
              disabled={feed.isFetchingNextPage}
            >
              {feed.isFetchingNextPage
                ? t("notifications.bell.loading", "Loading…")
                : t("notifications.inbox.loadMore", "Load more")}
            </Button>
          </div>
        ) : null}
      </SectionCard>
    </AccountShell>
  );
}
