import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type { ChartAnnotation } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { ApiError } from "../../lib/api";
import {
  useChartAnnotations,
  useDeleteAnnotation,
} from "../../lib/hooks/useProjectCharts";
import { NewAnnotationDialog } from "./new-annotation-dialog";

interface Row {
  id: string;
  dateLabel: string;
  color: string;
  label: string;
  description: string | null;
  url: string | null;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}`;
}

type Props = {
  projectId: string;
};

export function AnnotationsPanel({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useChartAnnotations({ projectId, limit: 100 });
  const deleteAnnotation = useDeleteAnnotation(projectId);
  const [open, setOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows: Row[] = useMemo(() => {
    const list = data?.annotations ?? [];
    return list.map((a: ChartAnnotation) => ({
      id: a.id,
      dateLabel: fmtDate(a.occurredAt),
      color: a.color ?? "var(--color-rv-accent-500)",
      label: a.label,
      description: a.description,
      url: a.url,
    }));
  }, [data]);

  const onDelete = async (id: string, label: string) => {
    const ok = window.confirm(
      t("charts.annotations.deleteConfirm", {
        defaultValue: 'Delete annotation "{{label}}"?',
        label,
      }),
    );
    if (!ok) return;
    setDeleteError(null);
    try {
      await deleteAnnotation.mutateAsync(id);
    } catch (err) {
      setDeleteError(
        err instanceof ApiError
          ? err.message
          : t(
              "charts.annotations.deleteFailed",
              "Couldn't remove that annotation.",
            ),
      );
    }
  };

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <header className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">
          {t("charts.annotations.title")}
        </h3>
        <Button
          variant="flat"
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => setOpen(true)}
        >
          <Plus size={12} />
          {t("charts.annotations.add")}
        </Button>
      </header>

      {deleteError && (
        <div className="mb-2 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-2.5 py-1.5 text-[11px] text-rv-danger">
          {deleteError}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="py-4 text-center text-[11px] text-rv-mute-500">
          {isLoading
            ? t("charts.annotations.loading", "Loading…")
            : t(
                "charts.annotations.empty",
                "No annotations yet. Add one to flag launches, promos, or incidents.",
              )}
        </div>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.id}
              className="group grid grid-cols-[56px_1fr_auto] items-start gap-2.5 border-b border-white/[0.04] py-2 text-[12px] last:border-b-0"
            >
              <div className="flex items-center font-rv-mono text-[10px] text-rv-mute-500">
                <span
                  className="mr-1.5 inline-block size-2 rounded-full"
                  style={{ background: row.color }}
                />
                {row.dateLabel}
              </div>
              <div>
                {row.url ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-rv-accent-400 hover:underline"
                  >
                    {row.label}
                  </a>
                ) : (
                  <b className="font-medium">{row.label}</b>
                )}
                {row.description && (
                  <div className="mt-0.5 text-[11px] text-rv-mute-500">
                    {row.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDelete(row.id, row.label)}
                aria-label={t("charts.annotations.delete", "Delete annotation")}
                disabled={deleteAnnotation.isPending}
                className="rounded-md p-1 text-rv-mute-500 opacity-0 transition hover:bg-rv-c2 hover:text-rv-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewAnnotationDialog
        projectId={projectId}
        open={open}
        onClose={() => setOpen(false)}
      />
    </section>
  );
}
