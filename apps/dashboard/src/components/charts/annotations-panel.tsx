import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { ChartAnnotation } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { useChartAnnotations } from "../../lib/hooks/useProjectCharts";
import { ANNOTATIONS } from "./mock-data";

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
  const { data } = useChartAnnotations({ projectId, limit: 100 });

  const rows: Row[] = useMemo(() => {
    const list = data?.annotations ?? [];
    if (list.length === 0) {
      // Mock entries keep the panel visually consistent with the
      // rest of the demo state until the project gets its first
      // real annotation.
      return ANNOTATIONS.map((a, i) => ({
        id: `mock-${i}`,
        dateLabel: a.date,
        color: a.color,
        label: t(a.labelKey),
        description: t(a.subKey),
        url: null,
      }));
    }
    return list.map((a: ChartAnnotation) => ({
      id: a.id,
      dateLabel: fmtDate(a.occurredAt),
      color: a.color ?? "var(--color-rv-accent-500)",
      label: a.label,
      description: a.description,
      url: a.url,
    }));
  }, [data, t]);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <header className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">
          {t("charts.annotations.title")}
        </h3>
        <Button variant="flat" size="sm" className="h-6 text-[11px]">
          <Plus size={12} />
          {t("charts.annotations.add")}
        </Button>
      </header>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.id}
            className="grid grid-cols-[56px_1fr] gap-2.5 border-b border-white/[0.04] py-2 text-[12px] last:border-b-0"
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
          </li>
        ))}
      </ul>
    </section>
  );
}
