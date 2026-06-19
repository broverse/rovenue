import { useQuery } from "@tanstack/react-query";
import type { ListWebhookDeliveriesResponse } from "@rovenue/shared";
import { api } from "../api";

const PAGE_SIZE = 20;

/**
 * Recent outgoing webhook deliveries (all statuses) for a project,
 * paginated. Backs the custom-webhook detail page's history table.
 */
export function useWebhookDeliveries(
  projectId: string,
  page = 0,
  limit = PAGE_SIZE,
) {
  const offset = page * limit;
  return useQuery({
    queryKey: ["webhook-deliveries", projectId, limit, offset],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ListWebhookDeliveriesResponse>(
        `/dashboard/webhooks/deliveries?projectId=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`,
      ),
  });
}
