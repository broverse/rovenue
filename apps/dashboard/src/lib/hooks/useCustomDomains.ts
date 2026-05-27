import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc, unwrap } from "../api";

// =============================================================
// Custom-domain hooks
// =============================================================
//
// Wraps the /v1/dashboard/projects/:projectId/custom-domains routes.
// Each row carries its own DNS-instruction snippet (CNAME + TXT) so
// the UI can render the "still pending" panel without a second fetch.

export type CustomDomainCertStatus = "pending" | "issuing" | "issued" | "failed";

export interface CustomDomain {
  id: string;
  projectId: string;
  funnelId: string;
  hostname: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  verificationFailureReason: string | null;
  certStatus: CustomDomainCertStatus;
  certIssuedAt: string | null;
  certFailureReason: string | null;
  createdAt: string;
  updatedAt: string;
  verification: {
    cname: { name: string; value: string };
    txt: { name: string; value: string };
  };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

const queryKey = (projectId: string) => ["custom-domains", projectId] as const;

export function useCustomDomains(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKey(projectId ?? ""),
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ domains: CustomDomain[] }>(
        rpc.dashboard.projects[":projectId"]["custom-domains"].$get({
          param: { projectId: projectId! },
        }),
      ),
    select: (r) => r.domains,
  });
}

export function useAttachCustomDomain(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { funnelId: string; hostname: string }) =>
      unwrap<CustomDomain>(
        rpc.dashboard.projects[":projectId"]["custom-domains"].$post({
          param: { projectId },
          json: input,
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKey(projectId) });
    },
  });
}

export function useVerifyCustomDomain(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<CustomDomain & { result: VerifyResult }>(
        rpc.dashboard.projects[":projectId"]["custom-domains"][":id"].verify.$post({
          param: { projectId, id },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKey(projectId) });
    },
  });
}

export function useDeleteCustomDomain(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<{ deleted: true }>(
        rpc.dashboard.projects[":projectId"]["custom-domains"][":id"].$delete({
          param: { projectId, id },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKey(projectId) });
    },
  });
}
