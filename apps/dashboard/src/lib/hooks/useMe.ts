import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse, UpdateMeRequest } from "@rovenue/shared";
import { api } from "../api";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<MeResponse>("/dashboard/me"),
    select: (res) => res.user,
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeRequest) =>
      api<MeResponse>("/dashboard/me", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["me"], data);
    },
  });
}
