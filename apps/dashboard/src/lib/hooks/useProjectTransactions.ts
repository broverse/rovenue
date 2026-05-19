import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  TransactionScope,
  TransactionsListResponse,
  TransactionsStoreBreakdownResponse,
  TransactionsVolumeResponse,
} from "@rovenue/shared";
import { api } from "../api";

// =============================================================
// Cursor-paginated transactions list
// =============================================================
//
// `useInfiniteQuery` flattens the list across page boundaries
// while keeping `nextCursor` plumbing inside the hook. Callers
// just read `pages.flatMap((p) => p.rows)`.

interface ListParams {
  projectId: string;
  scope: TransactionScope;
  limit?: number;
}

export function useProjectTransactions({ projectId, scope, limit }: ListParams) {
  return useInfiniteQuery({
    queryKey: ["transactions", "list", projectId, scope, limit],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: TransactionsListResponse) =>
      lastPage.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("scope", scope);
      if (limit) params.set("limit", String(limit));
      if (pageParam) params.set("cursor", pageParam);
      return api<TransactionsListResponse>(
        `/dashboard/projects/${projectId}/transactions?${params.toString()}`,
      );
    },
  });
}

interface VolumeParams {
  projectId: string;
  windowDays?: number;
}

export function useProjectTransactionsVolume({ projectId, windowDays }: VolumeParams) {
  return useQuery({
    queryKey: ["transactions", "volume", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const qs = windowDays ? `?windowDays=${windowDays}` : "";
      return api<TransactionsVolumeResponse>(
        `/dashboard/projects/${projectId}/transactions/volume${qs}`,
      );
    },
  });
}

interface BreakdownParams {
  projectId: string;
  windowDays?: number;
}

export function useProjectTransactionsStoreBreakdown({
  projectId,
  windowDays,
}: BreakdownParams) {
  return useQuery({
    queryKey: ["transactions", "store-breakdown", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const qs = windowDays ? `?windowDays=${windowDays}` : "";
      return api<TransactionsStoreBreakdownResponse>(
        `/dashboard/projects/${projectId}/transactions/store-breakdown${qs}`,
      );
    },
  });
}
