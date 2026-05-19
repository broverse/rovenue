import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AnonymizeSubscriberRequest,
  AnonymizeSubscriberResponse,
  CreditHistoryResponse,
} from "@rovenue/shared";
import { ApiError, api } from "../api";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

interface IdVars {
  id: string;
}

type AnonymizeVars = IdVars & AnonymizeSubscriberRequest;

export function useAnonymizeSubscriber(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: AnonymizeVars) =>
      api<AnonymizeSubscriberResponse>(
        `/dashboard/projects/${projectId}/subscribers/${id}/anonymize`,
        {
          method: "POST",
          body: JSON.stringify({ reason: reason ?? "gdpr_request" }),
        },
      ),
    onSuccess: (_data, { id }) => {
      // Anonymize hard-replaces appUserId and stamps deletedAt, so
      // both the list and the in-flight detail need to refetch.
      qc.invalidateQueries({ queryKey: ["subscribers", projectId] });
      qc.invalidateQueries({ queryKey: ["subscriber", projectId, id] });
    },
  });
}

/**
 * Fetches the subscriber's full GDPR Art. 15 dump and triggers a
 * browser download. The endpoint sets `content-disposition:
 * attachment`, but we still drive the save manually so we can
 * respect the dashboard's cookie auth (the bare `<a download>`
 * fallback wouldn't carry `credentials: "include"`).
 */
export function useExportSubscriber(projectId: string) {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `${BASE_URL}/dashboard/projects/${projectId}/subscribers/${id}/export`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const envelope = (await res.json().catch(() => null)) as
          | { error?: { code: string; message: string } }
          | null;
        throw new ApiError(
          envelope?.error?.code ?? `HTTP_${res.status}`,
          envelope?.error?.message ?? res.statusText,
          res.status,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `subscriber-${id}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      return { id };
    },
  });
}

interface CreditHistoryParams {
  projectId: string;
  subscriberId: string;
  limit?: number;
}

export function useSubscriberCreditHistory({
  projectId,
  subscriberId,
  limit = 50,
}: CreditHistoryParams) {
  return useInfiniteQuery<CreditHistoryResponse>({
    queryKey: ["credit-history", projectId, subscriberId, limit],
    enabled: Boolean(projectId && subscriberId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam as string);
      params.set("limit", String(limit));
      return api<CreditHistoryResponse>(
        `/dashboard/projects/${projectId}/subscribers/${subscriberId}/credit-history?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
