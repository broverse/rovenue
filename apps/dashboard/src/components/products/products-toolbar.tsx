import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { SearchInput } from "../../ui/search-input";
import { IconLayers, IconTag } from "../dashboard/icons";

type Props = {
  search: string;
  onSearchChange: (next: string) => void;
  /** Number of products visible after filters. */
  visible: number;
  /** Total products in the catalog. */
  total: number;
};

/**
 * Inline toolbar above the table — search field, column / filter buttons,
 * and a right-aligned "X of Y" counter.
 */
export function ProductsToolbar({ search, onSearchChange, visible, total }: Props) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <SearchInput
        value={search}
        onValueChange={onSearchChange}
        placeholder={t("products.toolbar.searchPlaceholder")}
        rootClassName="max-w-[320px] flex-1"
        showSlashHint
      />
      <Button variant="flat" size="sm">
        <IconLayers size={13} />
        {t("products.toolbar.columns")}
      </Button>
      <Button variant="flat" size="sm">
        <IconTag size={13} />
        {t("products.toolbar.filter")}
      </Button>
      <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
        {visible} {t("products.toolbar.of")} {total}
      </span>
    </div>
  );
}
