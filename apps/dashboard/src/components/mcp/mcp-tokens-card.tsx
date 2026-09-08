import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../ui/button";
import { Chip } from "../../ui/chip";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { CopyButton } from "../../ui/copy-button";
import type { McpTokenRow } from "../../lib/hooks/useMcpTokens";
import { useRevokeMcpToken } from "../../lib/hooks/useMcpTokens";

interface Props {
  projectId: string;
  tokens: ReadonlyArray<McpTokenRow>;
  onCreate: () => void;
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return null;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Public id preview: full value is needed to-skew nothing, but the list
 * stays scannable without the whole `rov_mcp_…` string on every row. */
function previewPublicId(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 14)}…${value.slice(-6)}`;
}

export function McpTokensCard({ projectId, tokens, onCreate }: Props) {
  const { t } = useTranslation();
  const revoke = useRevokeMcpToken(projectId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const active = tokens.filter((tok) => !tok.revokedAt);
  const revoked = tokens.filter((tok) => Boolean(tok.revokedAt));

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rv-divider px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-5 text-foreground">
            {t("mcp.tokens.title")}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
            {t("mcp.tokens.subtitle")}
          </p>
        </div>
        <Button variant="solid-primary" size="sm" onClick={onCreate}>
          <Plus size={13} />
          {t("mcp.tokens.actions.create")}
        </Button>
      </header>
      <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
        {active.length === 0 && (
          <div className="rounded-md border border-dashed border-rv-divider bg-rv-c2 px-3 py-6 text-center text-[12px] text-rv-mute-500">
            {t("mcp.tokens.empty")}
          </div>
        )}
        {active.map((tok) => {
          const lastUsed = formatRelative(tok.lastUsedAt);
          return (
            <div
              key={tok.id}
              className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {tok.label}
                  </span>
                  <Chip tone={tok.scope === "read_write" ? "warning" : "default"}>
                    {t(`mcp.tokens.scopes.${tok.scope}`)}
                  </Chip>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-rv-mute-500">
                  <code className="font-mono">{previewPublicId(tok.keyPublic)}</code>
                  <CopyButton value={tok.keyPublic} size="xs" />
                  {lastUsed && (
                    <span>{t("mcp.tokens.lastUsed", { when: lastUsed })}</span>
                  )}
                  {tok.expiresAt && (
                    <span>
                      {t("mcp.tokens.expires", {
                        date: new Date(tok.expiresAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        }),
                      })}
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="light"
                size="sm"
                className="shrink-0 self-center text-rv-danger"
                onClick={() => setConfirmId(tok.id)}
                aria-label={t("mcp.tokens.actions.revoke")}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          );
        })}
        {revoked.length > 0 && (
          <p className="px-1 pt-1 text-[12px] text-rv-mute-500">
            {t("mcp.tokens.revokedCount", { count: revoked.length })}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirmId !== null}
        title={t("mcp.tokens.revokeConfirm.title")}
        description={t("mcp.tokens.revokeConfirm.body")}
        confirmLabel={t("mcp.tokens.revokeConfirm.confirm")}
        tone="danger"
        onConfirm={async () => {
          if (!confirmId) return;
          try {
            await revoke.mutateAsync(confirmId);
          } catch (err) {
            setRevokeError(
              err instanceof Error ? err.message : t("mcp.tokens.revokeConfirm.failed"),
            );
          }
        }}
        onClose={() => setConfirmId(null)}
      />
      <ConfirmDialog
        open={revokeError !== null}
        tone="danger"
        hideCancel
        title={t("mcp.tokens.revokeConfirm.failedTitle")}
        description={revokeError}
        confirmLabel={t("common.dismiss", "Dismiss")}
        onConfirm={() => setRevokeError(null)}
        onClose={() => setRevokeError(null)}
      />
    </section>
  );
}
