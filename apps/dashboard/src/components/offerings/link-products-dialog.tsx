import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { DashboardProductRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import { useUpdateOffering } from "../../lib/hooks/useProjectOfferings";
import { ApiError } from "../../lib/api";
import {
  STANDARD_IDS,
  CUSTOM_ID_RE,
  MAX_PACKAGE_IDENTIFIER_LENGTH,
} from "./package-identifier-constants";
import type { Offering } from "./types";

type Props = {
  projectId: string;
  offering: Offering | null;
  /** All project products, already loaded by the parent route. */
  allProducts: ReadonlyArray<DashboardProductRow>;
  open: boolean;
  onClose: () => void;
};

export function LinkProductsDialog({
  projectId,
  offering,
  allProducts,
  open,
  onClose,
}: Props) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {open && offering && (
            <Body
              projectId={projectId}
              offering={offering}
              allProducts={allProducts}
              onClose={onClose}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Per-product package identifier state tracked during link flow.
type PkgIdState = {
  // "standard" = one of STANDARD_IDS; "custom" = custom text input
  mode: "standard" | "custom";
  // The select value: one of STANDARD_IDS or the sentinel "custom"
  selectValue: string;
  // Text in the custom input (only relevant when mode === "custom")
  customValue: string;
  // Validation error for the custom slug
  customError: string | null;
};

function defaultPkgIdState(): PkgIdState {
  return {
    mode: "standard",
    selectValue: STANDARD_IDS[1], // $rov_monthly as a sensible default
    customValue: "",
    customError: null,
  };
}

function resolvedIdentifier(s: PkgIdState): string | null {
  if (s.mode === "standard") return s.selectValue;
  const v = s.customValue.trim();
  if (!v || s.customError || !CUSTOM_ID_RE.test(v) || v.length > MAX_PACKAGE_IDENTIFIER_LENGTH) return null;
  return v;
}

function Body({
  projectId,
  offering,
  allProducts,
  onClose,
}: {
  projectId: string;
  offering: Offering;
  allProducts: ReadonlyArray<DashboardProductRow>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateOffering(projectId, offering.id);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Per-product package identifier picker state
  const [pkgIds, setPkgIds] = useState<Map<string, PkgIdState>>(() => new Map());
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset selection whenever the picker opens against a different offering.
  useEffect(() => {
    setSelectedIds(new Set());
    setPkgIds(new Map());
    setSearch("");
    setSubmitError(null);
  }, [offering.id]);

  const memberIds = useMemo(() => {
    const s = new Set<string>();
    for (const pkg of offering.packages) s.add(pkg.productId);
    return s;
  }, [offering.packages]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allProducts.filter((row) => {
      if (memberIds.has(row.id)) return false;
      if (!row.isActive) return false;
      if (!q) return true;
      return (
        row.identifier.toLowerCase().includes(q) ||
        row.displayName.toLowerCase().includes(q)
      );
    });
  }, [allProducts, memberIds, search]);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Clean up identifier state when unchecked
        setPkgIds((m) => {
          const nm = new Map(m);
          nm.delete(id);
          return nm;
        });
      } else {
        next.add(id);
        // Initialize identifier picker state for this product
        setPkgIds((m) => {
          const nm = new Map(m);
          if (!nm.has(id)) nm.set(id, defaultPkgIdState());
          return nm;
        });
      }
      return next;
    });
  };

  const updatePkgId = (productId: string, patch: Partial<PkgIdState>) => {
    setPkgIds((m) => {
      const nm = new Map(m);
      const prev = nm.get(productId) ?? defaultPkgIdState();
      nm.set(productId, { ...prev, ...patch });
      return nm;
    });
  };

  // All selected products have a valid resolved identifier
  const allIdentifiersValid = useMemo(() => {
    for (const id of selectedIds) {
      const state = pkgIds.get(id) ?? defaultPkgIdState();
      if (resolvedIdentifier(state) === null) return false;
    }
    return true;
  }, [selectedIds, pkgIds]);

  const onSubmit = async () => {
    if (selectedIds.size === 0 || !allIdentifiersValid) return;
    setSubmitError(null);
    const existing = offering.packages.map((pkg, index) => ({
      identifier: pkg.identifier,
      productId: pkg.productId,
      order: index,
      isPromoted: pkg.isPromoted,
    }));
    const toAdd = Array.from(selectedIds).map((productId, index) => {
      const state = pkgIds.get(productId) ?? defaultPkgIdState();
      return {
        identifier: resolvedIdentifier(state)!,
        productId,
        order: existing.length + index,
        isPromoted: false,
      };
    });
    try {
      await update.mutateAsync({
        packages: [...existing, ...toAdd],
      });
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : t(
              "offerings.linkProducts.errors.generic",
              "Could not link the selected products. Please try again.",
            ),
      );
    }
  };

  return (
    <>
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">
            {t("offerings.linkProducts.title", "Link products")}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("offerings.linkProducts.subtitle", {
              defaultValue: "Add products to {{name}}. Choose a package identifier for each.",
              name: offering.name,
            })}
          </Dialog.Description>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close", "Close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </header>

      <div className="border-b border-rv-divider px-5 py-2.5">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t(
            "offerings.linkProducts.search",
            "Search products…",
          )}
          size="sm"
        />
      </div>

      <div className="min-h-[200px] flex-1 overflow-y-auto">
        {candidates.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center px-6 py-10 text-center">
            <div className="text-[13px] font-semibold">
              {memberIds.size === allProducts.length
                ? t(
                    "offerings.linkProducts.empty.allLinked",
                    "All products are already in this offering",
                  )
                : t(
                    "offerings.linkProducts.empty.none",
                    "No products match",
                  )}
            </div>
            <p className="mt-1 max-w-[320px] text-[12px] text-rv-mute-500">
              {t(
                "offerings.linkProducts.empty.hint",
                "Inactive products are hidden. Create a product in the catalog first.",
              )}
            </p>
          </div>
        ) : (
          <ul>
            {candidates.map((row) => {
              const checked = selectedIds.has(row.id);
              const pkgState = pkgIds.get(row.id);
              return (
                <li key={row.id} className="border-b border-rv-divider last:border-0">
                  <div
                    className={cn(
                      "flex items-center gap-3 px-5 py-2.5 transition hover:bg-rv-c2",
                      checked && "bg-rv-accent-500/5",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(row.id)}
                      className="flex flex-1 cursor-pointer items-center gap-3 text-left"
                    >
                      <Checkbox
                        checked={checked}
                        onChange={() => toggle(row.id)}
                        ariaLabel={row.displayName || row.identifier}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-foreground">
                          {row.displayName || row.identifier}
                        </div>
                        <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
                          {row.identifier}
                        </div>
                      </div>
                    </button>
                    <ProductTypeChip type={row.type} />
                  </div>
                  {/* Package identifier picker — visible only when this product is checked */}
                  {checked && pkgState && (
                    <PackageIdentifierPicker
                      state={pkgState}
                      onChange={(patch) => updatePkgId(row.id, patch)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {submitError && (
        <div className="border-t border-rv-divider px-5 py-2 text-[12px] text-rv-danger">
          {submitError}
        </div>
      )}

      <footer className="flex items-center justify-between gap-2 border-t border-rv-divider px-5 py-3">
        <div className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("offerings.linkProducts.counter", {
            defaultValue: "{{count}} selected",
            count: selectedIds.size,
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="flat"
            size="sm"
            onClick={onClose}
            disabled={update.isPending}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            type="button"
            variant="solid-primary"
            size="sm"
            onClick={onSubmit}
            disabled={selectedIds.size === 0 || !allIdentifiersValid || update.isPending}
          >
            {update.isPending
              ? t("offerings.linkProducts.submitting", "Linking…")
              : t("offerings.linkProducts.submit", "Link selected")}
          </Button>
        </div>
      </footer>
    </>
  );
}

// ─── PackageIdentifierPicker ──────────────────────────────────────────────────
// Inline picker rendered under a checked product row. Lets the user choose a
// standard $rov_* identifier or enter a custom slug before submitting.
// ─────────────────────────────────────────────────────────────────────────────

function PackageIdentifierPicker({
  state,
  onChange,
}: {
  state: PkgIdState;
  onChange: (patch: Partial<PkgIdState>) => void;
}) {
  const { t } = useTranslation();
  const customInputRef = useRef<HTMLInputElement>(null);
  const customInputId = useId();

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === "custom") {
      onChange({ mode: "custom", selectValue: "custom", customValue: "", customError: null });
      setTimeout(() => customInputRef.current?.focus(), 0);
    } else {
      onChange({ mode: "standard", selectValue: val, customValue: "", customError: null });
    }
  };

  const handleCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    let customError: string | null = null;
    if (val.length > MAX_PACKAGE_IDENTIFIER_LENGTH) {
      customError = t(
        "offerings.linkProducts.identifier.tooLong",
        "Max 160 characters",
      );
    } else if (val.length > 0 && !CUSTOM_ID_RE.test(val)) {
      customError = t(
        "offerings.linkProducts.identifier.invalidSlug",
        "Lowercase letters, digits, hyphens, underscores only",
      );
    }
    onChange({ customValue: val, customError });
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-rv-divider/50 bg-rv-c2/40 px-5 py-2.5">
      <label
        htmlFor={`${customInputId}-select`}
        className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500"
      >
        {t("offerings.linkProducts.identifier.label", "Package identifier")}
      </label>
      <Select
        id={`${customInputId}-select`}
        value={state.selectValue}
        onChange={handleSelectChange}
        aria-label={t("offerings.linkProducts.identifier.label", "Package identifier")}
      >
        {STANDARD_IDS.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
        <option value="custom">
          {t("offerings.linkProducts.identifier.customOption", "Custom…")}
        </option>
      </Select>
      {state.mode === "custom" && (
        <Input
          ref={customInputRef}
          id={customInputId}
          mono
          value={state.customValue}
          onChange={handleCustomChange}
          placeholder={t(
            "offerings.linkProducts.identifier.customPlaceholder",
            "e.g. pro_monthly",
          )}
          maxLength={MAX_PACKAGE_IDENTIFIER_LENGTH}
          aria-label={t(
            "offerings.linkProducts.identifier.customLabel",
            "Custom identifier slug",
          )}
          className={cn(
            state.customError && "border-rv-danger focus:ring-rv-danger/30",
          )}
        />
      )}
      {state.customError && (
        <p className="text-[11px] text-rv-danger">{state.customError}</p>
      )}
      {!state.customError && state.mode === "custom" && !state.customValue.trim() && (
        <p className="text-[11px] text-rv-mute-500">
          {t(
            "offerings.linkProducts.identifier.customRequired",
            "Enter a custom slug to continue.",
          )}
        </p>
      )}
    </div>
  );
}

function ProductTypeChip({ type }: { type: DashboardProductRow["type"] }) {
  const { t } = useTranslation();
  const label =
    type === "SUBSCRIPTION"
      ? t("offerings.linkProducts.type.subscription", "Subscription")
      : type === "CONSUMABLE"
        ? t("offerings.linkProducts.type.consumable", "Consumable")
        : t("offerings.linkProducts.type.nonConsumable", "Lifetime");
  return (
    <span className="shrink-0 rounded-full border border-rv-divider bg-rv-c2 px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
      {label}
    </span>
  );
}
