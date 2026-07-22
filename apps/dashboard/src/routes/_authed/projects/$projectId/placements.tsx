import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus, Rows3 } from "lucide-react";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectPlacements } from "../../../../lib/hooks/useProjectPlacements";
import {
  DeletePlacementDialog,
  PlacementEditor,
  PlacementList,
} from "../../../../components/placements";

interface Search {
  placementId?: string;
}

export const Route = createFileRoute("/_authed/projects/$projectId/placements")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    placementId: typeof s.placementId === "string" ? s.placementId : undefined,
  }),
  component: PlacementsRoute,
});

function PlacementsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/placements" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <PlacementsPage projectId={projectId} />;
}

function PlacementsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = Route.useNavigate();
  const { placementId: selectedId } = Route.useSearch();

  const placementsQuery = useProjectPlacements(projectId);
  const placements = placementsQuery.data?.placements ?? [];

  const selected = useMemo(
    () => placements.find((p) => p.id === selectedId) ?? null,
    [placements, selectedId],
  );

  const [creating, setCreating] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [search, setSearch] = useState("");

  function select(id: string | null) {
    setCreating(false);
    void navigate({
      search: (): Search => (id ? { placementId: id } : { placementId: undefined }),
    });
  }

  useEffect(() => {
    if (!selectedId && !creating && placements.length > 0) {
      select(placements[0]!.id);
    }
    // `select` is stable (uses navigate which is stable); include only primitives to avoid loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements.length, selectedId, creating]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return placements;
    return placements.filter(
      (p) => p.name.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q),
    );
  }, [placements, search]);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("placements.title", "Placements")}
          </h1>
          <p className="mt-0.5 max-w-[640px] text-[13px] text-rv-mute-500">
            {t(
              "placements.subtitle",
              "Ordered, audience-targeted rows the SDK resolves to a paywall, experiment, or nothing.",
            )}
          </p>
        </div>
        <Button
          variant="solid-primary"
          size="sm"
          onClick={() => {
            setCreating(true);
            void navigate({ search: (): Search => ({ placementId: undefined }) });
          }}
        >
          <Plus size={13} />
          {t("placements.actions.new", "New placement")}
        </Button>
      </header>

      {placements.length === 0 && !placementsQuery.isPending && !creating ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:gap-5 max-xl:lg:grid-cols-[260px_minmax(0,1fr)]">
          <PlacementList
            placements={filtered}
            selectedId={selected?.id ?? ""}
            onSelect={select}
            search={search}
            onSearchChange={setSearch}
          />

          <div className="flex min-w-0 flex-col gap-4">
            {creating ? (
              <PlacementEditor
                mode="create"
                projectId={projectId}
                onCreated={(id) => select(id)}
                onCancel={() => setCreating(false)}
              />
            ) : selected ? (
              <PlacementEditor
                mode="edit"
                projectId={projectId}
                placement={selected}
                onDeleteRequest={() => setDeleteOpen(true)}
              />
            ) : (
              <div className="flex items-center justify-center rounded-lg border border-rv-divider bg-rv-c1 py-16 text-[13px] text-rv-mute-500">
                {t("placements.selectPrompt", "Select a placement to view its details.")}
              </div>
            )}
          </div>
        </div>
      )}

      <DeletePlacementDialog
        projectId={projectId}
        placement={selected}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => select(null)}
      />
    </>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-rv-divider bg-rv-c1 px-6 py-20 text-center">
      <div className="flex size-10 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
        <Rows3 size={18} />
      </div>
      <div>
        <div className="text-[16px] font-semibold">{t("placements.empty.title", "No placements yet")}</div>
        <p className="mt-1 max-w-[400px] text-[13px] text-rv-mute-500">
          {t(
            "placements.empty.body",
            "Create a placement to route subscribers to a paywall or experiment by audience.",
          )}
        </p>
      </div>
      <Button variant="solid-primary" size="sm" onClick={onCreate}>
        <Plus size={13} />
        {t("placements.empty.cta", "New placement")}
      </Button>
    </div>
  );
}
