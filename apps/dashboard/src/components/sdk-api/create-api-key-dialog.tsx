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
import { useTranslation } from "react-i18next";
import { AlertTriangle, KeyRound } from "lucide-react";
import type { CreateApiKeyResponse } from "@rovenue/shared";
import { Input } from "../../ui/input";
import { CopyButton } from "../../ui/copy-button";
import { useCreateApiKey } from "../../lib/hooks/useCreateApiKey";

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

export function CreateApiKeyDialog({ projectId, open, onClose }: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const { mutate, isPending, error, reset } = useCreateApiKey(projectId);

  const canSubmit = label.trim().length > 0 && !isPending;

  function close() {
    setLabel("");
    setCreated(null);
    reset();
    onClose();
  }

  function handleCreate() {
    if (!canSubmit) return;
    mutate(
      { label: label.trim() },
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
                {created
                  ? t("sdkApi.keys.dialog.createdTitle")
                  : t("sdkApi.keys.dialog.title")}
              </ModalHeading>
            </ModalHeader>

            {created ? (
              <>
                <ModalBody className="gap-3">
                  <div className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700">
                    {t("sdkApi.keys.dialog.secretWarning")}
                  </div>
                  <SecretReveal
                    label={t("sdkApi.keys.dialog.publishableLabel")}
                    value={created.apiKey.publicKey}
                    copyLabel={t("sdkApi.copy.idle")}
                    copiedLabel={t("sdkApi.copy.copied")}
                  />
                  <SecretReveal
                    label={t("sdkApi.keys.dialog.secretLabel")}
                    value={created.secretKey}
                    copyLabel={t("sdkApi.copy.idle")}
                    copiedLabel={t("sdkApi.copy.copied")}
                  />
                </ModalBody>
                <ModalFooter>
                  <Button variant="primary" onPress={close}>
                    {t("sdkApi.keys.dialog.done")}
                  </Button>
                </ModalFooter>
              </>
            ) : (
              <>
                <ModalBody className="gap-3">
                  <div>
                    <label
                      htmlFor={labelId}
                      className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-default-500"
                    >
                      {t("sdkApi.keys.dialog.labelField")}
                    </label>
                    <Input
                      id={labelId}
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreate();
                      }}
                      placeholder={t("sdkApi.keys.dialog.labelPlaceholder")}
                      autoComplete="off"
                      autoFocus
                      maxLength={60}
                    />
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
                    variant="primary"
                    isPending={isPending}
                    isDisabled={!canSubmit}
                    onPress={handleCreate}
                  >
                    {t("sdkApi.keys.dialog.create")}
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

function SecretReveal({
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-default-500">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="block min-w-0 flex-1 truncate rounded border border-default-200 bg-default-100 px-2 py-1.5 font-mono text-[11.5px]">
          {value}
        </code>
        <CopyButton size="sm" value={value} label={copyLabel} copiedLabel={copiedLabel} />
      </div>
    </div>
  );
}
