import { useQuery } from "@tanstack/react-query";
import type { MeResponse } from "@rovenue/shared";
import { api } from "../api";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<MeResponse>("/dashboard/me"),
    select: (res) => res.user,
  });
}
