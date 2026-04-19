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
import { useRotateWebhookSecret } from "../../lib/hooks/useRotateWebhookSecret";

interface Props {
  projectId: string;
}

export function RotateSecretDialog({ projectId }: Props) {
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
        Rotate webhook secret
      </Button>

      <Modal isOpen={open}>
        <ModalBackdrop isDismissable={revealed === null && !isPending}>
          <ModalContainer>
            <ModalDialog>
              {revealed === null ? (
                <>
                  <ModalHeader>Rotate webhook secret?</ModalHeader>
                  <ModalBody className="gap-3">
                    <p className="text-sm text-default-500">
                      This invalidates the current secret immediately. Any
                      webhook delivery signed with the old secret will fail
                      verification until you update the receiving endpoint.
                    </p>
                    {error && (
                      <div role="alert" className="text-sm text-danger-500">
                        {error.message}
                      </div>
                    )}
                  </ModalBody>
                  <ModalFooter>
                    <Button variant="ghost" onPress={close} isDisabled={isPending}>
                      Cancel
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
                      Rotate secret
                    </Button>
                  </ModalFooter>
                </>
              ) : (
                <>
                  <ModalHeader>Copy the new secret</ModalHeader>
                  <ModalBody className="gap-3">
                    <p className="text-sm text-default-500">
                      This is the only time we'll show the secret. Store it in
                      your deployment secrets before closing this dialog.
                    </p>
                    <pre className="overflow-x-auto rounded bg-default-100 p-3 font-mono text-xs">
                      {revealed}
                    </pre>
                  </ModalBody>
                  <ModalFooter>
                    <Button variant="primary" onPress={close}>
                      I've copied it
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
