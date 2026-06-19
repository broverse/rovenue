import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Coins, Plus } from "lucide-react";
import type { VirtualCurrency } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { ConfirmDialog } from "../../../../ui/confirm-dialog";
import { CurrenciesTable, CurrencyDialog } from "../../../../components/currencies";
import {
  useArchiveVirtualCurrency,
  useVirtualCurrencies,
} from "../../../../lib/hooks/useVirtualCurrencies";

export const Route = createFileRoute("/_authed/projects/$projectId/currencies")({
  component: CurrenciesRoute,
});

function CurrenciesRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/currencies",
  });
  return <CurrenciesPage projectId={projectId} />;
}

function CurrenciesPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: currencies, isLoading, error } = useVirtualCurrencies(projectId);
  const archive = useArchiveVirtualCurrency(projectId);

  // `null` editing + dialogOpen=true → create; a currency → rename.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<VirtualCurrency | null>(null);
  const [archiving, setArchiving] = useState<VirtualCurrency | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openRename = (currency: VirtualCurrency) => {
    setEditing(currency);
    setDialogOpen(true);
  };

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
            {t("currencies.title")}
          </h1>
          <p className="mt-1 text-[12.5px] text-rv-mute-500 sm:text-[13px]">
            {t("currencies.subtitle")}
          </p>
        </div>
        <Button variant="solid-primary" size="sm" onClick={openCreate}>
          <Plus size={13} />
          {t("currencies.actions.create")}
        </Button>
      </header>

      {isLoading ? (
        <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-10 text-center text-[13px] text-rv-mute-500">
          {t("common.loading", "Loading…")}
        </div>
      ) : error ? (
        <div
          role="alert"
          className="rounded-lg border border-rv-danger/30 bg-rv-danger/5 px-4 py-6 text-center text-[13px] text-rv-danger"
        >
          {error instanceof Error ? error.message : t("currencies.errors.load")}
        </div>
      ) : !currencies || currencies.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-rv-divider bg-rv-c1 px-4 py-12 text-center">
          <Coins size={20} className="text-rv-mute-500" />
          <p className="text-[13px] text-rv-mute-700">{t("currencies.empty.title")}</p>
          <p className="text-[12px] text-rv-mute-500">{t("currencies.empty.body")}</p>
        </div>
      ) : (
        <CurrenciesTable
          currencies={currencies}
          onRename={openRename}
          onArchive={setArchiving}
        />
      )}

      <CurrencyDialog
        projectId={projectId}
        open={dialogOpen}
        currency={editing}
        onClose={() => setDialogOpen(false)}
      />

      <ConfirmDialog
        open={archiving !== null}
        title={t("currencies.archiveConfirm.title")}
        description={t("currencies.archiveConfirm.body", {
          code: archiving?.code ?? "",
        })}
        confirmLabel={t("currencies.archiveConfirm.confirm")}
        tone="danger"
        onConfirm={async () => {
          if (archiving) await archive.mutateAsync(archiving.id);
        }}
        onClose={() => setArchiving(null)}
      />
    </>
  );
}
