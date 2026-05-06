import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { IconProps } from "./icons";

type Common = {
  icon: ComponentType<IconProps>;
  label: string;
  badge?: string;
  badgeLive?: boolean;
  active?: boolean;
};

type SidebarNavLinkProps =
  | (Common & { kind: "link"; to: string; params?: Record<string, string>; exact?: boolean })
  | (Common & { kind: "soon" });

const baseClass =
  "group relative flex h-[30px] cursor-pointer items-center gap-2.5 rounded-md px-3 text-[13px] text-rv-mute-600 select-none transition hover:bg-rv-c2 hover:text-rv-mute-800";

const activeClass = "bg-rv-c2 text-foreground before:absolute before:-left-2 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-r before:bg-rv-accent-500";

/**
 * One row in the sidebar nav. Renders a TanStack `<Link>` for routable items
 * and a non-interactive row with a `soon` badge for everything else.
 */
export function SidebarNavLink(props: SidebarNavLinkProps) {
  const { t } = useTranslation();
  const { icon: Icon, label, badge, badgeLive, active } = props;

  const inner = (
    <>
      <Icon size={15} className="shrink-0 opacity-90" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badgeLive && (
        <span className="ml-auto rounded-full bg-rv-success/15 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-success">
          {badge ?? "·"}
        </span>
      )}
      {!badgeLive && badge && (
        <span className="ml-auto rounded-full bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
          {badge}
        </span>
      )}
      {props.kind === "soon" && !badge && (
        <span className="ml-auto rounded-full bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-500">
          {t("common.soon")}
        </span>
      )}
    </>
  );

  if (props.kind === "link") {
    return (
      <Link
        to={props.to}
        params={props.params}
        activeOptions={props.exact ? { exact: true } : undefined}
        activeProps={{ className: `${baseClass} ${activeClass}` }}
        className={baseClass}
      >
        {inner}
      </Link>
    );
  }

  return (
    <div
      className={`${baseClass} ${active ? activeClass : ""} cursor-not-allowed opacity-70`}
      aria-disabled="true"
      title={t("common.comingSoon")}
    >
      {inner}
    </div>
  );
}
