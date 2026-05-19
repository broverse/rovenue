import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import {
  AccountPageHeader,
  AccountShell,
  ApiKeyRow,
  SectionCard,
} from "../../../components/account";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { CopyButton } from "../../../ui/copy-button";
import {
  useCreatePat,
  useMyPats,
  useRevokePat,
} from "../../../lib/hooks/useMyPats";

export const Route = createFileRoute("/_authed/account/api")({
  component: ApiPage,
});

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return iso;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function ApiPage() {
  const { t } = useTranslation();
  const { data: tokens = [], isLoading } = useMyPats();
  const createPat = useCreatePat();
  const revokePat = useRevokePat();

  const [drafting, setDrafting] = useState(false);
  const [draftName, setDraftName] = useState("");
  // Plaintext is returned exactly once by the API on create. We
  // hold it locally just long enough for the user to copy, then
  // clear it on close — `null` means "no reveal active".
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const handleCreate = async () => {
    const name = draftName.trim();
    if (!name) return;
    const res = await createPat.mutateAsync({ name });
    setRevealedToken(res.plaintext);
    setDraftName("");
    setDrafting(false);
  };

  return (
    <AccountShell active="api">
      <AccountPageHeader
        title={t("account.api.title")}
        description={t("account.api.subtitle")}
      />

      <SectionCard
        title={t("account.api.tokens.title")}
        description={t("account.api.tokens.subtitle")}
        right={
          !drafting && (
            <Button
              variant="solid-primary"
              onClick={() => setDrafting(true)}
              disabled={createPat.isPending}
            >
              <Plus size={13} />
              {t("account.api.tokens.new")}
            </Button>
          )
        }
      >
        {revealedToken && (
          <div className="mb-3 rounded-md border border-rv-warning/40 bg-rv-warning/10 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-rv-warning">
                  {t(
                    "account.api.tokens.shownOnce",
                    "Copy this token now — it won't be shown again.",
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2 rounded border border-rv-divider bg-rv-c2 px-2 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-rv-mono text-[11.5px] text-foreground">
                    {revealedToken}
                  </code>
                  <CopyButton
                    size="xs"
                    value={revealedToken}
                    label={t("sdkApi.copy.idle")}
                    copiedLabel={t("sdkApi.copy.copied")}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRevealedToken(null)}
                aria-label={t("common.dismiss", "Dismiss")}
                className="text-rv-mute-500 hover:text-foreground"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {drafting && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 p-3">
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder={t(
                "account.api.tokens.namePlaceholder",
                "e.g. CI deploy script",
              )}
              className="min-w-0 flex-1"
              autoFocus
            />
            <Button
              variant="solid-primary"
              onClick={handleCreate}
              disabled={createPat.isPending || draftName.trim().length === 0}
            >
              {createPat.isPending
                ? t("common.creating", "Creating…")
                : t("account.api.tokens.create", "Create")}
            </Button>
            <Button
              variant="light"
              onClick={() => {
                setDrafting(false);
                setDraftName("");
              }}
              disabled={createPat.isPending}
            >
              {t("common.cancel")}
            </Button>
          </div>
        )}

        {isLoading && tokens.length === 0 ? (
          <div className="py-3 text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : tokens.length === 0 ? (
          <div className="py-3 text-[12px] text-rv-mute-500">
            {t(
              "account.api.tokens.empty",
              "No personal access tokens yet.",
            )}
          </div>
        ) : (
          tokens.map((token) => (
            <ApiKeyRow
              key={token.id}
              name={token.name}
              meta={t(
                "account.api.tokens.metaLastUsed",
                "Created {{created}} · Last used {{lastUsed}}",
                {
                  created: formatRelativeTime(token.createdAt),
                  lastUsed: formatRelativeTime(token.lastUsedAt),
                },
              )}
              secret={token.prefix}
              onRevoke={() => revokePat.mutate(token.id)}
            />
          ))
        )}
      </SectionCard>
    </AccountShell>
  );
}
