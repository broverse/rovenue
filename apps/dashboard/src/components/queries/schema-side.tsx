import { ChevronDown, Database } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { AI_SUGGESTIONS, SCHEMA_TABLES } from "./mock-data";

/**
 * Right rail — collapsible schema browser, AI suggestion chip row, and
 * a tiny schedule status block. Sticky on wide layouts.
 */
export function SchemaSide() {
  const { t } = useTranslation();
  return (
    <aside className="flex max-h-[70vh] flex-col overflow-y-auto rounded-lg border border-rv-divider bg-rv-c1 min-[1481px]:sticky min-[1481px]:top-[76px] min-[1481px]:max-h-[calc(100vh-96px)]">
      <header className="border-b border-rv-divider px-3 py-2.5">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.schema.title")}
        </h3>
      </header>

      {SCHEMA_TABLES.map((table) => (
        <div key={table.name} className="border-b border-rv-divider py-1.5">
          <div className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px]">
            <Database size={12} className="text-rv-accent-400" />
            <span className="flex-1 font-rv-mono font-medium">{table.name}</span>
            <ChevronDown size={11} className="text-rv-mute-500" />
          </div>
          <div className="flex flex-col gap-0.5 px-3 pb-1.5 pl-8 font-rv-mono text-[11px]">
            {table.columns.map((col) => (
              <div
                key={col.name}
                className="flex cursor-pointer gap-2 py-0.5"
              >
                <span
                  className={cn(
                    "flex-1 truncate",
                    col.pk ? "text-rv-warning" : "text-rv-mute-700",
                  )}
                >
                  {col.name}
                  {col.pk && " ★"}
                </span>
                <span className="text-rv-mute-500">{col.type}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <header className="border-b border-t border-rv-divider px-3 py-2.5">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.suggestions.title")}
        </h3>
      </header>
      <div className="flex flex-wrap gap-1.5 border-b border-rv-divider px-3 py-2">
        {AI_SUGGESTIONS.map((key) => (
          <button
            key={key}
            type="button"
            className="cursor-pointer rounded border border-rv-divider bg-rv-c2 px-2 py-0.5 text-[11px] text-rv-mute-700 transition hover:bg-rv-c3 hover:text-foreground"
          >
            {t(`queries.suggestions.items.${key}`)}
          </button>
        ))}
      </div>

    </aside>
  );
}
