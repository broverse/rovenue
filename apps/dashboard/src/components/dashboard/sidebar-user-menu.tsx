import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import { MoreHorizontal, UserCog } from "lucide-react";
import { signOut, useSession } from "../../lib/auth";
import { ThemeToggle } from "../layout/ThemeToggle";

type Props = {
  initials: string;
  name: string;
  role?: string;
};

/**
 * Sidebar footer entry — avatar, name, role. Click reveals a Base UI menu
 * with theme toggle + sign out.
 */
export function SidebarUserMenu({ initials, name, role }: Props) {
  const { t } = useTranslation();
  const { data } = useSession();
  const navigate = useNavigate();
  const resolvedRole = role ?? t("common.member");

  return (
    <Menu.Root>
      <Menu.Trigger className="flex w-full cursor-pointer items-center gap-2.5 rounded-md p-2 text-left transition hover:bg-rv-c2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-rv-warning to-pink-500 text-[10px] font-semibold text-white">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-rv-mute-800">{name}</div>
          <div className="text-[12px] text-rv-mute-500">{resolvedRole}</div>
        </div>
        <MoreHorizontal size={14} className="text-rv-mute-500" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} side="top" align="start" className="z-50 w-[var(--anchor-width)]">
          <Menu.Popup className="min-w-[200px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            <div className="px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-rv-mute-500">
              {data?.user.email ?? name}
            </div>
            <div className="flex items-center justify-between rounded px-2 py-1 text-[13px] text-rv-mute-700">
              <span>{t("common.theme")}</span>
              <ThemeToggle />
            </div>
            <div className="my-1 h-px bg-rv-divider" />
            <Menu.Item
              onClick={() => navigate({ to: "/account/profile" })}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground"
            >
              <UserCog size={13} />
              {t("account.nav.items.profile")}
            </Menu.Item>
            <Menu.Item
              onClick={async () => {
                await signOut();
                await navigate({ to: "/login", search: { error: undefined } });
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground"
            >
              {t("common.signOut")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
