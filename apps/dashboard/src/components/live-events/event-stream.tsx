import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { Button } from "../../ui/button";
import { EventRow } from "./event-row";
import type { LiveEvent } from "./types";

type Props = {
  events: ReadonlyArray<LiveEvent>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onResetFilters: () => void;
};

const headerCellBase = "min-w-0";
const headerGrid =
  "grid grid-cols-[90px_minmax(0,1fr)_110px_minmax(0,1fr)_80px_100px_90px] gap-3 border border-rv-divider border-t-0 bg-rv-c1 px-3.5 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500 max-[1280px]:grid-cols-[80px_minmax(0,1fr)_90px_70px_90px]";

export function EventStream({ events, selectedId, onSelect, onResetFilters }: Props) {
  const { t } = useTranslation();
  return (
    <>
      <div className={headerGrid}>
        <div className={headerCellBase}>{t("liveEvents.cols.time")}</div>
        <div className={headerCellBase}>{t("liveEvents.cols.type")}</div>
        <div className={headerCellBase}>{t("liveEvents.cols.user")}</div>
        <div className={`${headerCellBase} text-right max-[1280px]:hidden`}>
          {t("liveEvents.cols.product")}
        </div>
        <div className={`${headerCellBase} max-[1280px]:hidden`}>
          {t("liveEvents.cols.platform")}
        </div>
        <div className={`${headerCellBase} text-right`}>{t("liveEvents.cols.amount")}</div>
        <div className={`${headerCellBase} text-right`}>{t("liveEvents.cols.country")}</div>
      </div>

      <div
        role="list"
        className="min-h-[520px] max-h-[calc(100vh-280px)] overflow-y-auto rounded-b-lg border border-t-0 border-rv-divider bg-rv-c1 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]"
      >
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
            <div className="mb-3 flex size-10 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
              <Search size={18} />
            </div>
            <h3 className="m-0 mb-1 text-[13px] font-semibold">
              {t("liveEvents.empty.title")}
            </h3>
            <p className="m-0 mb-3 max-w-[280px] text-[12px] text-rv-mute-500">
              {t("liveEvents.empty.body")}
            </p>
            <Button variant="flat" size="sm" onClick={onResetFilters}>
              {t("liveEvents.empty.reset")}
            </Button>
          </div>
        ) : (
          events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              selected={event.id === selectedId}
              onClick={() => onSelect(event.id)}
            />
          ))
        )}
      </div>
    </>
  );
}
