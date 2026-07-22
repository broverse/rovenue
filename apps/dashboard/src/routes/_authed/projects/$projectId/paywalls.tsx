import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectPaywalls } from "../../../../lib/hooks/useProjectPaywalls";
import { useProjectOfferings } from "../../../../lib/hooks/useProjectOfferings";
import {
  DeletePaywallDialog,
  PaywallFormDialog,
  PaywallList,
  type Paywall,
} from "../../../../components/paywalls";

interface Search {
  paywallId?: string;
}

export const Route = createFileRoute("/_authed/projects/$projectId/paywalls")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    paywallId: typeof s.paywallId === "string" ? s.paywallId : undefined,
  }),
  component: PaywallsRoute,
});

function PaywallsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/paywalls" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <PaywallsPage projectId={projectId} />;
}

function PaywallsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = Route.useNavigate();
  const { paywallId: selectedId } = Route.useSearch();

  const paywallsQuery = useProjectPaywalls(projectId);
  const paywalls = paywallsQuery.data?.paywalls ?? [];

  const offeringsQuery = useProjectOfferings(projectId);
  const offeringLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of offeringsQuery.data?.offerings ?? []) {
      const name = typeof o.metadata?.name === "string" ? o.metadata.name : undefined;
      m.set(o.id, name || o.identifier);
    }
    return m;
  }, [offeringsQuery.data]);

  const selected = useMemo(
    () => paywalls.find((p) => p.id === selectedId) ?? null,
    [paywalls, selectedId],
  );

  function select(id: string | null) {
    void navigate({
      search: (): Search => (id ? { paywallId: id } : { paywallId: undefined }),
    });
  }

  useEffect(() => {
    if (!selectedId && paywalls.length > 0) {
      select(paywalls[0]!.id);
    }
    // `select` is stable (uses navigate which is stable); include only primitives to avoid loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paywalls.length, selectedId]);

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return paywalls;
    return paywalls.filter(
      (p) => p.name.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q),
    );
  }, [paywalls, search]);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("paywalls.title", "Paywalls")}
          </h1>
          <p className="mt-0.5 max-w-[640px] text-[13px] text-rv-mute-500">
            {t(
              "paywalls.subtitle",
              "Per-locale remote-config documents the SDK renders against an offering.",
            )}
          </p>
        </div>
        <Button variant="solid-primary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={13} />
          {t("paywalls.actions.new", "New paywall")}
        </Button>
      </header>

      {paywalls.length === 0 && !paywallsQuery.isPending ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:gap-5 max-xl:lg:grid-cols-[260px_minmax(0,1fr)]">
          <PaywallList
            paywalls={filtered}
            offeringLabelById={offeringLabelById}
            selectedId={selected?.id ?? ""}
            onSelect={select}
            search={search}
            onSearchChange={setSearch}
          />

          <div className="flex min-w-0 flex-col gap-4">
            {selected ? (
              <PaywallDetail
                paywall={selected}
                offeringLabel={offeringLabelById.get(selected.offeringId) ?? selected.offeringId}
                onEdit={() => setEditOpen(true)}
                onDelete={() => setDeleteOpen(true)}
              />
            ) : (
              <div className="flex items-center justify-center rounded-lg border border-rv-divider bg-rv-c1 py-16 text-[13px] text-rv-mute-500">
                {t("paywalls.selectPrompt", "Select a paywall to view its details.")}
              </div>
            )}
          </div>
        </div>
      )}

      <PaywallFormDialog
        mode="create"
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          select(id);
          setCreateOpen(false);
        }}
      />

      {selected && (
        <PaywallFormDialog
          mode="edit"
          projectId={projectId}
          open={editOpen}
          paywall={selected}
          onClose={() => setEditOpen(false)}
        />
      )}

      <DeletePaywallDialog
        projectId={projectId}
        paywall={selected}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => select(null)}
      />
    </>
  );
}

function PaywallDetail({
  paywall,
  offeringLabel,
  onEdit,
  onDelete,
}: {
  paywall: Paywall;
  offeringLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const localeCodes = Object.keys(paywall.remoteConfig.locales).sort();

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-start justify-between gap-4 border-b border-rv-divider px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-foreground">{paywall.name}</h2>
            <span
              className={
                paywall.isActive
                  ? "shrink-0 rounded-full border border-rv-success/30 bg-rv-success/10 px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-success"
                  : "shrink-0 rounded-full border border-rv-divider px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500"
              }
            >
              {paywall.isActive
                ? t("paywalls.detail.active", "Active")
                : t("paywalls.detail.inactive", "Inactive")}
            </span>
          </div>
          <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">{paywall.identifier}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="flat" size="sm" onClick={onEdit}>
            <Pencil size={13} />
            {t("paywalls.detail.edit", "Edit")}
          </Button>
          <Button
            variant="flat"
            size="sm"
            onClick={onDelete}
            className="!text-rv-danger hover:!bg-rv-danger/10"
          >
            <Trash2 size={13} />
            {t("paywalls.detail.delete", "Delete")}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-4 px-5 py-4 text-[13px] sm:grid-cols-3">
        <DetailField label={t("paywalls.detail.offering", "Offering")} value={offeringLabel} />
        <DetailField
          label={t("paywalls.detail.defaultLocale", "Default locale")}
          value={paywall.remoteConfig.defaultLocale}
          mono
        />
        <DetailField
          label={t("paywalls.detail.configVersion", "Config version")}
          value={String(paywall.configFormatVersion)}
          mono
        />
      </div>

      <div className="border-t border-rv-divider px-5 py-4">
        <h3 className="mb-2 text-[12px] font-semibold text-rv-mute-700">
          {t("paywalls.detail.locales", "Locales")}
        </h3>
        <ul className="flex flex-wrap gap-1.5">
          {localeCodes.map((code) => (
            <li key={code}>
              <span className="inline-flex items-center gap-1 rounded-full border border-rv-divider bg-rv-c2 px-2 py-0.5 font-rv-mono text-[11px] text-rv-mute-700">
                {code}
                {code === paywall.remoteConfig.defaultLocale && (
                  <span className="text-rv-accent-400">
                    {t("paywalls.detail.defaultBadge", "default")}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-rv-mute-500">{label}</div>
      <div className={mono ? "truncate font-rv-mono text-[12px] text-foreground" : "truncate text-foreground"}>
        {value}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-rv-divider bg-rv-c1 px-6 py-20 text-center">
      <div className="flex size-10 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
        <LayoutTemplate size={18} />
      </div>
      <div>
        <div className="text-[16px] font-semibold">{t("paywalls.empty.title", "No paywalls yet")}</div>
        <p className="mt-1 max-w-[400px] text-[13px] text-rv-mute-500">
          {t(
            "paywalls.empty.body",
            "Create a paywall to bind a remote-config document to an offering for the SDK to render.",
          )}
        </p>
      </div>
      <Button variant="solid-primary" size="sm" onClick={onCreate}>
        <Plus size={13} />
        {t("paywalls.empty.cta", "New paywall")}
      </Button>
    </div>
  );
}
