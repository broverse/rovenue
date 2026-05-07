import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { MemberRow } from "./member-row";
import { StepHead } from "./step-head";
import { ROLES } from "./mock-data";
import { guessNameFromEmail } from "./format";
import type { RoleId, SetupForm, SetupMember } from "./types";

type StepTeamProps = {
  form: SetupForm;
  onUpdate: <Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) => void;
};

export function StepTeam({ form, onUpdate }: StepTeamProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ email: string; role: RoleId }>({
    email: "",
    role: "analyst",
  });

  const addMember = () => {
    if (!draft.email.includes("@")) return;
    if (form.members.some((member) => member.email === draft.email)) {
      setDraft({ email: "", role: "analyst" });
      return;
    }
    const member: SetupMember = {
      email: draft.email,
      role: draft.role,
      name: guessNameFromEmail(draft.email),
    };
    onUpdate("members", [...form.members, member]);
    setDraft({ email: "", role: "analyst" });
  };

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.team.eyebrow")}
        title={t("projectSetup.team.title")}
        description={t("projectSetup.team.description")}
      />

      <div className="mb-5 flex gap-2">
        <Input
          type="email"
          className="flex-1"
          placeholder={t("projectSetup.team.emailPlaceholder")}
          value={draft.email}
          onChange={(event) =>
            setDraft((current) => ({ ...current, email: event.target.value }))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addMember();
            }
          }}
        />
        <Select
          value={draft.role}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              role: event.target.value as RoleId,
            }))
          }
          className="w-[140px]"
        >
          {ROLES.map((role) => (
            <option key={role.id} value={role.id}>
              {t(`projectSetup.roles.${role.id}.name`)}
            </option>
          ))}
        </Select>
        <Button type="button" variant="solid-primary" onClick={addMember}>
          <Plus className="size-3.5" aria-hidden="true" />
          {t("projectSetup.team.invite")}
        </Button>
      </div>

      {form.members.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-rv-divider bg-rv-c1">
          {form.members.map((member, index) => (
            <MemberRow
              key={`${member.email}-${index}`}
              member={member}
              index={index}
              isLast={index === form.members.length - 1}
              onRoleChange={(role) =>
                onUpdate(
                  "members",
                  form.members.map((existing, idx) =>
                    idx === index ? { ...existing, role } : existing,
                  ),
                )
              }
              onRemove={() =>
                onUpdate(
                  "members",
                  form.members.filter((_, idx) => idx !== index),
                )
              }
            />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-rv-divider px-4 py-3.5 text-center text-[12px] text-rv-mute-500">
          {t("projectSetup.team.empty")}
        </div>
      )}

      <div className="mt-6">
        <h4 className="mb-2.5 text-[12px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("projectSetup.team.roleReference")}
        </h4>
        {ROLES.map((role) => (
          <div
            key={role.id}
            className="grid grid-cols-[120px_1fr] gap-3 border-b border-white/5 py-2 text-[12px] last:border-b-0"
          >
            <div className="font-medium text-foreground">
              {t(`projectSetup.roles.${role.id}.name`)}
            </div>
            <div className="text-rv-mute-600">
              {t(`projectSetup.roles.${role.id}.desc`)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
