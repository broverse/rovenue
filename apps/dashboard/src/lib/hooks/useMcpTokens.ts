import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export interface McpTokenRow {
  id: string;
  label: string;
  scope: "read" | "read_write";
  keyPublic: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateMcpTokenBody {
  label: string;
  scope: "read" | "read_write";
}

export interface CreateMcpTokenResponse {
  mcpToken: McpTokenRow;
  /** Secret plaintext, returned exactly once at creation. */
  token: string;
}

const base = (projectId: string) =>
  `/dashboard/projects/${projectId}/mcp-tokens`;

const listKey = (projectId: string) => ["mcp-tokens", projectId] as const;

/** MCP tokens (includes revoked; filter in the UI). Never carries secrets. */
export function useMcpTokens(projectId: string | undefined) {
  return useQuery({
    queryKey: listKey(projectId ?? ""),
    enabled: Boolean(projectId),
    queryFn: () => api<{ tokens: McpTokenRow[] }>(base(projectId!)),
    select: (res) => res.tokens,
  });
}

export function useCreateMcpToken(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMcpTokenBody) =>
      api<CreateMcpTokenResponse>(base(projectId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}

export function useRevokeMcpToken(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      api<{ id: string }>(`${base(projectId)}/${tokenId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}
