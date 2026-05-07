import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ACCOUNT_NAV, type AccountTabId } from "./account-nav-config";
import { cn } from "../../lib/cn";

const baseRow =
  "group relative mb-px flex h-8 cursor-pointer items-center gap-2.5 rounded-[5px] px-2.5 text-[13px] text-rv-mute-700 transition hover:bg-rv-c2";
const activeRow = "bg-rv-accent-500/15 text-rv-accent-400";

type AccountNavProps = {
  active: AccountTabId;
};

export function AccountNav({ active }: AccountNavProps) {
  const { t } = useTranslation();

  return (
    <aside
      aria-label={t("account.nav.aria")}
      className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-rv-divider bg-rv-c1 px-4 py-6 md:block"
    >
      {ACCOUNT_NAV.map((group, idx) => (
        <div key={group.key}>
          <div
            className={cn(
              "px-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
              idx === 0 ? "mb-1.5" : "mb-1.5 mt-3.5",
            )}
          >
            {t(`account.nav.sections.${group.key}`)}
          </div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === active;
            return (
              <Link
                key={item.id}
                to={`/account/${item.path}`}
                className={cn(baseRow, isActive && activeRow)}
              >
                <Icon size={14} className="shrink-0" />
                <span className="flex-1">{t(item.labelKey)}</span>
                {item.badge ? (
                  <span
                    className={cn(
                      "rounded-[3px] px-1.5 py-px font-rv-mono text-[10px]",
                      isActive
                        ? "bg-rv-accent-500/20 text-rv-accent-400"
                        : "bg-rv-c3 text-rv-mute-500",
                    )}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

/**
 * Mobile/tablet variant — horizontally scrollable strip shown above
 * the main content when the sidebar is hidden.
 */
export function AccountNavMobile({ active }: AccountNavProps) {
  const { t } = useTranslation();
  const items = ACCOUNT_NAV.flatMap((g) => g.items);

  return (
    <div className="md:hidden flex gap-1 overflow-x-auto border-b border-rv-divider bg-rv-c1 px-3 py-2">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === active;
        return (
          <Link
            key={item.id}
            to={`/account/${item.path}`}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-rv-mute-700 transition hover:bg-rv-c2",
              isActive && "bg-rv-accent-500/15 text-rv-accent-400",
            )}
          >
            <Icon size={13} />
            {t(item.labelKey)}
          </Link>
        );
      })}
    </div>
  );
}
