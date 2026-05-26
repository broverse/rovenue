import { useState } from "react";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Chip } from "../../../../../ui/chip";
import { Button } from "../../../../../ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTriggerButton } from "../../../../../ui/menu";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useSession } from "../../../../../lib/auth";
import {
  useProjectMembers,
  useProjectInvitations,
  useUpdateMemberRole,
  useRemoveMember,
  useLeaveProject,
  useTransferOwnership,
  useRevokeInvitation,
  useResendInvitation,
} from "../../../../../lib/hooks/useProjectAdmin";
import { InviteMemberDialog } from "../../../../../components/projects/InviteMemberDialog";
import {
  ASSIGNABLE_ROLES,
  type MemberRoleName,
} from "@rovenue/shared";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/members",
)({
  component: MembersRoute,
});

function MembersRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/members",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <MembersPage projectId={projectId} />;
}

function MembersPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const callerUserId = session?.user?.id;

  const { data: members = [], isLoading } = useProjectMembers(projectId);
  const { data: invitations = [] } = useProjectInvitations(projectId);

  const callerRole = members.find((m) => m.userId === callerUserId)?.role as
    | MemberRoleName
    | undefined;
  const canManage = callerRole === "OWNER" || callerRole === "ADMIN";
  const canTransfer = callerRole === "OWNER";

  const [inviteOpen, setInviteOpen] = useState(false);
  const updateRole = useUpdateMemberRole();
  const remove = useRemoveMember();
  const leave = useLeaveProject();
  const transfer = useTransferOwnership();
  const revoke = useRevokeInvitation();
  const resend = useResendInvitation();

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("members.title")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t("members.subtitle")}
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setInviteOpen(true)}>
            + {t("members.invite.cta")}
          </Button>
        )}
      </header>

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="grid grid-cols-[minmax(0,1fr)_160px_160px_40px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("members.cols.user")}</span>
          <span>{t("members.cols.role")}</span>
          <span>{t("members.cols.since")}</span>
          <span />
        </div>
        {isLoading && members.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : members.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("members.empty")}
          </div>
        ) : (
          members.map((m) => {
            const isSelf = m.userId === callerUserId;
            const isOwner = m.role === "OWNER";
            const canEditThis = canManage && !isSelf && !isOwner;
            const canTransferToThis = canTransfer && !isSelf && !isOwner;
            const showMenu =
              canEditThis ||
              canTransferToThis ||
              (isSelf && callerRole !== "OWNER");
            return (
              <div
                key={m.id}
                className="grid grid-cols-[minmax(0,1fr)_160px_160px_40px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {m.image ? (
                    <img
                      src={m.image}
                      alt=""
                      className="h-6 w-6 shrink-0 rounded-full"
                    />
                  ) : (
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rv-c3 text-[10px] font-medium text-rv-mute-700">
                      {(m.name ?? m.email).slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {m.name ?? m.email}
                    </div>
                    {m.name && (
                      <div className="truncate text-[11px] text-rv-mute-500">
                        {m.email}
                      </div>
                    )}
                  </div>
                </div>
                <Chip
                  tone={
                    isOwner
                      ? "primary"
                      : m.role === "ADMIN"
                        ? "warning"
                        : "default"
                  }
                >
                  {t(`members.role.${m.role.toLowerCase()}`, m.role)}
                </Chip>
                <span className="font-rv-mono text-rv-mute-500">
                  {new Date(m.createdAt).toLocaleDateString()}
                </span>
                <div className="flex justify-end">
                  {showMenu && (
                    <Menu
                      trigger={(_open) => (
                        <MenuTriggerButton ariaLabel="Member actions">
                          ⋯
                        </MenuTriggerButton>
                      )}
                    >
                      {(close) => (
                        <>
                          {canEditThis &&
                            ASSIGNABLE_ROLES.filter((r) => r !== m.role).map(
                              (r) => (
                                <MenuItem
                                  key={r}
                                  onClick={() => {
                                    updateRole.mutate({
                                      projectId,
                                      userId: m.userId,
                                      role: r,
                                    });
                                    close();
                                  }}
                                >
                                  {t("members.actions.changeRole")} →{" "}
                                  {t(`members.role.${r.toLowerCase()}`)}
                                </MenuItem>
                              ),
                            )}
                          {canEditThis && <MenuSeparator />}
                          {canEditThis && (
                            <MenuItem
                              onClick={() => {
                                if (
                                  window.confirm(
                                    t("members.remove.title", { name: m.name ?? m.email }),
                                  )
                                ) {
                                  remove.mutate({
                                    projectId,
                                    userId: m.userId,
                                  });
                                }
                                close();
                              }}
                            >
                              {t("members.actions.remove")}
                            </MenuItem>
                          )}
                          {canTransferToThis && (
                            <MenuItem
                              onClick={() => {
                                if (
                                  window.confirm(t("members.transfer.warning"))
                                ) {
                                  transfer.mutate({
                                    projectId,
                                    toUserId: m.userId,
                                  });
                                }
                                close();
                              }}
                            >
                              {t("members.actions.transfer")}
                            </MenuItem>
                          )}
                          {isSelf && callerRole !== "OWNER" && (
                            <MenuItem
                              onClick={async () => {
                                if (
                                  window.confirm(t("members.leave.title"))
                                ) {
                                  await leave.mutateAsync({ projectId });
                                  navigate({ to: "/projects" });
                                }
                                close();
                              }}
                            >
                              {t("members.actions.leave")}
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Menu>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {invitations.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-[14px] font-semibold">
            {t("members.invitations.title")}
          </h2>
          <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
            <div className="grid grid-cols-[minmax(0,1fr)_160px_140px_120px_40px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
              <span>{t("members.cols.email")}</span>
              <span>{t("members.cols.role")}</span>
              <span>{t("members.cols.expires")}</span>
              <span>{t("members.cols.status")}</span>
              <span />
            </div>
            {invitations.map((inv) => {
              const daysLeft = Math.max(
                0,
                Math.ceil(
                  (new Date(inv.expiresAt).getTime() - Date.now()) /
                    86_400_000,
                ),
              );
              const isBounced =
                inv.deliveryStatus === "BOUNCED" ||
                inv.deliveryStatus === "COMPLAINED" ||
                inv.deliveryStatus === "SUPPRESSED";
              const statusKey = isBounced
                ? inv.deliveryStatus.toLowerCase()
                : inv.status;
              const statusTone: "primary" | "warning" | "default" | "danger" =
                isBounced ? "danger" : "default";
              return (
                <div
                  key={inv.id}
                  className="grid grid-cols-[minmax(0,1fr)_160px_140px_120px_40px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0"
                >
                  <span className="truncate">{inv.email}</span>
                  <Chip>
                    {t(`members.role.${inv.role.toLowerCase()}`, inv.role)}
                  </Chip>
                  <span className="text-rv-mute-500">
                    {t("members.invitations.expiresIn", { count: daysLeft })}
                  </span>
                  <Chip tone={statusTone}>
                    {t(`members.invitations.status.${statusKey}`, statusKey)}
                  </Chip>
                  <div className="flex justify-end">
                    {canManage && inv.status === "pending" && (
                      <Menu
                        trigger={(_open) => (
                          <MenuTriggerButton ariaLabel="Invitation actions">
                            ⋯
                          </MenuTriggerButton>
                        )}
                      >
                        {(close) => (
                          <>
                            <MenuItem
                              onClick={() => {
                                resend.mutate({
                                  projectId,
                                  invitationId: inv.id,
                                });
                                close();
                              }}
                            >
                              {t("members.actions.resend")}
                            </MenuItem>
                            <MenuItem
                              onClick={() => {
                                if (
                                  window.confirm(
                                    t("members.actions.revoke") + "?",
                                  )
                                ) {
                                  revoke.mutate({
                                    projectId,
                                    invitationId: inv.id,
                                  });
                                }
                                close();
                              }}
                            >
                              {t("members.actions.revoke")}
                            </MenuItem>
                          </>
                        )}
                      </Menu>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <InviteMemberDialog
        projectId={projectId}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </>
  );
}
