import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Package, Plus, Star, StarOff } from "lucide-react";
import type { DashboardProductRow } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { Input } from "../../../../ui/input";
import { Select } from "../../../../ui/select";
import { cn } from "../../../../lib/cn";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectOfferings, useUpdateOffering } from "../../../../lib/hooks/useProjectOfferings";
import { useProjectProducts } from "../../../../lib/hooks/useProjectProducts";
import { useProjectAccess } from "../../../../lib/hooks/useProjectAccess";
import { rowToUiOffering } from "../../../../lib/dashboard-mappers";
import {
  DeleteOfferingDialog,
  LinkProductsDialog,
  OfferingFormDialog,
  OfferingHeader,
  OfferingIcon,
  OfferingList,
  OfferingProductsSection,
  type Offering,
} from "../../../../components/offerings";

interface Search {
  offeringId?: string;
}

export const Route = createFileRoute("/_authed/projects/$projectId/offerings")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    offeringId:
      typeof s.offeringId === "string" ? s.offeringId : undefined,
  }),
  component: OfferingsRoute,
});

function OfferingsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/offerings",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <OfferingsPage projectId={projectId} />;
}

function OfferingsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = Route.useNavigate();
  const { offeringId: selectedId } = Route.useSearch();

  // ─── data ──────────────────────────────────────────────────────────────────
  const offeringsQuery = useProjectOfferings(projectId);
  const rawOfferings = offeringsQuery.data?.offerings ?? [];

  // Flat list of all products for mapper + LinkProductsDialog
  const productsQuery = useProjectProducts({ projectId, includeInactive: true, limit: 100 });
  const allProductRows = useMemo<ReadonlyArray<DashboardProductRow>>(() => {
    const pages = productsQuery.data?.pages ?? [];
    return pages.flatMap((p) => p.products);
  }, [productsQuery.data]);

  const productById = useMemo<ReadonlyMap<string, DashboardProductRow>>(() => {
    const m = new Map<string, DashboardProductRow>();
    for (const r of allProductRows) m.set(r.id, r);
    return m;
  }, [allProductRows]);

  // Access data for the "Access levels granted" detail pane
  const accessQuery = useProjectAccess(projectId);
  const accessById = useMemo(() => {
    const m = new Map<string, { id: string; identifier: string; displayName: string }>();
    for (const r of accessQuery.data?.rows ?? []) {
      m.set(r.id, { id: r.id, identifier: r.identifier, displayName: r.displayName });
    }
    return m;
  }, [accessQuery.data]);

  // Map raw rows to UI offerings
  const offerings = useMemo<ReadonlyArray<Offering>>(
    () => rawOfferings.map((row) => rowToUiOffering(row, productById)),
    [rawOfferings, productById],
  );

  // ─── selection ─────────────────────────────────────────────────────────────
  const selected = useMemo(
    () => offerings.find((o) => o.id === selectedId) ?? null,
    [offerings, selectedId],
  );

  function select(id: string | null) {
    void navigate({
      search: (): Search =>
        id ? { offeringId: id } : { offeringId: undefined },
    });
  }

  // Auto-select first offering when none is selected and data arrives
  useEffect(() => {
    if (!selectedId && offerings.length > 0) {
      select(offerings[0].id);
    }
    // `select` is stable (uses navigate which is stable); include only primitives to avoid loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerings.length, selectedId]);

  // ─── local UI state ────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  // ─── filtered list ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return offerings;
    return offerings.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.key.toLowerCase().includes(q),
    );
  }, [offerings, search]);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("offerings.title", "Offerings")}
          </h1>
          <p className="mt-0.5 max-w-[640px] text-[13px] text-rv-mute-500">
            {t(
              "offerings.subtitle",
              "Bundles of products you show on a paywall, scoped to one access.",
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("offerings.actions.guide", "Offerings guide")}
          </Button>
          <Button
            variant="solid-primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={13} />
            {t("offerings.actions.newGroup", "New offering")}
          </Button>
        </div>
      </header>

      {/* Empty state when no offerings exist */}
      {offerings.length === 0 && !offeringsQuery.isPending ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:gap-5 max-xl:lg:grid-cols-[260px_minmax(0,1fr)]">
          {/* ─── Left rail: offering list ─────────────────────────────────── */}
          <OfferingList
            offerings={filtered}
            selectedId={selected?.id ?? ""}
            onSelect={select}
            search={search}
            onSearchChange={setSearch}
          />

          {/* ─── Right pane: offering detail ──────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-4">
            {selected ? (
              <>
                <OfferingHeader
                  projectId={projectId}
                  offering={selected}
                  onLinkProduct={() => setLinkOpen(true)}
                  onEdit={() => setEditOpen(true)}
                  onDelete={() => setDeleteOpen(true)}
                />

                {/* Packages detail section */}
                <PackagesSection
                  projectId={projectId}
                  offering={selected}
                  productById={productById}
                  accessById={accessById}
                  onLinkProduct={() => setLinkOpen(true)}
                />

                {/* Products section (backwards-compat section for product mgmt) */}
                <OfferingProductsSection
                  projectId={projectId}
                  offering={selected}
                  onLinkProduct={() => setLinkOpen(true)}
                />
              </>
            ) : (
              <div className="flex items-center justify-center rounded-lg border border-rv-divider bg-rv-c1 py-16 text-[13px] text-rv-mute-500">
                {t("offerings.selectPrompt", "Select an offering to view its details.")}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Dialogs ────────────────────────────────────────────────────────── */}
      <OfferingFormDialog
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
        <OfferingFormDialog
          mode="edit"
          projectId={projectId}
          open={editOpen}
          offering={selected}
          onClose={() => setEditOpen(false)}
        />
      )}

      <DeleteOfferingDialog
        projectId={projectId}
        offering={selected}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => select(null)}
      />

      <LinkProductsDialog
        projectId={projectId}
        offering={selected}
        allProducts={allProductRows as DashboardProductRow[]}
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
      />
    </>
  );
}

// ─── PackagesSection ───────────────────────────────────────────────────────────
// Detail pane that shows each package's identifier, bound product, order, and
// isPromoted flag, plus a read-only list of access levels the offering unlocks.
// ──────────────────────────────────────────────────────────────────────────────

function PackagesSection({
  projectId,
  offering,
  productById,
  accessById,
  onLinkProduct,
}: {
  projectId: string;
  offering: Offering;
  productById: ReadonlyMap<string, DashboardProductRow>;
  accessById: ReadonlyMap<string, { id: string; identifier: string; displayName: string }>;
  onLinkProduct: () => void;
}) {
  const { t } = useTranslation();

  // Collect the union of access IDs across all package products
  const accessEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: Array<{ id: string; identifier: string; displayName: string }> = [];
    for (const pkg of offering.packages) {
      const row = productById.get(pkg.productId);
      if (!row) continue;
      for (const aid of row.accessIds) {
        if (seen.has(aid)) continue;
        seen.add(aid);
        const a = accessById.get(aid);
        if (a) entries.push(a);
      }
    }
    return entries;
  }, [offering.packages, productById, accessById]);

  // Mutation for toggling the default flag
  const update = useUpdateOffering(projectId, offering.id);
  const toggleDefault = () => {
    if (update.isPending) return;
    update.mutate({ isDefault: !offering.isDefault });
  };

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      {/* Header with "Set as current" toggle */}
      <header className="flex items-center justify-between gap-4 border-b border-rv-divider px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold">
            {t("offerings.packages.heading", "Packages")}
          </h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t(
              "offerings.packages.subtitle",
              "SDK package identifiers and their bound products.",
            )}
          </p>
        </div>
        <Button
          variant={offering.isDefault ? "light" : "flat"}
          size="sm"
          onClick={toggleDefault}
          disabled={update.isPending}
          title={
            offering.isDefault
              ? t("offerings.packages.unsetDefault", "Remove as default offering")
              : t("offerings.packages.setDefault", "Set as default offering")
          }
        >
          {offering.isDefault ? (
            <StarOff size={13} className="text-rv-accent-500" />
          ) : (
            <Star size={13} />
          )}
          {offering.isDefault
            ? t("offerings.packages.unsetDefault", "Remove as default")
            : t("offerings.packages.setDefault", "Set as current")}
        </Button>
      </header>

      {/* Package rows */}
      {offering.packages.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <div className="flex size-9 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
            <Package size={16} />
          </div>
          <p className="text-[13px] text-rv-mute-500">
            {t("offerings.packages.empty", "No packages yet. Link a product to create one.")}
          </p>
          <Button variant="flat" size="sm" onClick={onLinkProduct}>
            <Plus size={13} />
            {t("offerings.products.link", "Link product")}
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_60px_80px] gap-3 px-5 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            <div>{t("offerings.packages.col.identifier", "Identifier")}</div>
            <div>{t("offerings.packages.col.product", "Product")}</div>
            <div className="text-center">{t("offerings.packages.col.order", "Order")}</div>
            <div className="text-center">{t("offerings.packages.col.promoted", "Promoted")}</div>
          </div>
          <ul>
            {offering.packages.map((pkg) => (
              <PackageRow
                key={pkg.productId}
                pkg={pkg}
                offering={offering}
                update={update}
              />
            ))}
          </ul>
        </>
      )}

      {/* Access levels granted — derived from package product accessIds */}
      {accessEntries.length > 0 && (
        <div className="border-t border-rv-divider px-5 py-4">
          <h4 className="mb-2 text-[12px] font-semibold text-rv-mute-700">
            {t("offerings.packages.accessHeading", "Access levels granted")}
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {accessEntries.map((a) => (
              <li key={a.id}>
                <span className="inline-flex items-center rounded-full border border-rv-accent-500/30 bg-rv-accent-500/10 px-2 py-0.5 font-rv-mono text-[11px] text-rv-accent-400">
                  {a.displayName || a.identifier}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// Standard RevenueCat-style package slot identifiers
const RC_STANDARD_IDS = [
  "$rov_weekly",
  "$rov_monthly",
  "$rov_annual",
  "$rov_lifetime",
] as const;

// A slug is valid if it is one of the standard $rov_* ids or matches the custom pattern
const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_IDENTIFIER_LENGTH = 160;

function isStandardId(id: string): id is (typeof RC_STANDARD_IDS)[number] {
  return (RC_STANDARD_IDS as readonly string[]).includes(id);
}

function PackageRow({
  pkg,
  offering,
  update,
}: {
  pkg: Offering["packages"][number];
  offering: Offering;
  update: ReturnType<typeof useUpdateOffering>;
}) {
  const { t } = useTranslation();
  const { identifier, productName, productSku, order, isPromoted } = pkg;

  // Determine initial mode: standard or custom
  const initIsStandard = isStandardId(identifier);
  const [mode, setMode] = useState<"standard" | "custom">(
    initIsStandard ? "standard" : "custom",
  );
  // For the select value when mode=standard, or the sentinel "custom" option
  const [selectValue, setSelectValue] = useState<string>(
    initIsStandard ? identifier : "custom",
  );
  // The actual custom slug text
  const [customValue, setCustomValue] = useState(
    initIsStandard ? "" : identifier,
  );
  const [customError, setCustomError] = useState<string | null>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  // Keep local state in sync when the offering's package identifier changes externally
  const prevIdentifier = useRef(identifier);
  useEffect(() => {
    if (prevIdentifier.current === identifier) return;
    prevIdentifier.current = identifier;
    const std = isStandardId(identifier);
    setMode(std ? "standard" : "custom");
    setSelectValue(std ? identifier : "custom");
    setCustomValue(std ? "" : identifier);
    setCustomError(null);
  }, [identifier]);

  const buildNewPackages = (newIdentifier: string) =>
    offering.packages.map((p) =>
      p.productId === pkg.productId ? { ...p, identifier: newIdentifier } : p,
    ).map((p, i) => ({
      identifier: p.identifier,
      productId: p.productId,
      order: i,
      isPromoted: p.isPromoted,
      metadata: p.metadata,
    }));

  const persistIdentifier = (newId: string) => {
    if (newId === identifier) return; // no-op
    update.mutate({ packages: buildNewPackages(newId) });
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectValue(val);
    if (val === "custom") {
      setMode("custom");
      // Focus the custom input on next tick
      setTimeout(() => customInputRef.current?.focus(), 0);
    } else {
      setMode("standard");
      setCustomValue("");
      setCustomError(null);
      persistIdentifier(val);
    }
  };

  const handleCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomValue(val);
    // Validate live
    if (val.length > MAX_IDENTIFIER_LENGTH) {
      setCustomError(
        t("offerings.packages.identifier.tooLong", "Max 160 characters"),
      );
    } else if (val.length > 0 && !CUSTOM_ID_RE.test(val)) {
      setCustomError(
        t(
          "offerings.packages.identifier.invalidSlug",
          "Lowercase letters, digits, hyphens, underscores only",
        ),
      );
    } else {
      setCustomError(null);
    }
  };

  const handleCustomBlur = () => {
    const trimmed = customValue.trim();
    if (!trimmed) {
      // Revert to previous identifier
      const prevIsStd = isStandardId(identifier);
      setMode(prevIsStd ? "standard" : "custom");
      setSelectValue(prevIsStd ? identifier : "custom");
      setCustomValue(prevIsStd ? "" : identifier);
      setCustomError(null);
      return;
    }
    // Synchronous re-validation: customError state may be stale if the user
    // types an invalid character and immediately blurs before React re-renders.
    if (trimmed.length > MAX_IDENTIFIER_LENGTH || !CUSTOM_ID_RE.test(trimmed)) return;
    persistIdentifier(trimmed);
  };

  const handleCustomKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      // Revert
      const prevIsStd = isStandardId(identifier);
      setMode(prevIsStd ? "standard" : "custom");
      setSelectValue(prevIsStd ? identifier : "custom");
      setCustomValue(prevIsStd ? "" : identifier);
      setCustomError(null);
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_60px_80px] items-start gap-3 border-t border-rv-divider px-5 py-2.5 text-[13px]">
      {/* Identifier editor */}
      <div className="min-w-0 flex flex-col gap-1">
        <Select
          value={selectValue}
          onChange={handleSelectChange}
          disabled={update.isPending}
          aria-label={t("offerings.packages.identifier.label", "Package identifier")}
        >
          {RC_STANDARD_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
          <option value="custom">
            {t("offerings.packages.identifier.customOption", "Custom…")}
          </option>
        </Select>
        {mode === "custom" && (
          <Input
            ref={customInputRef}
            mono
            value={customValue}
            onChange={handleCustomChange}
            onBlur={handleCustomBlur}
            onKeyDown={handleCustomKeyDown}
            placeholder={t(
              "offerings.packages.identifier.customPlaceholder",
              "e.g. pro_monthly",
            )}
            maxLength={MAX_IDENTIFIER_LENGTH}
            disabled={update.isPending}
            aria-label={t(
              "offerings.packages.identifier.customLabel",
              "Custom identifier slug",
            )}
            className={cn(
              customError && "border-rv-danger focus:ring-rv-danger/30",
            )}
          />
        )}
        {customError && (
          <p className="text-[11px] text-rv-danger">{customError}</p>
        )}
      </div>

      {/* Bound product */}
      <div className="min-w-0 pt-1.5">
        {productName ? (
          <>
            <div className="truncate text-[13px] font-medium text-foreground">
              {productName}
            </div>
            {productSku && productSku !== productName && (
              <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
                {productSku}
              </div>
            )}
          </>
        ) : (
          <span className="text-[12px] text-rv-mute-500">
            {t("offerings.packages.unknownProduct", "Unknown product")}
          </span>
        )}
      </div>

      {/* Order */}
      <div className="pt-2 text-center font-rv-mono text-[12px] text-rv-mute-600">
        {order}
      </div>

      {/* isPromoted */}
      <div className="flex justify-center pt-1.5">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider",
            isPromoted
              ? "border border-rv-success/30 bg-rv-success/10 text-rv-success"
              : "border border-rv-divider text-rv-mute-500",
          )}
        >
          {isPromoted
            ? t("offerings.packages.promoted", "Yes")
            : t("offerings.packages.notPromoted", "No")}
        </span>
      </div>
    </li>
  );
}

// ─── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-rv-divider bg-rv-c1 px-6 py-20 text-center">
      <OfferingIcon initials="of" tint="linear-gradient(135deg,#8B5CF6 0%,#6366F1 100%)" size="lg" />
      <div>
        <div className="text-[16px] font-semibold">
          {t("offerings.empty.title", "No offerings yet")}
        </div>
        <p className="mt-1 max-w-[400px] text-[13px] text-rv-mute-500">
          {t(
            "offerings.empty.body",
            "Create an offering to surface SKUs on a paywall scoped to an access right.",
          )}
        </p>
      </div>
      <Button variant="solid-primary" size="sm" onClick={onCreate}>
        <Plus size={13} />
        {t("offerings.empty.cta", "New offering")}
      </Button>
    </div>
  );
}
