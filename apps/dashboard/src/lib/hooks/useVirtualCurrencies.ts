import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateVirtualCurrencyRequest,
  UpdateVirtualCurrencyRequest,
  VirtualCurrency,
} from "@rovenue/shared";
import { api } from "../api";

const base = (projectId: string) =>
  `/dashboard/projects/${projectId}/virtual-currencies`;

const listKey = (projectId: string) =>
  ["virtual-currencies", projectId] as const;

/** Project virtual currencies (includes archived; filter in the UI). */
export function useVirtualCurrencies(projectId: string | undefined) {
  return useQuery({
    queryKey: listKey(projectId ?? ""),
    enabled: Boolean(projectId),
    queryFn: () =>
      api<{ currencies: VirtualCurrency[] }>(base(projectId!)),
    select: (res) => res.currencies,
  });
}

export function useCreateVirtualCurrency(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateVirtualCurrencyRequest) =>
      api<{ currency: VirtualCurrency }>(base(projectId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}

export function useRenameVirtualCurrency(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: UpdateVirtualCurrencyRequest & { id: string }) =>
      api<{ currency: VirtualCurrency }>(`${base(projectId)}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}

export function useArchiveVirtualCurrency(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ currency: VirtualCurrency }>(`${base(projectId)}/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}
