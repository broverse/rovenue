import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { Popover } from "@base-ui-components/react/popover";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import type {
  DashboardProductCreateInput,
  DashboardProductGroupRow,
  DashboardProductRow,
  DashboardProductUpdateInput,
  ProductGroupMembership,
  ProductTypeName,
} from "@rovenue/shared";
import { Button, buttonVariants } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { cn } from "../../lib/cn";
import {
  useCreateProduct,
  useProductById,
  useUpdateProduct,
} from "../../lib/hooks/useProjectProducts";
import {
  useProjectOfferings,
  useUpdateOffering,
} from "../../lib/hooks/useProjectOfferings";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** When set, the modal opens in edit mode and hydrates from the row. */
  editProductId?: string | null;
  onSaved?: (id: string) => void;
};

type FormState = {
  identifier: string;
  displayName: string;
  type: ProductTypeName;
  period: "P1W" | "P1M" | "P1Y";
  iosId: string;
  androidId: string;
  webId: string;
  creditAmount: string;
  isActive: boolean;
};

const EMPTY: FormState = {
  identifier: "",
  displayName: "",
  type: "SUBSCRIPTION",
  period: "P1M",
  iosId: "",
  androidId: "",
  webId: "",
  creditAmount: "",
  isActive: true,
};

const SLUG_RE = /^[a-zA-Z0-9._:-]+$/;

function rowToForm(row: DashboardProductRow): FormState {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const period =
    meta.period === "P1W" || meta.period === "P1M" || meta.period === "P1Y"
      ? (meta.period as FormState["period"])
      : "P1M";
  const stores = row.storeIds ?? {};
  return {
    identifier: row.identifier,
    displayName: row.displayName,
    type: row.type,
    period,
    iosId: stores.ios ?? "",
    androidId: stores.android ?? "",
    webId: stores.web ?? "",
    creditAmount: row.creditAmount != null ? String(row.creditAmount) : "",
    isActive: row.isActive,
  };
}

/** Set of group ids that currently include the given product. */
function membershipsFor(
  groups: ReadonlyArray<DashboardProductGroupRow>,
  productId: string | null,
): Set<string> {
  const out = new Set<string>();
  if (!productId) return out;
  for (const g of groups) {
    if (g.products.some((m) => m.productId === productId)) out.add(g.id);
  }
  return out;
}

export function ProductFormModal({
  projectId,
  open,
  onClose,
  editProductId,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const mode: "create" | "edit" = editProductId ? "edit" : "create";

  const create = useCreateProduct(projectId);
  const update = useUpdateProduct(projectId);
  const existing = useProductById(projectId, mode === "edit" ? editProductId! : null);
  const groupsQuery = useProjectOfferings(projectId);
  const updateGroup = useUpdateOffering(projectId);

  const allGroups = useMemo(
    () => groupsQuery.data?.groups ?? [],
    [groupsQuery.data],
  );

  const [form, setForm] = useState<FormState>(EMPTY);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [initialGroupIds, setInitialGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the modal re-opens or the target product changes. In edit
  // mode we wait until both the product row and the group list arrive before
  // hydrating so the checkbox state doesn't flash empty.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === "create") {
      setForm(EMPTY);
      setSelectedGroupIds(new Set());
      setInitialGroupIds(new Set());
    } else if (existing.data?.product && groupsQuery.data) {
      setForm(rowToForm(existing.data.product));
      const current = membershipsFor(allGroups, editProductId ?? null);
      setSelectedGroupIds(current);
      setInitialGroupIds(current);
    }
  }, [
    open,
    mode,
    editProductId,
    existing.data?.product,
    groupsQuery.data,
    allGroups,
  ]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const toggleGroup = (id: string) =>
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const loadingExisting =
    (mode === "edit" && existing.isPending) ||
    (mode === "edit" && groupsQuery.isPending);

  const validation = useMemo(() => {
    if (loadingExisting) return null;
    if (!form.identifier.trim()) return "identifier-required";
    if (!SLUG_RE.test(form.identifier.trim())) return "identifier-invalid";
    if (!form.displayName.trim()) return "name-required";
    if (form.type === "CONSUMABLE") {
      if (form.creditAmount && Number.isNaN(Number(form.creditAmount))) {
        return "credit-invalid";
      }
    }
    if (!form.iosId.trim() && !form.androidId.trim() && !form.webId.trim()) {
      return "store-required";
    }
    return null;
  }, [form, loadingExisting]);

  const submitting =
    create.isPending || update.isPending || updateGroup.isPending;

  /**
   * Apply the form's selected-group set to the project: for each group that
   * gained the product, PATCH with the product appended; for each that lost
   * it, PATCH with the product removed. Runs sequentially so the React Query
   * cache stays consistent — `useUpdateOffering` invalidates per call,
   * but our `allGroups` snapshot already encodes what needs to change so we
   * don't need to re-read between calls.
   */
  const syncGroupMemberships = async (productId: string) => {
    const wantedIn = selectedGroupIds;
    const wasIn =
      mode === "edit"
        ? initialGroupIds
        : new Set<string>(); // brand-new products start with no memberships

    for (const g of allGroups) {
      const want = wantedIn.has(g.id);
      const have = wasIn.has(g.id);
      if (want === have) continue;

      if (want) {
        const nextOrder =
          g.products.length === 0
            ? 0
            : Math.max(...g.products.map((m) => m.order ?? 0)) + 1;
        const products: ProductGroupMembership[] = [
          ...g.products,
          { productId, order: nextOrder, isPromoted: false },
        ];
        await updateGroup.mutateAsync({ id: g.id, products });
      } else {
        const products = g.products.filter((m) => m.productId !== productId);
        await updateGroup.mutateAsync({ id: g.id, products });
      }
    }
  };

  const submit = async () => {
    if (validation || submitting || loadingExisting) return;
    setError(null);

    const storeIds: Record<string, string> = {};
    if (form.iosId.trim()) storeIds.ios = form.iosId.trim();
    if (form.androidId.trim()) storeIds.android = form.androidId.trim();
    if (form.webId.trim()) storeIds.web = form.webId.trim();

    // Preserve any non-period metadata when editing so we don't clobber it.
    const baseMeta =
      mode === "edit" && existing.data?.product?.metadata
        ? { ...(existing.data.product.metadata as Record<string, unknown>) }
        : {};
    if (form.type === "SUBSCRIPTION") {
      baseMeta.period = form.period;
    } else {
      delete baseMeta.period;
    }

    const creditAmount =
      form.type === "CONSUMABLE" && form.creditAmount.trim() !== ""
        ? Number(form.creditAmount)
        : null;

    try {
      let savedId: string;
      if (mode === "create") {
        const body: DashboardProductCreateInput = {
          identifier: form.identifier.trim(),
          displayName: form.displayName.trim(),
          type: form.type,
          storeIds,
          // Entitlements are now expressed via product groups. Keep the field
          // empty so the existing schema stays satisfied.
          entitlementKeys: [],
          creditAmount,
          isActive: form.isActive,
          metadata: baseMeta,
        };
        const res = await create.mutateAsync(body);
        savedId = res.product.id;
      } else {
        const patch: DashboardProductUpdateInput = {
          identifier: form.identifier.trim(),
          displayName: form.displayName.trim(),
          type: form.type,
          storeIds,
          // Preserve any previously-set entitlement keys verbatim — the form
          // no longer exposes them, but we shouldn't silently clear data the
          // user (or an SDK consumer) may still rely on.
          entitlementKeys: existing.data?.product?.entitlementKeys ?? [],
          creditAmount,
          isActive: form.isActive,
          metadata: baseMeta,
        };
        const res = await update.mutateAsync({ id: editProductId!, ...patch });
        savedId = res.product.id;
      }

      await syncGroupMemberships(savedId);
      onSaved?.(savedId);
      onClose();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : t("products.form.errors.unknown");
      setError(msg);
    }
  };

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
            "fixed left-1/2 top-1/2 z-50 flex w-[560px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {mode === "edit"
                  ? t("products.form.editTitle")
                  : t("products.form.createTitle")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {mode === "edit"
                  ? t("products.form.editSubtitle")
                  : t("products.form.createSubtitle")}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loadingExisting ? (
              <div className="py-10 text-center text-[12px] text-rv-mute-500">
                {t("common.loading")}
              </div>
            ) : (
              <FormBody
                form={form}
                set={set}
                groups={allGroups}
                selectedGroupIds={selectedGroupIds}
                onToggleGroup={toggleGroup}
                lockIdentifier={mode === "edit"}
              />
            )}
          </div>

          <footer className="flex items-center justify-between border-t border-rv-divider bg-rv-c1 px-5 py-3">
            <span className="text-[12px] text-rv-danger" role="alert">
              {error ??
                (validation
                  ? t(`products.form.errors.${validation}`)
                  : "")}
            </span>
            <div className="flex gap-2">
              <Button variant="flat" size="sm" onClick={onClose} type="button">
                {t("common.cancel")}
              </Button>
              <Button
                variant="solid-primary"
                size="sm"
                onClick={submit}
                disabled={validation !== null || submitting || loadingExisting}
                type="button"
              >
                {submitting
                  ? t("products.form.submitting")
                  : mode === "edit"
                    ? t("products.form.editSubmit")
                    : t("products.form.createSubmit")}
              </Button>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FormBody({
  form,
  set,
  groups,
  selectedGroupIds,
  onToggleGroup,
  lockIdentifier,
}: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  groups: ReadonlyArray<DashboardProductGroupRow>;
  selectedGroupIds: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  lockIdentifier: boolean;
}) {
  const { t } = useTranslation();
  const idIdentifier = useId();
  const idName = useId();
  const idType = useId();
  const idPeriod = useId();
  const idCredit = useId();

  return (
    <div className="grid grid-cols-1 gap-4">
      <Field
        label={t("products.form.fields.identifier")}
        htmlFor={idIdentifier}
        hint={
          lockIdentifier
            ? t("products.form.fields.identifierLockedHint")
            : t("products.form.fields.identifierHint")
        }
      >
        <Input
          id={idIdentifier}
          mono
          value={form.identifier}
          onChange={(e) => set("identifier", e.target.value)}
          placeholder="pro_monthly"
          autoFocus={!lockIdentifier}
          disabled={lockIdentifier}
        />
      </Field>

      <Field label={t("products.form.fields.displayName")} htmlFor={idName}>
        <Input
          id={idName}
          value={form.displayName}
          onChange={(e) => set("displayName", e.target.value)}
          placeholder={t("products.form.fields.displayNamePlaceholder")}
          autoFocus={lockIdentifier}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("products.form.fields.type")} htmlFor={idType}>
          <Select
            id={idType}
            value={form.type}
            onChange={(e) => set("type", e.target.value as FormState["type"])}
          >
            <option value="SUBSCRIPTION">{t("products.form.types.subscription")}</option>
            <option value="CONSUMABLE">{t("products.form.types.consumable")}</option>
            <option value="NON_CONSUMABLE">{t("products.form.types.nonConsumable")}</option>
          </Select>
        </Field>

        {form.type === "SUBSCRIPTION" ? (
          <Field label={t("products.form.fields.period")} htmlFor={idPeriod}>
            <Select
              id={idPeriod}
              value={form.period}
              onChange={(e) => set("period", e.target.value as FormState["period"])}
            >
              <option value="P1W">{t("products.form.periods.weekly")}</option>
              <option value="P1M">{t("products.form.periods.monthly")}</option>
              <option value="P1Y">{t("products.form.periods.yearly")}</option>
            </Select>
          </Field>
        ) : form.type === "CONSUMABLE" ? (
          <Field label={t("products.form.fields.creditAmount")} htmlFor={idCredit}>
            <Input
              id={idCredit}
              type="number"
              min={0}
              value={form.creditAmount}
              onChange={(e) => set("creditAmount", e.target.value)}
              placeholder="100"
            />
          </Field>
        ) : (
          <div />
        )}
      </div>

      <fieldset className="grid grid-cols-1 gap-2 rounded-md border border-rv-divider bg-rv-c2/50 p-3">
        <legend className="px-1 text-[11px] uppercase tracking-wider text-rv-mute-500">
          {t("products.form.fields.storeIds")}
        </legend>
        <StoreField
          label="iOS"
          placeholder="com.acme.app.pro_monthly"
          value={form.iosId}
          onChange={(v) => set("iosId", v)}
        />
        <StoreField
          label="Android"
          placeholder="pro_monthly"
          value={form.androidId}
          onChange={(v) => set("androidId", v)}
        />
        <StoreField
          label="Web"
          placeholder="price_xxx"
          value={form.webId}
          onChange={(v) => set("webId", v)}
        />
      </fieldset>

      <ProductGroupsField
        groups={groups}
        selectedGroupIds={selectedGroupIds}
        onToggle={onToggleGroup}
      />

      <label className="flex items-center justify-between rounded-md border border-rv-divider bg-rv-c2/50 px-3 py-2.5">
        <span className="text-[13px]">{t("products.form.fields.isActive")}</span>
        <Switch
          checked={form.isActive}
          onChange={(v) => set("isActive", v)}
          ariaLabel={t("products.form.fields.isActive")}
        />
      </label>
    </div>
  );
}

function ProductGroupsField({
  groups,
  selectedGroupIds,
  onToggle,
}: {
  groups: ReadonlyArray<DashboardProductGroupRow>;
  selectedGroupIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => groups.filter((g) => selectedGroupIds.has(g.id)),
    [groups, selectedGroupIds],
  );

  return (
    <div>
      <div className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {t("products.form.fields.groups")}
      </div>

      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={cn(
            buttonVariants({ variant: "flat", size: "md" }),
            "h-auto w-full justify-between rounded-md border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] font-normal",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selected.length === 0 ? (
              <span className="text-rv-mute-500">
                {groups.length === 0
                  ? t("products.form.fields.groupsEmptyPlaceholder")
                  : t("products.form.fields.groupsPlaceholder")}
              </span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {selected.slice(0, 3).map((g) => (
                  <span
                    key={g.id}
                    className="rounded-md border border-rv-divider bg-rv-c1 px-1.5 py-0.5 font-rv-mono text-[11px] text-rv-mute-800"
                  >
                    {g.identifier}
                  </span>
                ))}
                {selected.length > 3 && (
                  <span className="rounded-md border border-rv-divider bg-rv-c1 px-1.5 py-0.5 font-rv-mono text-[11px] text-rv-mute-500">
                    +{selected.length - 3}
                  </span>
                )}
              </span>
            )}
          </span>
          <ChevronDown size={13} className="shrink-0 text-rv-mute-500" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={6} align="start" className="z-[60] w-[var(--anchor-width)]">
            <Popover.Popup className="max-h-[260px] w-full overflow-y-auto rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
              {groups.length === 0 ? (
                <div className="px-3 py-3 text-center text-[12px] text-rv-mute-500">
                  {t("products.form.fields.groupsEmpty")}
                </div>
              ) : (
                groups.map((g) => {
                  const checked = selectedGroupIds.has(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => onToggle(g.id)}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none hover:bg-rv-c4 hover:text-foreground"
                    >
                      <Checkbox
                        checked={checked}
                        onChange={() => onToggle(g.id)}
                        ariaLabel={g.identifier}
                      />
                      <span className="min-w-0 flex-1 truncate font-rv-mono text-[12px]">
                        {g.identifier}
                      </span>
                      {g.isDefault && (
                        <span className="rounded bg-rv-accent-500/[0.15] px-1 py-0.5 text-[10px] text-rv-accent-500">
                          {t("products.form.fields.groupsDefaultBadge")}
                        </span>
                      )}
                      {checked && !g.isDefault && (
                        <Check size={12} className="text-rv-accent-500" />
                      )}
                    </button>
                  );
                })
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <p className="mt-1 flex items-center gap-1 text-[11px] text-rv-mute-500">
        <Plus size={11} />
        {t("products.form.fields.groupsHint")}
      </p>
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
      >
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-rv-mute-500">{hint}</p>}
    </div>
  );
}

function StoreField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </span>
      <Input
        mono
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
