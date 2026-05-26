import { Trans, useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

type Props = {
  /** 1-based current page. */
  page: number;
  /** Number of rows on this page. */
  visible: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  isLoading?: boolean;
};

/**
 * Cursor-driven paginator. We don't know the full result count
 * upfront (the API returns one opaque `nextCursor` per page) so
 * the strip shows the active page index plus prev/next buttons
 * — no jump-to-page numbers.
 */
export function TransactionsPaginator({
  page,
  visible,
  canPrev,
  canNext,
  onPrev,
  onNext,
  isLoading,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between border-t border-rv-divider px-3.5 py-2.5 text-[12px] text-rv-mute-600">
      <span>
        <Trans
          i18nKey="transactions.paginator.page"
          values={{ page, visible: visible.toLocaleString() }}
          components={{
            0: <span className="font-rv-mono text-foreground" />,
          }}
        />
      </span>
      <div className="flex gap-1">
        <PgButton
          ariaLabel={t("transactions.paginator.previous")}
          disabled={!canPrev || isLoading}
          onClick={onPrev}
        >
          ‹
        </PgButton>
        <span className="inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-[4px] border border-rv-accent-500 bg-rv-accent-500 px-2 font-rv-mono text-[12px] text-white">
          {page}
        </span>
        <PgButton
          ariaLabel={t("transactions.paginator.next")}
          disabled={!canNext || isLoading}
          onClick={onNext}
        >
          ›
        </PgButton>
      </div>
    </div>
  );
}

function PgButton({
  disabled,
  ariaLabel,
  onClick,
  children,
}: {
  disabled?: boolean;
  ariaLabel?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-[26px] min-w-[26px] cursor-pointer rounded-[4px] border px-2 font-rv-mono text-[12px] transition",
        "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:bg-rv-c3 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-rv-c2",
      )}
    >
      {children}
    </button>
  );
}
