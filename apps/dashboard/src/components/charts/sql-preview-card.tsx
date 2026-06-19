import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { Button } from "../../ui/button";
import { SQL_PREVIEW } from "./mock-data";

type Props = {
  onOpenInQueries?: () => void;
};

export function SqlPreviewCard({ onOpenInQueries }: Props) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {t("charts.sql.title")}
      </h4>
      <pre className="m-0 overflow-x-auto rounded border border-rv-divider bg-[#06060A] px-3 py-2.5 font-rv-mono text-[10px] leading-[1.5] text-rv-mute-700">
        {SQL_PREVIEW}
      </pre>
      <Button
        variant="flat"
        size="sm"
        className="mt-2 w-full justify-center"
        onClick={onOpenInQueries}
      >
        <Search size={12} />
        {t("charts.sql.openInQueries")}
      </Button>
    </div>
  );
}
