import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { ApiError } from "../../lib/api";
import { useAudiences } from "../../lib/hooks/useProjectAdmin";
import { useProjectPaywalls } from "../../lib/hooks/useProjectPaywalls";
import { useExperiments } from "../../lib/hooks/useExperiments";
import {
  useCreatePlacement,
  useUpdatePlacement,
} from "../../lib/hooks/useProjectPlacements";
import { extractPlacementApiErrorMessage } from "./placement-errors";
import { PlacementMetricsCard } from "./placement-metrics-card";
import { RowCard } from "./row-card";
import { filterPaywallExperiments } from "./target-picker";
import {
  addRow,
  canRowBeAllUsers,
  moveRow,
  removeRow,
  setRowAudience,
  setRowTarget,
  validatePlacementRows,
  type PlacementRowValidationError,
} from "./placement-rows-utils";
import type { Placement, PlacementRow } from "./types";

// Mirrors the backend validator (apps/api/src/routes/dashboard/placements.ts):
// lowercase alphanumeric, hyphens and underscores only.
const IDENTIFIER_RE = /^[a-z0-9-_]+$/;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type CreateProps = {
  mode: "create";
  projectId: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
};

type EditProps = {
  mode: "edit";
  projectId: string;
  placement: Placement;
  onDeleteRequest: () => void;
};

type Props = CreateProps | EditProps;

export function PlacementEditor(props: Props) {
  const { t } = useTranslation();
  const editing = props.mode === "edit";
  const initial = editing ? props.placement : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [identifier, setIdentifier] = useState(initial?.identifier ?? "");
  const [identifierTouched, setIdentifierTouched] = useState(editing);
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [rows, setRows] = useState<PlacementRow[]>(initial?.rows ?? []);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);

  // Re-seed local state whenever the underlying placement identity
  // changes (switching selection in the list) — but NOT on every
  // background refetch of the same placement, which would clobber
  // in-progress edits.
  const placementId = editing ? props.placement.id : null;
  useEffect(() => {
    setName(initial?.name ?? "");
    setIdentifier(initial?.identifier ?? "");
    setIsActive(initial?.isActive ?? true);
    setRows(initial?.rows ?? []);
    setFormError(null);
    setSavedRevision(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placementId]);

  useEffect(() => {
    if (identifierTouched) return;
    setIdentifier(slugify(name));
  }, [name, identifierTouched]);

  const audiencesQuery = useAudiences(props.projectId);
  const audiences = audiencesQuery.data ?? [];

  const paywallsQuery = useProjectPaywalls(props.projectId);
  const paywalls = paywallsQuery.data?.paywalls ?? [];

  const experimentsQuery = useExperiments({ projectId: props.projectId, type: "PAYWALL" });
  const experiments = useMemo(
    () => filterPaywallExperiments(experimentsQuery.data ?? []),
    [experimentsQuery.data],
  );

  const create = useCreatePlacement(props.projectId);
  const update = useUpdatePlacement(props.projectId, editing ? props.placement.id : "");
  const pending = create.isPending || update.isPending;

  const trimmedName = name.trim();
  const trimmedIdentifier = identifier.trim();
  const identifierValid = IDENTIFIER_RE.test(trimmedIdentifier);

  const rowsError: PlacementRowValidationError | null = useMemo(
    () => validatePlacementRows(rows),
    [rows],
  );

  const isDirty = editing
    ? trimmedName !== (initial?.name ?? "") ||
      isActive !== (initial?.isActive ?? true) ||
      JSON.stringify(rows) !== JSON.stringify(initial?.rows ?? [])
    : true;

  const canSubmit =
    trimmedName.length > 0 &&
    (editing || (trimmedIdentifier.length > 0 && identifierValid)) &&
    rowsError === null &&
    !pending &&
    isDirty;

  const rowError = (idx: number) => (rowsError && rowsError.index === idx ? rowsError.code : null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (rowsError) {
      setFormError(rowErrorMessage(rowsError, t));
      return;
    }
    try {
      if (props.mode === "create") {
        const res = await create.mutateAsync({
          identifier: trimmedIdentifier,
          name: trimmedName,
          isActive,
        });
        props.onCreated(res.placement.id);
      } else {
        const res = await update.mutateAsync({
          name: trimmedName,
          rows,
          isActive,
        });
        setSavedRevision(res.placement.revision);
      }
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? extractPlacementApiErrorMessage(err)
          : t("placements.editor.errors.generic", "Could not save the placement. Please try again."),
      );
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <section className="rounded-lg border border-rv-divider bg-rv-c1">
        <header className="flex items-start justify-between gap-4 border-b border-rv-divider px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-foreground">
              {editing
                ? props.placement.name || t("placements.editor.untitled", "Untitled placement")
                : t("placements.editor.createTitle", "New placement")}
            </h2>
            {editing && (
              <div className="mt-0.5 flex items-center gap-2 font-rv-mono text-[11px] text-rv-mute-500">
                <span>{props.placement.identifier}</span>
                <span>·</span>
                <span>
                  {t("placements.editor.revision", { defaultValue: "revision {{rev}}", rev: props.placement.revision })}
                </span>
              </div>
            )}
          </div>
          {editing && (
            <Button
              type="button"
              variant="flat"
              size="sm"
              onClick={props.onDeleteRequest}
              className="!text-rv-danger hover:!bg-rv-danger/10"
            >
              <Trash2 size={13} />
              {t("placements.editor.delete", "Delete")}
            </Button>
          )}
        </header>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("placements.editor.name.label", "Name")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("placements.editor.name.placeholder", "e.g. Onboarding")}
                autoComplete="off"
              />
            </Field>
            <Field
              label={t("placements.editor.identifier.label", "Identifier")}
              hint={
                editing
                  ? t("placements.editor.identifier.locked", "Can't be changed after creation.")
                  : trimmedIdentifier.length > 0 && !identifierValid
                    ? t(
                        "placements.editor.identifier.invalid",
                        "Use lowercase letters, numbers, hyphens or underscores.",
                      )
                    : t(
                        "placements.editor.identifier.hint",
                        "Stable key the SDK resolves against. Set once and can't be changed after creation.",
                      )
              }
            >
              <Input
                mono
                value={identifier}
                disabled={editing}
                onChange={(e) => {
                  if (editing) return;
                  setIdentifierTouched(true);
                  setIdentifier(e.target.value);
                }}
                placeholder="onboarding"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!editing && trimmedIdentifier.length > 0 && !identifierValid}
              />
            </Field>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5">
            <Switch
              checked={isActive}
              onChange={setIsActive}
              ariaLabel={t("placements.editor.active.label", "Active")}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-foreground">
                {t("placements.editor.active.label", "Active")}
              </span>
              <span className="text-[12px] text-rv-mute-500">
                {t(
                  "placements.editor.active.hint",
                  "Inactive placements resolve to no target for every subscriber.",
                )}
              </span>
            </span>
          </label>
        </div>
      </section>

      {editing && (
        <section className="rounded-lg border border-rv-divider bg-rv-c1">
          <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3">
            <div>
              <h3 className="text-[13px] font-medium text-foreground">
                {t("placements.editor.rows.title", "Rows")}
              </h3>
              <p className="mt-0.5 text-[11px] text-rv-mute-500">
                {t(
                  "placements.editor.rows.subtitle",
                  "Evaluated top to bottom. Add an \"All users\" row last as a fallback.",
                )}
              </p>
            </div>
          </header>

          <div className="flex flex-col gap-3 px-5 py-4">
            {rows.length === 0 && (
              <div className="rounded-md border border-dashed border-rv-divider-strong px-4 py-6 text-center text-[12px] text-rv-mute-500">
                {t("placements.editor.rows.empty", "No rows yet — every subscriber resolves to nothing.")}
              </div>
            )}

            {rows.map((row, idx) => (
              <div key={idx} className="flex flex-col gap-1">
                <RowCard
                  row={row}
                  index={idx}
                  isFirst={idx === 0}
                  isLast={idx === rows.length - 1}
                  canBeAllUsers={canRowBeAllUsers(rows, idx)}
                  audiences={audiences}
                  audiencesLoading={audiencesQuery.isPending}
                  paywalls={paywalls}
                  paywallsLoading={paywallsQuery.isPending}
                  experiments={experiments}
                  experimentsLoading={experimentsQuery.isPending}
                  onMoveUp={() => setRows((prev) => moveRow(prev, idx, "up"))}
                  onMoveDown={() => setRows((prev) => moveRow(prev, idx, "down"))}
                  onRemove={() => setRows((prev) => removeRow(prev, idx))}
                  onAudienceChange={(audienceId) =>
                    setRows((prev) => setRowAudience(prev, idx, audienceId))
                  }
                  onTargetChange={(target) => setRows((prev) => setRowTarget(prev, idx, target))}
                  disabled={pending}
                />
                {rowError(idx) && (
                  <p className="px-1 text-[11px] text-rv-danger">
                    {t(`placements.editor.rows.errors.${rowError(idx)}`, rowError(idx) ?? "")}
                  </p>
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={() => setRows((prev) => addRow(prev))}
              disabled={pending}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-rv-divider-strong bg-transparent px-4 py-3 text-[12px] font-medium text-rv-mute-600 transition hover:border-rv-accent-500 hover:bg-rv-accent-500/5 hover:text-rv-accent-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={13} />
              {t("placements.editor.rows.add", "Add row")}
            </button>
          </div>
        </section>
      )}

      {formError && (
        <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
          {formError}
        </div>
      )}

      {savedRevision !== null && (
        <div className="rounded-md border border-rv-success/30 bg-rv-success/10 px-3 py-2 text-[12px] text-rv-success">
          {t("placements.editor.saved", { defaultValue: "Saved — now revision {{rev}}.", rev: savedRevision })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid-primary" size="sm" disabled={!canSubmit}>
          <Save size={13} />
          {editing
            ? update.isPending
              ? t("placements.editor.saving", "Saving…")
              : t("placements.editor.save", "Save changes")
            : create.isPending
              ? t("placements.editor.creating", "Creating…")
              : t("placements.editor.create", "Create placement")}
        </Button>
        {props.mode === "create" && (
          <Button type="button" variant="flat" size="sm" onClick={props.onCancel}>
            {t("common.cancel", "Cancel")}
          </Button>
        )}
      </div>

      {editing && (
        <PlacementMetricsCard projectId={props.projectId} placementId={props.placement.id} />
      )}
    </form>
  );
}

function rowErrorMessage(
  err: PlacementRowValidationError,
  t: (key: string, opts: Record<string, unknown>) => string,
): string {
  return t(`placements.editor.rows.errors.${err.code}`, {
    defaultValue: rowErrorFallback(err.code),
    n: err.index + 1,
  });
}

function rowErrorFallback(code: PlacementRowValidationError["code"]): string {
  switch (code) {
    case "AUDIENCE_UNSET":
      return "Row {{n}}: pick an audience or \"All users\".";
    case "TARGET_INCOMPLETE":
      return "Row {{n}}: pick a paywall or experiment for this target.";
    case "ALL_USERS_NOT_LAST":
      return "Row {{n}}: the \"All users\" row must be last.";
    case "DUPLICATE_ALL_USERS":
      return "Row {{n}}: only one \"All users\" row is allowed.";
    default:
      return "Fix the highlighted row before saving.";
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <p className="text-[11px] leading-snug text-rv-mute-500">{hint}</p>}
    </div>
  );
}
