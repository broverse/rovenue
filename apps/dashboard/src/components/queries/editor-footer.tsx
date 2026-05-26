import { useTranslation } from "react-i18next";

type Props = {
  sql: string;
  errorMessage?: string | null;
};

/**
 * Slim mono status strip under the SQL pane — compile/lint indicator,
 * line/char count, and a one-line error string when the last execution
 * failed.
 */
export function EditorFooter({ sql, errorMessage }: Props) {
  const { t } = useTranslation();
  const lines = sql ? sql.split("\n").length : 0;
  const chars = sql.length;
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-rv-divider bg-rv-c2 px-3.5 py-2 font-rv-mono text-[11px] text-rv-mute-500">
      {errorMessage ? (
        <span className="text-rv-danger">●&nbsp;{errorMessage}</span>
      ) : (
        <span className="text-rv-success">●&nbsp;{t("queries.footer.ready")}</span>
      )}
      <span>{t("queries.footer.lineChars", { lines, chars })}</span>
      <span className="ml-auto">{t("queries.footer.runtime")}</span>
    </div>
  );
}
