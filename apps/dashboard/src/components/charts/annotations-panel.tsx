import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../ui/button";
import { ANNOTATIONS } from "./mock-data";

export function AnnotationsPanel() {
  const { t } = useTranslation();

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
        {ANNOTATIONS.map((a, i) => (
          <li
            key={`${a.idx}-${i}`}
            className="grid grid-cols-[56px_1fr] gap-2.5 border-b border-white/[0.04] py-2 text-[12px] last:border-b-0"
          >
            <div className="flex items-center font-rv-mono text-[10px] text-rv-mute-500">
              <span
                className="mr-1.5 inline-block size-2 rounded-full"
                style={{ background: a.color }}
              />
              {a.date}
            </div>
            <div>
              <b className="font-medium">{t(a.labelKey)}</b>
              <div className="mt-0.5 text-[11px] text-rv-mute-500">
                {t(a.subKey)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
