import { useMemo, useState } from "react";
import { CANONICAL_FIELDS, validateMapping, type CanonicalField } from "@rovenue/shared";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { Button } from "../../ui/button";
import { Chip } from "../../ui/chip";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../lib/cn";
import {
  useImportColumns,
  useUpdateImportMapping,
  type ImportJob,
} from "../../lib/hooks/useImports";
import {
  IMPORT_MAPPING_EDITABLE_STATUSES,
  IMPORT_DEFAULT_SKIP_SANDBOX,
  IMPORT_DEFAULT_IMPORT_ANCHORLESS,
} from "./constants";

// =============================================================
// Mapping editor
// =============================================================
//
// Task-11 fix round 1: `GET .../imports/:id/columns` peeks the STORED
// file's header on demand (never persisted — see that route's own
// comment for why) and this editor turns each field's input into a
// PICKER over those columns once they're available, with the unassigned
// ones called out — this is the affordance that makes hand-mapping an
// export preset detection didn't recognise actually practical, rather
// than asking the operator to retype exact column names from a file
// that may be gigabytes and unopenable locally. A typo in free text
// would otherwise pass `validateMapping` (it only checks canonical-field
// coverage, never that a source column exists) and only surface later as
// a dry run where every row lands in `invalidRow`.
//
// Free-text entry stays as the FALLBACK for exactly the cases the peek
// can't cover: the columns request failing (network error, or the file
// having been deleted by the retention sweep — `useImportColumns`
// surfaces both as `isError`/an empty list, never throws into this
// component) or a file whose header genuinely couldn't be detected
// (`columns: []`, a normal peek outcome per that route's own comment).
//
// `validateMapping` (@rovenue/shared) is the SAME function the PATCH
// route runs server-side — reusing it here means the disabled-button
// state and the missing-field message can never drift from what the
// server would actually reject. It cannot, however, know whether a
// FREE-TYPED source column actually exists in the file — that gap is
// exactly what the picker closes when columns are available.

interface MappingEditorProps {
  projectId: string;
  job: ImportJob;
  onSaved?: (job: ImportJob) => void;
}

function mappingToColumnByField(
  mapping: Record<string, CanonicalField>,
): Partial<Record<CanonicalField, string>> {
  const out: Partial<Record<CanonicalField, string>> = {};
  for (const [sourceColumn, field] of Object.entries(mapping)) {
    out[field] = sourceColumn;
  }
  return out;
}

export function MappingEditor({ projectId, job, onSaved }: MappingEditorProps) {
  const [columnByField, setColumnByField] = useState<Partial<Record<CanonicalField, string>>>(
    () => mappingToColumnByField(job.mapping),
  );
  // Final-fix-wave FIX 6: the sandbox/anchorless opt-in was persisted on
  // import_jobs.options and READ by write.ts/plan.ts, but nothing wrote
  // it — no route, repository setter or UI control existed. This local
  // state plus the two checkboxes below close that gap; `handleSave`
  // sends it alongside the mapping on the SAME PATCH.
  const [skipSandbox, setSkipSandbox] = useState(
    job.options.skipSandbox ?? IMPORT_DEFAULT_SKIP_SANDBOX,
  );
  const [importAnchorless, setImportAnchorless] = useState(
    job.options.importAnchorless ?? IMPORT_DEFAULT_IMPORT_ANCHORLESS,
  );
  const updateMapping = useUpdateImportMapping(projectId, job.id);
  const editable = IMPORT_MAPPING_EDITABLE_STATUSES.has(job.status);

  // Only peeked while the mapping is actually editable — no point
  // spending the (cheap, but not free) peek on a locked, read-only view.
  const columnsQuery = useImportColumns(projectId, job.id, editable);
  const fileColumns = columnsQuery.data?.columns ?? [];
  const columnsAvailable = fileColumns.length > 0;

  const { mapping, validation } = useMemo(() => {
    const built: Record<string, CanonicalField> = {};
    for (const [field, column] of Object.entries(columnByField) as Array<
      [CanonicalField, string | undefined]
    >) {
      const trimmed = column?.trim();
      if (trimmed) built[trimmed] = field;
    }
    return { mapping: built, validation: validateMapping(built) };
  }, [columnByField]);

  const missingLabels = validation.ok
    ? []
    : validation.missingRequired.map(
        (key) => CANONICAL_FIELDS.find((field) => field.key === key)?.label ?? key,
      );

  const assignedColumns = useMemo(
    () => new Set(Object.values(columnByField).filter((value): value is string => Boolean(value))),
    [columnByField],
  );
  const unassignedColumns = fileColumns.filter((column) => !assignedColumns.has(column));

  const handleChange = (field: CanonicalField, value: string) => {
    setColumnByField((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    if (!validation.ok) return;
    updateMapping.mutate(
      { mapping, options: { skipSandbox, importAnchorless } },
      { onSuccess: (data) => onSaved?.(data.job) },
    );
  };

  return (
    <div data-testid="import-mapping-editor">
      {columnsAvailable && (
        <div
          data-testid="import-unassigned-columns"
          className="mb-3 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[12.5px] text-rv-mute-600"
        >
          {unassignedColumns.length > 0 ? (
            <>
              <span className="font-medium text-rv-mute-700">Columns not yet used: </span>
              {unassignedColumns.join(", ")}
            </>
          ) : (
            "Every column in your file has been assigned to a field."
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-rv-divider">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rv-divider bg-rv-c2 text-left text-[11px] uppercase tracking-wide text-rv-mute-500">
              <th className="px-3 py-2 font-medium">Canonical field</th>
              <th className="px-3 py-2 font-medium">Source column</th>
            </tr>
          </thead>
          <tbody>
            {CANONICAL_FIELDS.map((field) => {
              const currentValue = columnByField[field.key] ?? "";
              const label = `Source column for ${field.label}`;
              return (
                <tr key={field.key} className="border-b border-rv-divider last:border-0">
                  <td className="px-3 py-2">
                    <span>{field.label}</span>
                    {field.required && (
                      <Chip tone="warning" className="ml-2">
                        Required
                      </Chip>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {columnsAvailable ? (
                      <NativeSelect
                        disabled={!editable}
                        value={currentValue}
                        aria-label={label}
                        onChange={(event) => handleChange(field.key, event.target.value)}
                      >
                        <option value="">Not mapped</option>
                        {fileColumns.map((column) => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                        {/* A previously-saved or free-typed value that no
                            longer matches a column the peek just found —
                            kept as its own option so switching to the
                            picker never silently clears a value the
                            operator already set. */}
                        {currentValue && !fileColumns.includes(currentValue) && (
                          <option value={currentValue}>{currentValue} (not in file header)</option>
                        )}
                      </NativeSelect>
                    ) : (
                      <Input
                        mono
                        disabled={!editable}
                        value={currentValue}
                        placeholder="Exact column name from your file"
                        aria-label={label}
                        onChange={(event) => handleChange(field.key, event.target.value)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!columnsAvailable && editable && (
        <p className="mt-2 text-[12px] text-rv-mute-500" data-testid="import-columns-fallback-note">
          {columnsQuery.isError
            ? "Couldn't read this file's column names — type them in exactly as they appear in your export."
            : columnsQuery.isLoading
              ? "Reading your file's column names…"
              : "This file's column names couldn't be detected — type them in exactly as they appear in your export."}
        </p>
      )}

      <div className="mt-3 space-y-2" data-testid="import-options-controls">
        <label className="flex cursor-pointer items-start gap-2 text-[13px]">
          <Checkbox
            checked={skipSandbox}
            // `Checkbox` has no `disabled` prop — every other read-only
            // usage in this repo is a plain visual toggle with nowhere
            // that needs to block it, so the no-op guard belongs here,
            // not on the (CSS-only, non-blocking) styling below.
            onChange={() => editable && setSkipSandbox((prev) => !prev)}
            ariaLabel="Skip sandbox rows"
            className={cn(!editable && "pointer-events-none opacity-50")}
          />
          <span>
            Skip sandbox rows
            <span className="block text-[12px] text-rv-mute-500">
              Test-environment purchases are excluded by default.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-[13px]">
          <Checkbox
            checked={importAnchorless}
            onChange={() => editable && setImportAnchorless((prev) => !prev)}
            ariaLabel="Import anchorless (promotional / manual grant) rows"
            className={cn(!editable && "pointer-events-none opacity-50")}
          />
          <span>
            Import anchorless rows
            <span className="block text-[12px] text-rv-mute-500">
              Promotional / manual grants with no store transaction — imported as
              history by default.
            </span>
          </span>
        </label>
      </div>

      {!validation.ok && (
        <p role="alert" className="mt-2 text-[13px] text-rv-danger">
          Missing required field{missingLabels.length > 1 ? "s" : ""}: {missingLabels.join(", ")}
        </p>
      )}

      {updateMapping.isError && (
        <p role="alert" className="mt-2 text-[13px] text-rv-danger">
          {updateMapping.error instanceof Error
            ? updateMapping.error.message
            : "Could not save this mapping."}
        </p>
      )}

      <Button
        variant="solid-primary"
        size="sm"
        className={cn("mt-3")}
        disabled={!editable || !validation.ok || updateMapping.isPending}
        onClick={handleSave}
      >
        Save mapping
      </Button>
    </div>
  );
}
