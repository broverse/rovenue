import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { MySessionsResponse } from "@rovenue/shared";
import { api } from "../api";

export function useMySessions() {
  return useQuery({
    queryKey: ["me", "sessions"],
    queryFn: () => api<MySessionsResponse>("/dashboard/me/sessions"),
    select: (res) => res.sessions,
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ revoked: true }>(`/dashboard/me/sessions/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "sessions"] });
    },
  });
}
