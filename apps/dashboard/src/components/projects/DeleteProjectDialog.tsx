import { useState } from "react";
import {
  Button,
  Description,
  Input,
  Label,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  TextField,
} from "@heroui/react";
import { useNavigate } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { useDeleteProject } from "../../lib/hooks/useDeleteProject";

interface Props {
  projectId: string;
  projectName: string;
}

export function DeleteProjectDialog({ projectId, projectName }: Props) {
  const { t } = useTranslation();
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

  return (
    <>
      <Button variant="danger" onPress={() => setOpen(true)}>
        {t("projects.delete.trigger")}
      </Button>

      <Modal isOpen={open}>
        <ModalBackdrop isDismissable={!isPending}>
          <ModalContainer>
            <ModalDialog>
              <ModalHeader>{t("projects.delete.header")}</ModalHeader>
              <ModalBody className="gap-3">
                <p className="text-sm text-default-500">
                  <Trans
                    i18nKey="projects.delete.body"
                    values={{ name: projectName }}
                    components={[<span key="n" className="font-semibold text-foreground" />]}
                  />
                </p>
                <TextField value={confirmText} onChange={setConfirmText}>
                  <Label>{t("projects.delete.confirmLabel")}</Label>
                  <Input placeholder={projectName} autoComplete="off" />
                  <Description>
                    <Trans
                      i18nKey="projects.delete.confirmDescription"
                      values={{ name: projectName }}
                      components={[<span key="n" className="font-mono" />]}
                    />
                  </Description>
                </TextField>
                {error && (
                  <div role="alert" className="text-sm text-danger-500">
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
                  onPress={() =>
                    mutate(projectId, {
                      onSuccess: () => {
                        try {
                          localStorage.removeItem("lastProjectId");
                        } catch {
                          // ignore storage failures
                        }
                        close();
                        void navigate({ to: "/projects" });
                      },
                    })
                  }
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
