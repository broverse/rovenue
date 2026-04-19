import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Button,
  Card,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { TopNav } from "../../components/layout/TopNav";
import { CreateProjectForm } from "../../components/projects/CreateProjectForm";
import type { CreateProjectResponse } from "@rovenue/shared";

export const Route = createFileRoute("/_authed/projects/new")({
  component: NewProjectPage,
});

function NewProjectPage() {
  const navigate = useNavigate();
  const [result, setResult] = useState<CreateProjectResponse | null>(null);

  return (
    <>
      <TopNav />
      <div className="mx-auto max-w-md px-6 py-8">
        <Card className="p-6">
          <h1 className="mb-4 text-xl font-semibold">New project</h1>
          <CreateProjectForm onCreated={setResult} />
        </Card>
      </div>

      <Modal isOpen={result !== null}>
        <ModalBackdrop isDismissable={false}>
          <ModalContainer>
            <ModalDialog>
              <ModalHeader>Save your API keys</ModalHeader>
              <ModalBody className="gap-4">
                <p className="text-sm text-default-500">
                  These are shown only once. Copy them now — you can always
                  rotate the webhook secret later from project settings.
                </p>
                <div>
                  <div className="text-xs font-medium text-default-500">
                    Public key
                  </div>
                  <pre className="mt-1 overflow-x-auto rounded bg-default-100 p-2 font-mono text-xs">
                    {result?.apiKey.publicKey ?? ""}
                  </pre>
                </div>
                <div>
                  <div className="text-xs font-medium text-default-500">
                    Secret key
                  </div>
                  <pre className="mt-1 overflow-x-auto rounded bg-default-100 p-2 font-mono text-xs">
                    {result?.apiKey.secretKey ?? ""}
                  </pre>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button
                  variant="primary"
                  onPress={() => {
                    if (!result) return;
                    localStorage.setItem("lastProjectId", result.project.id);
                    navigate({
                      to: "/projects/$projectId",
                      params: { projectId: result.project.id },
                    });
                  }}
                >
                  I've copied them, take me to the project
                </Button>
              </ModalFooter>
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </>
  );
}
