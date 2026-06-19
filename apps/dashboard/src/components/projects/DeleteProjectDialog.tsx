import { useId, useState } from "react";
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  ModalIcon,
} from "@heroui/react";
import { useNavigate } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Input } from "../../ui/input";
import { useDeleteProject } from "../../lib/hooks/useDeleteProject";

interface Props {
  projectId: string;
  projectName: string;
}

export function DeleteProjectDialog({ projectId, projectName }: Props) {
  const { t } = useTranslation();
  const confirmId = useId();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const navigate = useNavigate();
  const { mutate, isPending, error, reset } = useDeleteProject();

  const canDelete = confirmText === projectName && !isPending;

  function close() {
    setOpen(false);
    setConfirmText("");
    reset();
  }

  function handleDelete() {
    if (!canDelete) return;
    mutate(projectId, {
      onSuccess: () => {
        try {
          localStorage.removeItem("lastProjectId");
        } catch {
          // ignore storage failures
        }
        close();
        void navigate({ to: "/" });
      },
    });
  }

  return (
    <>
      <Button variant="danger" onPress={() => setOpen(true)}>
        {t("projects.delete.trigger")}
      </Button>

      <Modal
        isOpen={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else if (!isPending) close();
        }}
      >
        <ModalBackdrop variant="blur" isDismissable={!isPending}>
          <ModalContainer size="sm" placement="center">
            <ModalDialog>
              <ModalHeader className="items-center gap-3">
                <ModalIcon className="bg-danger-100 text-danger-500">
                  <AlertTriangle size={18} />
                </ModalIcon>
                <ModalHeading>{t("projects.delete.header")}</ModalHeading>
              </ModalHeader>
              <ModalBody className="gap-4">
                <p className="text-sm leading-relaxed text-default-500">
                  <Trans
                    i18nKey="projects.delete.body"
                    values={{ name: projectName }}
                    components={[<span key="n" className="font-semibold text-foreground" />]}
                  />
                </p>
                <div>
                  <label
                    htmlFor={confirmId}
                    className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-default-500"
                  >
                    {t("projects.delete.confirmLabel")}
                  </label>
                  <Input
                    id={confirmId}
                    mono
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleDelete();
                    }}
                    placeholder={projectName}
                    autoComplete="off"
                    autoFocus
                  />
                  <p className="mt-2 text-[11px] leading-5 text-default-500">
                    <Trans
                      i18nKey="projects.delete.confirmDescription"
                      values={{ name: projectName }}
                      components={[<span key="n" className="font-mono text-foreground" />]}
                    />
                  </p>
                </div>
                {error && (
                  <div
                    role="alert"
                    className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-600"
                  >
                    {error.message}
                  </div>
                )}
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onPress={close} isDisabled={isPending}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  isPending={isPending}
                  isDisabled={!canDelete}
                  onPress={handleDelete}
                >
                  {t("projects.delete.confirm")}
                </Button>
              </ModalFooter>
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </>
  );
}
