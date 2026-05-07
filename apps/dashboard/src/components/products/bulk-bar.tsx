import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { IconX } from "../dashboard/icons";

type Props = {
  selectedCount: number;
  onClear: () => void;
};

/**
 * Sticky action bar shown when one or more rows are selected. Slides in from
 * the top via `animate-rv-bulk-in` (defined in `index.css`).
 */
export function BulkBar({ selectedCount, onClear }: Props) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-16 z-10 mb-3 flex items-center gap-3 rounded-lg border border-rv-divider-strong bg-rv-c3 px-3 py-2 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.5)] animate-rv-bulk-in">
      <span className="font-rv-mono text-[12px]">
        {selectedCount} {t("products.bulk.selected")}
      </span>
      <span className="h-4 w-px bg-rv-divider" />
      <Button variant="light" size="sm" className="h-[26px] text-[12px]">
        {t("products.bulk.changeGroup")}
      </Button>
      <Button variant="light" size="sm" className="h-[26px] text-[12px]">
        {t("products.bulk.linkEntitlement")}
      </Button>
      <Button variant="light" size="sm" className="h-[26px] text-[12px]">
        {t("products.bulk.archive")}
      </Button>
      <Button variant="light" size="sm" className="h-[26px] text-[12px] text-rv-danger hover:text-rv-danger">
        {t("products.bulk.delete")}
      </Button>
      <Button
        variant="light"
        size="icon"
        className="ml-auto size-[26px]"
        aria-label={t("products.bulk.clearSelection")}
        onClick={onClear}
      >
        <IconX size={13} />
      </Button>
    </div>
  );
}
