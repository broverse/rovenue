import { useId, useState } from "react";
import {
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
import { useTranslation } from "react-i18next";
import { AlertTriangle, KeyRound } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { CopyButton } from "../../ui/copy-button";
import type { CreateMcpTokenResponse } from "../../lib/hooks/useMcpTokens";
import { useCreateMcpToken } from "../../lib/hooks/useMcpTokens";

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

export function CreateMcpTokenDialog({ projectId, open, onClose }: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  const scopeId = useId();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"read" | "read_write">("read");
  const [created, setCreated] = useState<CreateMcpTokenResponse | null>(null);
  const { mutate, isPending, error, reset } = useCreateMcpToken(projectId);

  const canSubmit = label.trim().length > 0 && !isPending;

  function close() {
    setLabel("");
    setScope("read");
    setCreated(null);
    reset();
    onClose();
  }

  function handleCreate() {
    if (!canSubmit) return;
    mutate(
      { label: label.trim(), scope },
      { onSuccess: (res) => setCreated(res) },
    );
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !isPending) close();
      }}
    >
      <ModalBackdrop variant="blur" isDismissable={!isPending}>
        <ModalContainer size="sm" placement="center">
          <ModalDialog>
            <ModalHeader className="items-center gap-3">
              <ModalIcon className="bg-primary-100 text-primary-500">
                {created ? <AlertTriangle size={18} /> : <KeyRound size={18} />}
              </ModalIcon>
              <ModalHeading>
                {created ? t("mcp.dialog.createdTitle") : t("mcp.dialog.title")}
              </ModalHeading>
            </ModalHeader>

            {created ? (
              <>
                <ModalBody className="gap-3">
                  <div className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700">
                    {t("mcp.dialog.secretWarning")}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] font-medium text-rv-mute-500">
                      {t("mcp.dialog.secretLabel")}
                    </span>
                    <div className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
                      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                        {created.token}
                      </code>
                      <CopyButton value={created.token} size="xs" />
                    </div>
                  </div>
                </ModalBody>
                <ModalFooter>
                  <Button variant="solid-primary" onClick={close}>
                    {t("mcp.dialog.done")}
                  </Button>
                </ModalFooter>
              </>
            ) : (
              <>
                <ModalBody className="gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={labelId} className="text-[12px] font-medium text-rv-mute-500">
                      {t("mcp.dialog.labelLabel")}
                    </label>
                    <Input
                      id={labelId}
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder={t("mcp.dialog.labelPlaceholder")}
                      disabled={isPending}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={scopeId} className="text-[12px] font-medium text-rv-mute-500">
                      {t("mcp.dialog.scopeLabel")}
                    </label>
                    <NativeSelect
                      id={scopeId}
                      value={scope}
                      onChange={(e) => setScope(e.target.value as "read" | "read_write")}
                      disabled={isPending}
                    >
                      <option value="read">{t("mcp.tokens.scopes.read")}</option>
                      <option value="read_write">{t("mcp.tokens.scopes.read_write")}</option>
                    </NativeSelect>
                    <p className="text-[12px] leading-relaxed text-rv-mute-500">
                      {t("mcp.dialog.scopeHint")}
                    </p>
                  </div>
                  {error && (
                    <div className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700">
                      {error instanceof Error ? error.message : t("mcp.dialog.failed")}
                    </div>
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button variant="flat" onClick={close} disabled={isPending}>
                    {t("common.cancel", "Cancel")}
                  </Button>
                  <Button
                    variant="solid-primary"
                    onClick={handleCreate}
                    disabled={!canSubmit}
                  >
                    {t("mcp.dialog.create")}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
