import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatePersonalAccessTokenRequest,
  CreatePersonalAccessTokenResponse,
  MyPersonalAccessTokensResponse,
} from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useMyPats() {
  return useQuery({
    queryKey: ["me", "pats"],
    queryFn: () =>
      unwrap<MyPersonalAccessTokensResponse>(rpc.dashboard.me.pats.$get()),
    select: (res) => res.tokens,
  });
}

export function useCreatePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePersonalAccessTokenRequest) =>
      unwrap<CreatePersonalAccessTokenResponse>(
        rpc.dashboard.me.pats.$post({ json: body }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "pats"] });
    },
  });
}

export function useRevokePat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<{ revoked: true }>(
        rpc.dashboard.me.pats[":id"].$delete({ param: { id } }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "pats"] });
    },
  });
}
