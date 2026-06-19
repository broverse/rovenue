import { useTranslation } from "react-i18next";
import { SearchInput } from "../../ui/search-input";

type Props = {
  query: string;
  onQueryChange: (next: string) => void;
};

export function AppsToolbar({ query, onQueryChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5 sm:px-3.5">
      <SearchInput
        value={query}
        onValueChange={onQueryChange}
        placeholder={t("apps.toolbar.searchPlaceholder")}
        aria-label={t("apps.toolbar.searchAria")}
        size="md"
        rootClassName="w-full min-w-0 flex-1 sm:w-auto sm:min-w-[220px]"
      />
    </div>
  );
}
