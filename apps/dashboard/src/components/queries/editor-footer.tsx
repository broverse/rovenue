import { useTranslation } from "react-i18next";
import type { SavedQuery } from "./types";

type Props = {
  query: SavedQuery;
};

/**
 * Slim mono status strip under the SQL pane — compile/lint indicator,
 * line/char count, and warehouse hints (cost, cache, runtime).
 */
export function EditorFooter({ query }: Props) {
  const { t } = useTranslation();
  const lineCount = query.sql?.length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-rv-divider bg-rv-c2 px-3.5 py-2 font-rv-mono text-[11px] text-rv-mute-500">
      <span className="text-rv-success">●&nbsp;{t("queries.footer.compiled")}</span>
      <span>{t("queries.footer.lineChars", { lines: lineCount, chars: 332 })}</span>
      <span className="ml-auto">
        {t("queries.footer.cost", { bytes: query.bytesScanned ?? "—" })}
      </span>
      <span>{t("queries.footer.cache")}</span>
      <span>{t("queries.footer.runtime")}</span>
    </div>
  );
}
