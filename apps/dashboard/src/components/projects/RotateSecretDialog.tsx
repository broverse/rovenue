import { useState } from "react";
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { useTranslation } from "react-i18next";
import { useRotateWebhookSecret } from "../../lib/hooks/useRotateWebhookSecret";

interface Props {
  projectId: string;
}

export function RotateSecretDialog({ projectId }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const { mutate, isPending, error, reset } = useRotateWebhookSecret(projectId);

  function close() {
    setOpen(false);
    setRevealed(null);
    reset();
  }

  return (
    <>
      <Button variant="outline" onPress={() => setOpen(true)}>
        {t("projects.rotateSecret.trigger")}
      </Button>

      <Modal isOpen={open}>
        <ModalBackdrop isDismissable={revealed === null && !isPending}>
          <ModalContainer>
            <ModalDialog>
              {revealed === null ? (
                <>
                  <ModalHeader>{t("projects.rotateSecret.header")}</ModalHeader>
                  <ModalBody className="gap-3">
                    <p className="text-sm text-default-500">{t("projects.rotateSecret.body")}</p>
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
                      onPress={() =>
                        mutate(undefined, {
                          onSuccess: (res) => setRevealed(res.webhookSecret),
                        })
                      }
                    >
                      {t("projects.rotateSecret.confirm")}
                    </Button>
                  </ModalFooter>
                </>
              ) : (
                <>
                  <ModalHeader>{t("projects.rotateSecret.copyHeader")}</ModalHeader>
                  <ModalBody className="gap-3">
                    <p className="text-sm text-default-500">{t("projects.rotateSecret.copyBody")}</p>
                    <pre className="overflow-x-auto rounded bg-default-100 p-3 font-mono text-xs">
                      {revealed}
                    </pre>
                  </ModalBody>
                  <ModalFooter>
                    <Button variant="primary" onPress={close}>
                      {t("projects.rotateSecret.copied")}
                    </Button>
                  </ModalFooter>
                </>
              )}
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </>
  );
}
