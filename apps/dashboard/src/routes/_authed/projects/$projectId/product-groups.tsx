import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import { IconBook, IconPlus } from "../../../../components/dashboard/icons";
import {
  EntitlementsSection,
  OfferingsSection,
  PRODUCT_GROUPS,
  ProductEntitlementMatrix,
  ProductGroupHeader,
  ProductGroupList,
} from "../../../../components/product-groups";

export const Route = createFileRoute("/_authed/projects/$projectId/product-groups")({
  component: ProductGroupsRoute,
});

function ProductGroupsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/product-groups" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <ProductGroupsPage />;
}

function ProductGroupsPage() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>(PRODUCT_GROUPS[0]?.id ?? "");
  const [search, setSearch] = useState("");

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PRODUCT_GROUPS;
    return PRODUCT_GROUPS.filter(
      (g) => g.name.toLowerCase().includes(q) || g.key.toLowerCase().includes(q),
    );
  }, [search]);

  const selected = useMemo(
    () => PRODUCT_GROUPS.find((g) => g.id === selectedId) ?? PRODUCT_GROUPS[0]!,
    [selectedId],
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
            <IconBook size={13} />
            {t("productGroups.actions.guide")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <IconPlus size={13} />
            {t("productGroups.actions.newGroup")}
          </Button>
        </div>
      </header>

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
    </>
  );
}
