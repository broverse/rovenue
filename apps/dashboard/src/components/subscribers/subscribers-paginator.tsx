import { Trans, useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

type Props = {
  from: number;
  to: number;
  total: number;
  /** Currently-active page (1-based). */
  page: number;
  totalPages: number;
  onPageChange: (next: number) => void;
};

/**
 * Static pagination strip — designed to mimic the prototype's compact
 * `‹ 1 2 3 … 248 ›` style. Page numbers are computed as a sliding window
 * around the active page so it behaves at any total.
 */
export function SubscribersPaginator({
  from,
  to,
  total,
  page,
  totalPages,
  onPageChange,
}: Props) {
  const { t } = useTranslation();
  const numbers = pageNumbers(page, totalPages);
  return (
    <div className="flex items-center justify-between border-t border-rv-divider px-3.5 py-2.5 text-[12px] text-rv-mute-600">
      <span>
        <Trans
          i18nKey="subscribers.paginator.showing"
          values={{ from, to, total: total.toLocaleString() }}
          components={{
            0: <span className="font-rv-mono text-foreground" />,
          }}
        />
      </span>
      <div className="flex gap-1">
        <PgButton
          ariaLabel={t("subscribers.paginator.previous")}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          ‹
        </PgButton>
        {numbers.map((n, i) =>
          n === "…" ? (
            <PgButton key={`gap-${i}`} disabled>
              …
            </PgButton>
          ) : (
            <PgButton key={n} active={n === page} onClick={() => onPageChange(n)}>
              {n}
            </PgButton>
          ),
        )}
        <PgButton
          ariaLabel={t("subscribers.paginator.next")}
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          ›
        </PgButton>
      </div>
    </div>
  );
}

function PgButton({
  active,
  disabled,
  ariaLabel,
  onClick,
  children,
}: {
  active?: boolean;
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
        active
          ? "border-rv-accent-500 bg-rv-accent-500 text-white"
          : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:bg-rv-c3 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-rv-c2",
      )}
    >
      {children}
    </button>
  );
}

/** Returns at most 7 entries: 1 … active±1 … last. */
function pageNumbers(active: number, total: number): ReadonlyArray<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: Array<number | "…"> = [1];
  const start = Math.max(2, active - 1);
  const end = Math.min(total - 1, active + 1);
  if (start > 2) out.push("…");
  for (let p = start; p <= end; p += 1) out.push(p);
  if (end < total - 1) out.push("…");
  out.push(total);
  return out;
}
