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
import { useDeleteProject } from "../../lib/hooks/useDeleteProject";

interface Props {
  projectId: string;
  projectName: string;
}

export function DeleteProjectDialog({ projectId, projectName }: Props) {
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
        Delete project
      </Button>

      <Modal isOpen={open}>
        <ModalBackdrop isDismissable={!isPending}>
          <ModalContainer>
            <ModalDialog>
              <ModalHeader>Delete this project?</ModalHeader>
              <ModalBody className="gap-3">
                <p className="text-sm text-default-500">
                  This action is permanent. All subscribers, purchases, API
                  keys, and webhook configuration for{" "}
                  <span className="font-semibold text-foreground">
                    {projectName}
                  </span>{" "}
                  will be removed.
                </p>
                <TextField value={confirmText} onChange={setConfirmText}>
                  <Label>Type the project name to confirm</Label>
                  <Input placeholder={projectName} autoComplete="off" />
                  <Description>
                    Enter <span className="font-mono">{projectName}</span> exactly.
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
                  Cancel
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
                  Delete project
                </Button>
              </ModalFooter>
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </>
  );
}
