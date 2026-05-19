import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MyAccountsResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useMyAccounts() {
  return useQuery({
    queryKey: ["me", "accounts"],
    queryFn: () =>
      unwrap<MyAccountsResponse>(rpc.dashboard.me.accounts.$get()),
    select: (res) => res.accounts,
  });
}

export function useDisconnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      unwrap<{ disconnected: string }>(
        rpc.dashboard.me.accounts[":provider"].$delete({ param: { provider } }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "accounts"] });
    },
  });
}
