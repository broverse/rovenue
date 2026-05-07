import { Calendar, Save, Wand2, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";

export type QueryMode = "sql" | "visual";

type Props = {
  mode: QueryMode;
  onModeChange: (next: QueryMode) => void;
  savedAgoLabel: string;
};

/**
 * Editor action bar — datasource pill on the left, SQL / Visual builder
 * toggle, "saved" timestamp, then Schedule / Format / Save secondary
 * buttons and the primary Run button with the ⌘⏎ hint.
 */
export function QueryActions({ mode, onModeChange, savedAgoLabel }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-rv-divider bg-rv-c2 px-3 py-2">
      <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c1 px-2.5 font-rv-mono text-[11.5px]">
        <span
          className="size-1.5 rounded-full bg-rv-success ring-2 ring-rv-success/30"
          aria-hidden
        />
        {t("queries.actions.datasource")}
      </span>

      <div className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c1 p-0.5">
        <ModeButton
          active={mode === "sql"}
          onClick={() => onModeChange("sql")}
          label={t("queries.actions.modeSql")}
        />
        <ModeButton
          active={mode === "visual"}
          onClick={() => onModeChange("visual")}
          label={t("queries.actions.modeVisual")}
        />
      </div>

      <span className="ml-2 font-rv-mono text-[11px] text-rv-mute-500">
        {savedAgoLabel}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button variant="light" className="h-[26px]" aria-label={t("queries.actions.schedule")}>
          <Calendar size={12} />
          <span className="hidden sm:inline">{t("queries.actions.schedule")}</span>
        </Button>
        <Button variant="light" className="h-[26px]" aria-label={t("queries.actions.format")}>
          <Wand2 size={12} />
          <span className="hidden sm:inline">{t("queries.actions.format")}</span>
        </Button>
        <Button variant="flat" className="h-[26px]" aria-label={t("queries.actions.save")}>
          <Save size={12} />
          <span className="hidden sm:inline">{t("queries.actions.save")}</span>
        </Button>
        <button
          type="button"
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-rv-accent-500 px-3.5 text-[12px] font-medium text-white transition hover:bg-rv-accent-600"
        >
          <Zap size={12} />
          {t("queries.actions.run")}
          <Kbd className="hidden bg-white/20 text-white sm:inline-flex">⌘ ⏎</Kbd>
        </button>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-[11px] transition",
        active ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
