import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { MyAccountsResponse } from "@rovenue/shared";
import { api } from "../api";

export function useMyAccounts() {
  return useQuery({
    queryKey: ["me", "accounts"],
    queryFn: () => api<MyAccountsResponse>("/dashboard/me/accounts"),
    select: (res) => res.accounts,
  });
}

export function useDisconnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      api<{ disconnected: string }>(
        `/dashboard/me/accounts/${encodeURIComponent(provider)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "accounts"] });
    },
  });
}
