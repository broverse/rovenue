import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CreatePersonalAccessTokenRequest,
  CreatePersonalAccessTokenResponse,
  MyPersonalAccessTokensResponse,
} from "@rovenue/shared";
import { api } from "../api";

export function useMyPats() {
  return useQuery({
    queryKey: ["me", "pats"],
    queryFn: () =>
      api<MyPersonalAccessTokensResponse>("/dashboard/me/pats"),
    select: (res) => res.tokens,
  });
}

export function useCreatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePersonalAccessTokenRequest) =>
      api<CreatePersonalAccessTokenResponse>("/dashboard/me/pats", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "pats"] });
    },
  });
}

export function useRevokePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ revoked: true }>(`/dashboard/me/pats/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "pats"] });
    },
  });
}
