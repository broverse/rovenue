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
import { useTranslation } from "react-i18next";
import { TopNav } from "../../components/layout/TopNav";
import { CreateProjectForm } from "../../components/projects/CreateProjectForm";
import type { CreateProjectResponse } from "@rovenue/shared";

export const Route = createFileRoute("/_authed/projects/new")({
  component: NewProjectPage,
});

export function NewProjectPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [result, setResult] = useState<CreateProjectResponse | null>(null);

  return (
    <>
      <TopNav />
      <div className="mx-auto max-w-md px-6 py-8">
        <Card className="p-6">
          <h1 className="mb-4 text-xl font-semibold">{t("projects.new.title")}</h1>
          <CreateProjectForm onCreated={setResult} />
        </Card>
      </div>

      <Modal isOpen={result !== null}>
        <ModalBackdrop isDismissable={false}>
          <ModalContainer>
            <ModalDialog>
              <ModalHeader>{t("projects.new.saveKeysHeader")}</ModalHeader>
              <ModalBody className="gap-4">
                <p className="text-sm text-default-500">{t("projects.new.saveKeysBody")}</p>
                <div>
                  <div className="text-xs font-medium text-default-500">
                    {t("projects.new.publicKey")}
                  </div>
                  <pre className="mt-1 overflow-x-auto rounded bg-default-100 p-2 font-mono text-xs">
                    {result?.apiKey.publicKey ?? ""}
                  </pre>
                </div>
                <div>
                  <div className="text-xs font-medium text-default-500">
                    {t("projects.new.secretKey")}
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
                  {t("projects.new.copiedTakeMe")}
                </Button>
              </ModalFooter>
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </>
  );
}
