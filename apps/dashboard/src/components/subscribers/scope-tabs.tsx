import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { SubscriberScope } from "./types";

const SCOPES: ReadonlyArray<SubscriberScope> = [
  "all",
  "active",
  "trial",
  "grace",
  "churn",
  "vip",
  "risk",
];

type Props = {
  value: SubscriberScope;
  onChange: (next: SubscriberScope) => void;
  /** Display counts shown to the right of each label. */
  counts: Readonly<Record<SubscriberScope, string>>;
};

/** Segmented control with monospace count badges — matches the design's `.scope-tabs`. */
export function ScopeTabs({ value, onChange, counts }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label="scope"
      className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-[3px]"
    >
      {SCOPES.map((scope) => {
        const active = value === scope;
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
            {t(`subscribers.scope.${scope}`)}
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
