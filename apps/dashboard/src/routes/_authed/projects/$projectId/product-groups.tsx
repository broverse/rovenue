import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../ui/button";
import { BookOpen, Plus } from "lucide-react";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectProductGroups } from "../../../../lib/hooks/useProjectProductGroups";
import { useProjectProducts } from "../../../../lib/hooks/useProjectProducts";
import { rowToUiProductGroup } from "../../../../lib/dashboard-mappers";
import {
  EntitlementsSection,
  OfferingsSection,
  ProductEntitlementMatrix,
  ProductGroupHeader,
  ProductGroupList,
  type ProductGroup,
} from "../../../../components/product-groups";

export const Route = createFileRoute("/_authed/projects/$projectId/product-groups")({
  component: ProductGroupsRoute,
});

function ProductGroupsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/product-groups" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <ProductGroupsPage projectId={projectId} />;
}

function ProductGroupsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>("");
  const [search, setSearch] = useState("");

  const groupsQuery = useProjectProductGroups(projectId);
  // Pull enough products to resolve every group membership in one shot.
  // The CRUD layer caps lists at 100; bumping to 200 keeps lookups
  // O(1) and avoids a second roundtrip per group selection.
  const productsQuery = useProjectProducts({
    projectId,
    includeInactive: true,
    limit: 200,
  });

  const productById = useMemo(() => {
    const pages = productsQuery.data?.pages ?? [];
    const m = new Map<string, (typeof pages)[number]["products"][number]>();
    for (const page of pages) for (const row of page.products) m.set(row.id, row);
    return m;
  }, [productsQuery.data]);

  const groups = useMemo<ReadonlyArray<ProductGroup>>(() => {
    const rows = groupsQuery.data?.groups ?? [];
    return rows.map((row) => rowToUiProductGroup(row, productById));
  }, [groupsQuery.data, productById]);

  // Keep the selection sticky across refetches; fall back to the first
  // group only when nothing valid is selected anymore.
  useEffect(() => {
    if (groups.length === 0) {
      if (selectedId !== "") setSelectedId("");
      return;
    }
    if (!groups.some((g) => g.id === selectedId)) {
      setSelectedId(groups[0]!.id);
    }
  }, [groups, selectedId]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) => g.name.toLowerCase().includes(q) || g.key.toLowerCase().includes(q),
    );
  }, [groups, search]);

  const selected = useMemo(
    () => groups.find((g) => g.id === selectedId) ?? groups[0] ?? null,
    [groups, selectedId],
  );

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("productGroups.title")}
          </h1>
          <p className="mt-0.5 max-w-[640px] text-[13px] text-rv-mute-500">
            {t("productGroups.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("productGroups.actions.guide")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("productGroups.actions.newGroup")}
          </Button>
        </div>
      </header>

      {selected ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:gap-5 max-xl:lg:grid-cols-[260px_minmax(0,1fr)]">
          <ProductGroupList
            groups={filteredGroups}
            selectedId={selected.id}
            onSelect={setSelectedId}
            search={search}
            onSearchChange={setSearch}
          />

          <div className="flex min-w-0 flex-col gap-4">
            <ProductGroupHeader group={selected} />
            <EntitlementsSection group={selected} />
            <ProductEntitlementMatrix group={selected} />
            <OfferingsSection group={selected} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-rv-divider bg-rv-c1 px-6 py-12 text-center">
          <h2 className="text-[15px] font-semibold">
            {t("productGroups.empty.title", "No product groups yet")}
          </h2>
          <p className="mt-1 max-w-[420px] text-[13px] text-rv-mute-500">
            {t(
              "productGroups.empty.body",
              "Create a product group to bundle SKUs and entitlements that ship together.",
            )}
          </p>
        </div>
      )}
    </>
  );
}
