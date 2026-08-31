import { useMemo, useState } from "react";
import { CANONICAL_FIELDS, validateMapping, type CanonicalField } from "@rovenue/shared";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { Chip } from "../../ui/chip";
import { cn } from "../../lib/cn";
import { useUpdateImportMapping, type ImportJob } from "../../lib/hooks/useImports";
import { IMPORT_MAPPING_EDITABLE_STATUSES } from "./constants";

// =============================================================
// Mapping editor
// =============================================================
//
// The upload endpoint peeks the file's header row to DETECT a preset,
// but never returns that header list to the dashboard (no endpoint
// surfaces "here are the raw columns your file has" — checked against
// apps/api/src/routes/dashboard/imports.ts and every import repository/
// service file; there isn't one). So this can't be a dropdown of
// detected columns. Instead the operator types the EXACT source column
// name from their own file next to each canonical field — which is
// exactly the shape `mapping` already is server-side
// (Record<sourceColumn, CanonicalField>), just edited field-first
// instead of column-first. When detection DID succeed, `job.mapping`
// already has real column names as values here, pre-filling this table;
// when it didn't (an unrecognised export — a normal outcome, not an
// error, per task-11 controller context), every field starts blank and
// the operator fills them in by hand from the file they already have
// open.
//
// `validateMapping` (@rovenue/shared) is the SAME function the PATCH
// route runs server-side — reusing it here means the disabled-button
// state and the missing-field message can never drift from what the
// server would actually reject.

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
  const updateMapping = useUpdateImportMapping(projectId, job.id);
  const editable = IMPORT_MAPPING_EDITABLE_STATUSES.has(job.status);

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

  const handleChange = (field: CanonicalField, value: string) => {
    setColumnByField((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    if (!validation.ok) return;
    updateMapping.mutate(mapping, {
      onSuccess: (data) => onSaved?.(data.job),
    });
  };

  return (
    <div data-testid="import-mapping-editor">
      <div className="overflow-x-auto rounded-lg border border-rv-divider">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rv-divider bg-rv-c2 text-left text-[11px] uppercase tracking-wide text-rv-mute-500">
              <th className="px-3 py-2 font-medium">Canonical field</th>
              <th className="px-3 py-2 font-medium">Source column name</th>
            </tr>
          </thead>
          <tbody>
            {CANONICAL_FIELDS.map((field) => (
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
                  <Input
                    mono
                    disabled={!editable}
                    value={columnByField[field.key] ?? ""}
                    placeholder="Exact column name from your file"
                    aria-label={`Source column for ${field.label}`}
                    onChange={(event) => handleChange(field.key, event.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
