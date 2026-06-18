import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { cn } from "../../lib/cn";
import { useCreateInvitation } from "../../lib/hooks/useProjectAdmin";

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

interface InviteSuccess {
  inviteUrl: string;
  email: string;
  refreshed: boolean;
}

export function InviteMemberDialog({ projectId, open, onClose }: Props) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("DEVELOPER");
  const [success, setSuccess] = useState<InviteSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useCreateInvitation();

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setRole("DEVELOPER");
    setSuccess(null);
    setError(null);
    setCopied(false);
  }, [open]);

  const submit = async () => {
    setError(null);
    if (!email) return;
    try {
      const res = await create.mutateAsync({
        projectId,
        email: email.trim().toLowerCase(),
        role,
      });
      setSuccess({
        inviteUrl: res.inviteUrl,
        email: res.invitation.email,
        refreshed: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("ALREADY_MEMBER")) {
        setError(t("members.invite.errors.already_member"));
      } else {
        setError(msg || t("members.invite.errors.unknown"));
      }
    }
  };

  const copyInviteUrl = () => {
    if (!success) return;
    navigator.clipboard.writeText(success.inviteUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const idEmail = useId();
  const idRole = useId();

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("members.invite.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {success
                  ? t("members.invite.successSubtitle")
                  : t("members.invite.subtitle")}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          {success ? (
            <div className="space-y-3 px-5 py-4">
              {success.refreshed && (
                <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[12px] text-rv-mute-700">
                  {t("members.invite.refreshedBanner")}
                </div>
              )}
              <p className="text-[13px]">
                {t("members.invite.successBody", { email: success.email })}
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={success.inviteUrl}
                  readOnly
                  className="flex-1 font-rv-mono text-[11px]"
                />
                <Button variant="flat" onClick={copyInviteUrl}>
                  {copied
                    ? t("members.invite.copied")
                    : t("members.invite.copyLink")}
                </Button>
              </div>
              <div className="flex justify-end pt-2">
                <Button variant="flat" onClick={onClose}>
                  {t("common.done")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 px-5 py-4">
              <div>
                <label
                  htmlFor={idEmail}
                  className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
                >
                  {t("members.invite.emailLabel")}
                </label>
                <Input
                  id={idEmail}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("members.invite.emailPlaceholder")}
                />
              </div>
              <div>
                <label
                  htmlFor={idRole}
                  className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
                >
                  {t("members.invite.roleLabel")}
                </label>
                <NativeSelect
                  id={idRole}
                  value={role}
                  onChange={(e) =>
                    setRole(e.currentTarget.value as AssignableRole)
                  }
                >
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`members.role.${r.toLowerCase()}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {error && (
                <div className="text-[12px] text-rv-danger">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="light" onClick={onClose}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="solid-primary"
                  onClick={submit}
                  disabled={create.isPending || !email}
                >
                  {create.isPending
                    ? t("common.loading")
                    : t("members.invite.submit")}
                </Button>
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
