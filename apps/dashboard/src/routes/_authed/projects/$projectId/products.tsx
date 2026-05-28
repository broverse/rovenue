import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Layers, Plus, Terminal } from "lucide-react";
import type { ProductTypeName } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useProjectProducts,
  type ProductStoreFilter,
} from "../../../../lib/hooks/useProjectProducts";
import { useProjectAccess } from "../../../../lib/hooks/useProjectAccess";
import { rowToUiProduct } from "../../../../lib/dashboard-mappers";
import {
  type AccessChipEntry,
  BulkBar,
  type FilterValue,
  GroupSidebar,
  ImportFromStoreModal,
  ProductDrawer,
  ProductFormModal,
  ProductsTable,
  ProductsToolbar,
  KeyboardTip,
  type Product,
  type SortDir,
  type SortKey,
  type StatusFilter,
} from "../../../../components/products";
import { Kbd } from "../../../../ui/kbd";

const VALID_TYPES = new Set<ProductTypeName>([
  "SUBSCRIPTION",
  "CONSUMABLE",
  "NON_CONSUMABLE",
]);
const VALID_STORES = new Set<ProductStoreFilter>(["ios", "android", "web"]);
const VALID_STATUS = new Set<StatusFilter>(["active", "draft", "archived", "all"]);

type ProductsSearch = {
  group?: string;
  status?: StatusFilter;
  q?: string;
  type?: ReadonlyArray<ProductTypeName>;
  store?: ReadonlyArray<ProductStoreFilter>;
};

/** Parse `?type=A,B` or `?type=A&type=B` into a typed array. */
function parseList<T extends string>(
  raw: unknown,
  valid: ReadonlySet<T>,
): ReadonlyArray<T> | undefined {
  if (raw === undefined) return undefined;
  const parts = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0);
  const filtered = parts.filter((s): s is T => valid.has(s as T));
  return filtered.length > 0 ? filtered : undefined;
}

export const Route = createFileRoute("/_authed/projects/$projectId/products")({
  component: ProductsRoute,
  validateSearch: (raw: Record<string, unknown>): ProductsSearch => {
    const status =
      typeof raw.status === "string" && VALID_STATUS.has(raw.status as StatusFilter)
        ? (raw.status as StatusFilter)
        : undefined;
    const group =
      typeof raw.group === "string" && raw.group.trim().length > 0
        ? raw.group.trim()
        : undefined;
    const q =
      typeof raw.q === "string" && raw.q.trim().length > 0 ? raw.q.trim() : undefined;
    return {
      group,
      status,
      q,
      type: parseList(raw.type, VALID_TYPES),
      store: parseList(raw.store, VALID_STORES),
    };
  },
});

function ProductsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/products" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <ProductsPage projectId={projectId} />;
}

function ProductsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  // URL-backed filter state. Derived directly so back/forward + reload + share
  // all round-trip cleanly. Local UI state is reserved for ephemeral concerns:
  // sort, selection, drawer, modal openness.
  const group = search.group ?? "All";
  const status: StatusFilter = search.status ?? "active";
  const searchText = search.q ?? "";
  const filter: FilterValue = useMemo(
    () => ({ types: search.type ?? [], stores: search.store ?? [] }),
    [search.type, search.store],
  );

  const updateSearch = useCallback(
    (patch: Partial<ProductsSearch>) => {
      void navigate({
        search: (prev) => {
          // tanstack-router preserves keys that aren't returned; we need to
          // explicitly set undefined to drop them from the URL.
          const next: ProductsSearch = { ...prev, ...patch };
          if (next.group === "All" || !next.group) delete next.group;
          if (next.status === "active" || !next.status) delete next.status;
          if (!next.q) delete next.q;
          if (!next.type || next.type.length === 0) delete next.type;
          if (!next.store || next.store.length === 0) delete next.store;
          return next;
        },
        replace: true,
      });
    },
    [navigate],
  );

  const setGroup = (next: string) => updateSearch({ group: next });
  const setStatus = (next: StatusFilter) => updateSearch({ status: next });
  const setSearchText = (next: string) => updateSearch({ q: next });
  const setFilter = (next: FilterValue) =>
    updateSearch({ type: next.types, store: next.stores });

  const [sortKey, setSortKey] = useState<SortKey>("mrr");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editProductId, setEditProductId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const openCreate = () => {
    setEditProductId(null);
    setFormOpen(true);
  };
  const openEdit = (id: string) => {
    setEditProductId(id);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditProductId(null);
  };

  const productsQuery = useProjectProducts({
    projectId,
    includeInactive: true,
    types: filter.types.length > 0 ? filter.types : undefined,
    stores: filter.stores.length > 0 ? filter.stores : undefined,
    search: searchText.length > 0 ? searchText : undefined,
    limit: 100,
  });

  // Resolve product.accessIds (cuid2 strings) to display chips. Missing
  // entries are filtered out by the mapper, so a stale link just disappears
  // until the catalog refetches.
  const accessQuery = useProjectAccess(projectId);
  const accessById = useMemo(() => {
    const m = new Map<string, AccessChipEntry>();
    for (const r of accessQuery.data?.rows ?? []) {
      m.set(r.id, {
        id: r.id,
        identifier: r.identifier,
        displayName: r.displayName,
      });
    }
    return m;
  }, [accessQuery.data]);

  const products = useMemo<ReadonlyArray<Product>>(() => {
    const pages = productsQuery.data?.pages ?? [];
    return pages.flatMap((page) =>
      page.products.map((row) => rowToUiProduct(row, { accessById })),
    );
  }, [productsQuery.data, accessById]);

  const groupList = useMemo<ReadonlyArray<string>>(() => {
    const set = new Set<string>();
    for (const p of products) set.add(p.group);
    return ["All", ...Array.from(set).sort()];
  }, [products]);

  const groupCounts = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = { All: products.length };
    for (const g of groupList.slice(1)) {
      m[g] = products.filter((p) => p.group === g).length;
    }
    return m;
  }, [products, groupList]);

  // Reset the sidebar group selection if the active label disappears
  // after a refetch (e.g. last product in that group was archived).
  useEffect(() => {
    if (group !== "All" && !groupList.includes(group)) setGroup("All");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, groupList]);

  const filtered = useMemo<ReadonlyArray<Product>>(() => {
    const q = searchText.trim().toLowerCase();
    const list = products.filter((p) => {
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
  }, [products, group, status, searchText, sortKey, sortDir]);

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
    updateSearch({
      group: undefined,
      status: "all",
      q: undefined,
      type: undefined,
      store: undefined,
    });
  };

  const totalMrr = products.reduce((s, p) => s + p.mrr, 0);
  const totalSubs = products.reduce((s, p) => s + (p.subs ?? 0), 0);
  const activeCount = products.filter((p) => p.status === "active").length;
  const draftCount = products.filter((p) => p.status === "draft").length;
  const archivedCount = products.length - activeCount - draftCount;
  const entitlementCount = useMemo(() => {
    const s = new Set<string>();
    for (const p of products) for (const a of p.access) s.add(a.id);
    return s.size;
  }, [products]);

  const drawerProduct = useMemo<Product | null>(
    () => products.find((p) => p.id === drawerId) ?? null,
    [products, drawerId],
  );

  const searchAreaRef = useRef<HTMLDivElement>(null);
  // Keyboard shortcuts. `/` focuses search (existing behavior); `c p` opens
  // the create modal — both are skipped while the user is typing in an input
  // or while a modal is already open so we don't steal keystrokes.
  useEffect(() => {
    let lastC = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          (target as HTMLElement).isContentEditable);
      if (formOpen || importOpen) return;

      if (e.key === "/" && !inEditable) {
        const input = searchAreaRef.current?.querySelector<HTMLInputElement>(
          "input[type='text'], input:not([type])",
        );
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
        return;
      }

      if (inEditable) return;
      const now = Date.now();
      if (e.key.toLowerCase() === "c") {
        lastC = now;
        return;
      }
      if (e.key.toLowerCase() === "p" && now - lastC < 800) {
        e.preventDefault();
        openCreate();
        lastC = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, importOpen]);

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
          <Button variant="flat" size="sm" onClick={() => setImportOpen(true)}>
            <Layers size={13} />
            {t("products.actions.importFromStore")}
          </Button>
          <Button variant="flat" size="sm">
            <Terminal size={13} />
            {t("products.actions.sdkSnippet")}
          </Button>
          <Button variant="solid-primary" size="sm" onClick={openCreate}>
            <Plus size={13} />
            {t("products.actions.create")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("products.stats.total")}
          value={products.length}
          description={t("products.stats.totalBreakdown", {
            active: activeCount,
            draft: draftCount,
            archived: archivedCount,
          })}
        />
        <StatCard
          label={t("products.stats.combinedMrr")}
          value={`$${totalMrr.toLocaleString()}`}
        />
        <StatCard
          label={t("products.stats.activeSubs")}
          value={totalSubs.toLocaleString()}
          description={t("products.stats.acrossProducts", { count: activeCount })}
        />
        <StatCard
          label={t("products.stats.entitlements")}
          value={entitlementCount}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
        <GroupSidebar
          sectionLabels={{
            groups: t("products.groups.heading"),
            status: t("products.status.heading"),
          }}
          groups={groupList}
          groupCounts={groupCounts}
          selectedGroup={group}
          onSelectGroup={setGroup}
          selectedStatus={status}
          onSelectStatus={setStatus}
        />

        <div className="min-w-0">
          <div ref={searchAreaRef}>
            <ProductsToolbar
              search={searchText}
              onSearchChange={setSearchText}
              visible={filtered.length}
              total={products.length}
              filter={filter}
              onFilterChange={setFilter}
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

      <ProductDrawer
        projectId={projectId}
        product={drawerProduct}
        onClose={() => setDrawerId(null)}
        onEdit={openEdit}
      />

      <ProductFormModal
        projectId={projectId}
        open={formOpen}
        editProductId={editProductId}
        onClose={closeForm}
        onSaved={(id) => {
          // Surface the just-saved product in the drawer so the user sees
          // their change reflected without hunting through the list.
          setDrawerId(id);
        }}
      />

      <ImportFromStoreModal
        projectId={projectId}
        open={importOpen}
        onClose={() => setImportOpen(false)}
      />
    </>
  );
}
