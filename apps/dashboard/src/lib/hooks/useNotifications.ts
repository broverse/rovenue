import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";

// =============================================================
// Notification feed hooks
// =============================================================
//
// Three concerns share one file because the bell badge + the
// dropdown + the inbox page all read from /dashboard/notifications
// and any mutation needs to invalidate the same query keys.

export interface NotificationRow {
  id: string;
  eventKey: string;
  projectId: string | null;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface FeedPage {
  items: NotificationRow[];
  nextCursor: string | null;
}

export interface UnreadCount {
  total: number;
  byProject: Record<string, number>;
}

export interface FeedOpts {
  unreadOnly?: boolean;
  projectId?: string;
  limit?: number;
}

const FEED_KEY = ["notifications", "feed"] as const;
const UNREAD_KEY = ["notifications", "unread-count"] as const;

export function useUnreadCount() {
  return useQuery({
    queryKey: UNREAD_KEY,
    queryFn: () => api<UnreadCount>("/dashboard/notifications/unread-count"),
    // The bell badge refreshes every 30s without WebSockets — keeps
    // the request volume low and is comfortably under the 1-min cache
    // TTL on the prefs side, so we don't accidentally smear stale UI.
    refetchInterval: 30_000,
  });
}

export function useNotificationFeed(opts: FeedOpts = {}) {
  const limit = opts.limit ?? 20;
  return useInfiniteQuery({
    queryKey: [...FEED_KEY, { unreadOnly: opts.unreadOnly, projectId: opts.projectId, limit }],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: FeedPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }): Promise<FeedPage> => {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      if (opts.unreadOnly) qs.set("unreadOnly", "true");
      if (opts.projectId) qs.set("projectId", opts.projectId);
      if (pageParam) qs.set("cursor", pageParam);
      return api<FeedPage>(`/dashboard/notifications?${qs.toString()}`);
    },
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean }>(`/dashboard/notifications/${id}/read`, {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: UNREAD_KEY });
      void qc.invalidateQueries({ queryKey: FEED_KEY });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId?: string) =>
      api<{ updated: number }>("/dashboard/notifications/read-all", {
        method: "POST",
        body: JSON.stringify(projectId ? { projectId } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: UNREAD_KEY });
      void qc.invalidateQueries({ queryKey: FEED_KEY });
    },
  });
}

export function useSendTestNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; eventId: string }>(
        "/dashboard/notifications/test-send",
        { method: "POST", body: "{}" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: UNREAD_KEY });
      void qc.invalidateQueries({ queryKey: FEED_KEY });
    },
  });
}
