import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { initials } from "./format";
import { ROLES } from "./mock-data";
import type { RoleId, SetupMember } from "./types";

type MemberRowProps = {
  member: SetupMember;
  index: number;
  isLast: boolean;
  onRoleChange: (role: RoleId) => void;
  onRemove: () => void;
};

export function MemberRow({
  member,
  index,
  isLast,
  onRoleChange,
  onRemove,
}: MemberRowProps) {
  const { t } = useTranslation();
  const display = member.name || member.email.split("@")[0];

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 ${
        isLast ? "" : "border-b border-rv-divider"
      }`}
    >
      <div
        className="flex size-[30px] shrink-0 items-center justify-center rounded-full font-rv-mono text-[11px] font-semibold text-white"
        style={{ background: `oklch(0.65 0.15 ${(index * 60) % 360})` }}
        aria-hidden="true"
      >
        {initials(display)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">
          {display}
        </div>
        <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
          {member.email}
        </div>
      </div>
      <Select
        value={member.role}
        onChange={(event) => onRoleChange(event.target.value as RoleId)}
        className="h-8 w-[132px] py-1 pr-7 text-[12px]"
      >
        {ROLES.map((role) => (
          <option key={role.id} value={role.id}>
            {t(`projectSetup.roles.${role.id}.name`)}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        variant="light"
        size="icon"
        onClick={onRemove}
        aria-label={t("projectSetup.team.remove")}
      >
        <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </Button>
    </div>
  );
}
