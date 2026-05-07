import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { SubscriptionScope } from "./types";

const SCOPES: ReadonlyArray<SubscriptionScope> = [
  "all",
  "active",
  "trial",
  "grace",
  "canceling",
  "issues",
  "churned",
];

type Props = {
  value: SubscriptionScope;
  onChange: (next: SubscriptionScope) => void;
  /** Display counts for each tab — already pre-formatted strings. */
  counts: Readonly<Record<SubscriptionScope, string>>;
};

/**
 * Segmented control mirroring the design's `.scope-tabs` — used to
 * filter the subscription list by lifecycle bucket.
 */
export function ScopeTabs({ value, onChange, counts }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t("subscriptions.scope.ariaLabel")}
      className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-[3px]"
    >
      {SCOPES.map((scope) => {
        const active = scope === value;
        return (
          <button
            key={scope}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(scope)}
            className={cn(
              "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded px-3 text-[12px] transition",
              active
                ? "bg-rv-c4 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.05)]"
                : "text-rv-mute-600 hover:text-foreground",
            )}
          >
            {t(`subscriptions.scope.${scope}`)}
            <span
              className={cn(
                "rounded-[3px] px-1 py-px font-rv-mono text-[10px] tabular-nums",
                active ? "bg-rv-c2 text-rv-mute-700" : "bg-rv-c3 text-rv-mute-500",
              )}
            >
              {counts[scope]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
