import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  TransactionScope,
  TransactionsListFilters,
  TransactionsListResponse,
  TransactionsListSort,
  TransactionsStoreBreakdownResponse,
  TransactionsSyncResponse,
  TransactionsVolumeResponse,
} from "@rovenue/shared";
import { api, ApiError } from "../api";

// =============================================================
// Transactions list — single-page query (cursor-driven pagination)
// =============================================================

export interface TransactionsListParams extends TransactionsListFilters {
  projectId: string;
  scope: TransactionScope;
  sort?: TransactionsListSort;
  cursor?: string | null;
  limit?: number;
}

function appendFilters(
  usp: URLSearchParams,
  params: TransactionsListFilters,
): void {
  if (params.q) usp.set("q", params.q);
  if (params.stores && params.stores.length > 0) {
    usp.set("stores", params.stores.join(","));
  }
  if (params.currencies && params.currencies.length > 0) {
    usp.set("currencies", params.currencies.join(","));
  }
  if (typeof params.amountMin === "number") {
    usp.set("amountMin", String(params.amountMin));
  }
  if (params.from) usp.set("from", params.from);
  if (params.to) usp.set("to", params.to);
}

function buildListQuery(params: TransactionsListParams): string {
  const usp = new URLSearchParams();
  usp.set("scope", params.scope);
  if (params.sort) usp.set("sort", params.sort);
  if (params.limit) usp.set("limit", String(params.limit));
  if (params.cursor) usp.set("cursor", params.cursor);
  appendFilters(usp, params);
  return usp.toString();
}

export function useProjectTransactions(params: TransactionsListParams) {
  const qs = buildListQuery(params);
  return useQuery<TransactionsListResponse>({
    queryKey: ["transactions", "list", params.projectId, qs],
    enabled: Boolean(params.projectId),
    queryFn: () =>
      api<TransactionsListResponse>(
        `/dashboard/projects/${params.projectId}/transactions?${qs}`,
      ),
    placeholderData: (prev) => prev,
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

// =============================================================
// Sync stores — surfaces outbox lag and refreshes every read
// =============================================================

export function useProjectTransactionsSync(projectId: string) {
  const qc = useQueryClient();
  return useMutation<TransactionsSyncResponse, ApiError>({
    mutationKey: ["transactions", "sync", projectId],
    mutationFn: () =>
      api<TransactionsSyncResponse>(
        `/dashboard/projects/${projectId}/transactions/sync`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
}

// =============================================================
// Export CSV — builds the same query string the list uses
// =============================================================

export interface TransactionsExportParams extends TransactionsListFilters {
  projectId: string;
  scope: TransactionScope;
  sort?: TransactionsListSort;
}

export function buildTransactionsExportUrl(
  baseUrl: string,
  params: TransactionsExportParams,
): string {
  const usp = new URLSearchParams();
  usp.set("scope", params.scope);
  if (params.sort) usp.set("sort", params.sort);
  appendFilters(usp, params);
  return `${baseUrl}/dashboard/projects/${params.projectId}/transactions/export.csv?${usp.toString()}`;
}
