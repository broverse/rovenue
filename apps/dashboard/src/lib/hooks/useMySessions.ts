import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MySessionsResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useMySessions() {
  return useQuery({
    queryKey: ["me", "sessions"],
    queryFn: () =>
      unwrap<MySessionsResponse>(rpc.dashboard.me.sessions.$get()),
    select: (res) => res.sessions,
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<{ revoked: true }>(
        rpc.dashboard.me.sessions[":id"].$delete({ param: { id } }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "sessions"] });
    },
  });
}
