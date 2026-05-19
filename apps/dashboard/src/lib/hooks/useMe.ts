import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse, UpdateMeRequest } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => unwrap<MeResponse>(rpc.dashboard.me.$get()),
    select: (res) => res.user,
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeRequest) =>
      unwrap<MeResponse>(rpc.dashboard.me.$patch({ json: body })),
    onSuccess: (data) => {
      qc.setQueryData(["me"], data);
    },
  });
}
