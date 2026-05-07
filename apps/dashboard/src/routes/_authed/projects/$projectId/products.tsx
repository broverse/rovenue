import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import { IconLayers, IconPlus, IconTerminal } from "../../../../components/dashboard/icons";
import {
  BulkBar,
  GroupSidebar,
  PRODUCTS_CATALOG,
  PRODUCT_GROUPS,
  ProductDrawer,
  ProductsTable,
  ProductsToolbar,
  KeyboardTip,
  type Product,
  type SortDir,
  type SortKey,
  type StatusFilter,
} from "../../../../components/products";
import { Kbd } from "../../../../ui/kbd";

export const Route = createFileRoute("/_authed/projects/$projectId/products")({
  component: ProductsRoute,
});

function ProductsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/products" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <ProductsPage />;
}

function ProductsPage() {
  const { t } = useTranslation();
  const [group, setGroup] = useState<string>("All");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("mrr");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const groupCounts = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = { All: PRODUCTS_CATALOG.length };
    for (const g of PRODUCT_GROUPS.slice(1)) {
      m[g] = PRODUCTS_CATALOG.filter((p) => p.group === g).length;
    }
    return m;
  }, []);

  const filtered = useMemo<ReadonlyArray<Product>>(() => {
    const q = search.trim().toLowerCase();
    const list = PRODUCTS_CATALOG.filter((p) => {
      if (group !== "All" && p.group !== group) return false;
      if (status !== "all" && p.status !== status) return false;
      if (q) {
        const hay = `${p.name.toLowerCase()} ${p.sku} ${p.id.toLowerCase()}`;
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [group, status, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (filtered.every((p) => selectedIds.has(p.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((p) => p.id)));
    }
  };

  const clearFilters = () => {
    setGroup("All");
    setStatus("all");
    setSearch("");
  };

  // KPIs computed off the unfiltered catalog so they reflect the whole project.
  const totalMrr = PRODUCTS_CATALOG.reduce((s, p) => s + p.mrr, 0);
  const totalSubs = PRODUCTS_CATALOG.reduce((s, p) => s + (p.subs ?? 0), 0);
  const activeCount = PRODUCTS_CATALOG.filter((p) => p.status === "active").length;
  const draftCount = PRODUCTS_CATALOG.filter((p) => p.status === "draft").length;
  const archivedCount = PRODUCTS_CATALOG.length - activeCount - draftCount;

  const drawerProduct = useMemo<Product | null>(
    () => PRODUCTS_CATALOG.find((p) => p.id === drawerId) ?? null,
    [drawerId],
  );

  // Press `/` to focus the search input. Mirrors the keyboard tip below.
  const searchAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const input = searchAreaRef.current?.querySelector<HTMLInputElement>("input[type='text'], input:not([type])");
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("products.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">{t("products.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <IconLayers size={13} />
            {t("products.actions.importFromStore")}
          </Button>
          <Button variant="flat" size="sm">
            <IconTerminal size={13} />
            {t("products.actions.sdkSnippet")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <IconPlus size={13} />
            {t("products.actions.create")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("products.stats.total")}
          value={PRODUCTS_CATALOG.length}
          description={t("products.stats.totalBreakdown", {
            active: activeCount,
            draft: draftCount,
            archived: archivedCount,
          })}
        />
        <StatCard
          label={t("products.stats.combinedMrr")}
          value={`$${totalMrr.toLocaleString()}`}
          description={`▲ 11.3% ${t("products.stats.vsPrev")}`}
          descriptionTone="success"
        />
        <StatCard
          label={t("products.stats.activeSubs")}
          value={totalSubs.toLocaleString()}
          description={t("products.stats.acrossProducts", { count: activeCount })}
        />
        <StatCard
          label={t("products.stats.entitlements")}
          value={6}
          description="premium · pro · basic · team_features · unlimited_exports · lifetime_badge"
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
        <GroupSidebar
          sectionLabels={{
            groups: t("products.groups.heading"),
            status: t("products.status.heading"),
          }}
          groups={PRODUCT_GROUPS}
          groupCounts={groupCounts}
          selectedGroup={group}
          onSelectGroup={setGroup}
          selectedStatus={status}
          onSelectStatus={setStatus}
        />

        <div className="min-w-0">
          <div ref={searchAreaRef}>
            <ProductsToolbar
              search={search}
              onSearchChange={setSearch}
              visible={filtered.length}
              total={PRODUCTS_CATALOG.length}
            />
          </div>

          {selectedIds.size > 0 && (
            <BulkBar selectedCount={selectedIds.size} onClear={() => setSelectedIds(new Set())} />
          )}

          <ProductsTable
            products={filtered}
            selectedIds={selectedIds}
            activeId={drawerId}
            sortKey={sortKey}
            sortDir={sortDir}
            onToggleSelect={toggleOne}
            onToggleSelectAll={toggleAll}
            onSort={toggleSort}
            onOpen={setDrawerId}
            onClearFilters={clearFilters}
          />

          <KeyboardTip>
            <span>
              {t("products.tip.before")} <Kbd>C</Kbd> <Kbd>P</Kbd> {t("products.tip.create")} ·{" "}
              <Kbd>/</Kbd> {t("products.tip.search")}
            </span>
          </KeyboardTip>
        </div>
      </div>

      <ProductDrawer product={drawerProduct} onClose={() => setDrawerId(null)} />
    </>
  );
}
