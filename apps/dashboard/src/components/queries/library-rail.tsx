import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, LineChart, Loader2, Plus } from "lucide-react";
import type { DashboardSavedQuery } from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { SearchInput } from "../../ui/search-input";

type Props = {
  queries: ReadonlyArray<DashboardSavedQuery>;
  draftIds: ReadonlyArray<string>;
  draftNames?: Readonly<Record<string, string>>;
  selectedId: string | null;
  onSelect: (next: string) => void;
  onNew: () => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
};

/**
 * Left rail — saved queries list with a search box and a "New query"
 * button. Draft (unsaved) queries appear in their own section at the
 * top so the user can tell them apart from saved entries.
 */
export function LibraryRail({
  queries,
  draftIds,
  draftNames,
  selectedId,
  onSelect,
  onNew,
  loading,
  error,
  onRetry,
}: Props) {
  const { t } = useTranslation();
  const [term, setTerm] = useState("");
  const needle = term.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!needle) return queries;
    return queries.filter((q) => q.name.toLowerCase().includes(needle));
  }, [queries, needle]);

  const visibleDraftIds = useMemo(() => {
    if (!needle) return draftIds;
    return draftIds.filter((id) =>
      (draftNames?.[id] ?? t("queries.draft.untitled"))
        .toLowerCase()
        .includes(needle),
    );
  }, [draftIds, draftNames, needle, t]);

  return (
    <aside className="flex max-h-[70vh] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1 min-[1024px]:sticky min-[1024px]:top-[76px] min-[1024px]:max-h-[calc(100vh-96px)]">
      <div className="flex items-center gap-1.5 border-b border-rv-divider px-3 py-2.5">
        <h3 className="flex-1 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.library.title")}
        </h3>
        <Button
          variant="light"
          size="icon"
          aria-label={t("queries.library.newAria")}
          className="size-[22px]"
          onClick={onNew}
        >
          <Plus size={11} />
        </Button>
      </div>
      <div className="border-b border-rv-divider p-2.5">
        <SearchInput
          value={term}
          onValueChange={setTerm}
          placeholder={t("queries.library.searchPlaceholder")}
          aria-label={t("queries.library.searchAria")}
          size="sm"
        />
      </div>
      <div className="flex-1 overflow-y-auto py-1.5">
        {loading && queries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-[12px] text-rv-mute-500">
            <Loader2 size={12} className="animate-spin" />
            <span>{t("common.loading")}</span>
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-[12px]">
            <p className="text-rv-danger">{t("queries.library.loadFailed")}</p>
            {onRetry && (
              <Button
                variant="flat"
                size="sm"
                className="mt-2"
                onClick={onRetry}
              >
                {t("common.retry")}
              </Button>
            )}
          </div>
        ) : (
          <>
            {visibleDraftIds.length > 0 && (
              <div>
                <div className="px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("queries.library.sections.drafts")}
                </div>
                {visibleDraftIds.map((id) => {
                  const active = id === selectedId;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onSelect(id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] transition",
                        active
                          ? "bg-rv-accent-500/14 text-rv-accent-400"
                          : "text-rv-mute-700 hover:bg-rv-c2",
                      )}
                    >
                      <FileText size={12} className="shrink-0 opacity-80" />
                      <span className="flex-1 truncate italic">
                        {draftNames?.[id] ?? t("queries.draft.untitled")}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div>
              <div className="px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("queries.library.sections.saved")}
              </div>
              {filtered.length === 0 && visibleDraftIds.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-rv-mute-500">
                  {needle
                    ? t("queries.library.noResults")
                    : t("queries.library.empty")}
                </div>
              ) : (
                filtered.map((q) => {
                  const active = q.id === selectedId;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => onSelect(q.id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] transition",
                        active
                          ? "bg-rv-accent-500/14 text-rv-accent-400"
                          : "text-rv-mute-700 hover:bg-rv-c2",
                      )}
                    >
                      <LineChart size={12} className="shrink-0 opacity-80" />
                      <span className="flex-1 truncate">{q.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
