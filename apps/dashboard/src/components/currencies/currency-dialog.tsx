import { useEffect, useId, useState } from "react";
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
import { Coins, Crown, Diamond, Gem, type LucideIcon } from "lucide-react";
import type { VirtualCurrency } from "@rovenue/shared";
import { Input } from "../../ui/input";
import {
  useCreateVirtualCurrency,
  useRenameVirtualCurrency,
} from "../../lib/hooks/useVirtualCurrencies";

interface Props {
  projectId: string;
  open: boolean;
  /** When set the dialog renames this currency; otherwise it creates one. */
  currency?: VirtualCurrency | null;
  onClose: () => void;
}

// Mirrors the shared `currencyCode` zod rule: 2–8 chars, uppercase
// alphanumeric, must start with a letter. Validated client-side so the
// submit button only enables on a value the server will accept.
const CODE_RE = /^[A-Z][A-Z0-9]{1,7}$/;

// One-tap presets for the most common app/game currencies. Picking one
// fills both fields so the operator can create a currency without typing.
// The display name is translated via `currencies.presets.<code>`.
const PRESETS: ReadonlyArray<{ code: string; icon: LucideIcon }> = [
  { code: "COIN", icon: Coins },
  { code: "GEM", icon: Gem },
  { code: "GOLD", icon: Crown },
  { code: "DIAMOND", icon: Diamond },
];

export function CurrencyDialog({ projectId, open, currency, onClose }: Props) {
  const { t } = useTranslation();
  const codeId = useId();
  const nameId = useId();
  const isRename = Boolean(currency);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const create = useCreateVirtualCurrency(projectId);
  const rename = useRenameVirtualCurrency(projectId);
  const pending = create.isPending || rename.isPending;
  const error = (create.error ?? rename.error) as Error | null;

  // Seed fields whenever the dialog opens (rename pre-fills, create resets).
  useEffect(() => {
    if (!open) return;
    setCode(currency?.code ?? "");
    setName(currency?.name ?? "");
    create.reset();
    rename.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currency]);

  const codeValid = isRename || CODE_RE.test(code);
  const nameValid = name.trim().length > 0;
  const canSubmit = codeValid && nameValid && !pending;

  function close() {
    onClose();
  }

  function handleSubmit() {
    if (!canSubmit) return;
    if (isRename && currency) {
      rename.mutate(
        { id: currency.id, name: name.trim() },
        { onSuccess: close },
      );
    } else {
      create.mutate(
        { code: code.trim(), name: name.trim() },
        { onSuccess: close },
      );
    }
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !pending) close();
      }}
    >
      <ModalBackdrop variant="blur" isDismissable={!pending}>
        <ModalContainer size="sm" placement="center">
          <ModalDialog>
            <ModalHeader className="items-center gap-3">
              <ModalIcon className="bg-primary-100 text-primary-500">
                <Coins size={18} />
              </ModalIcon>
              <ModalHeading>
                {isRename
                  ? t("currencies.dialog.renameTitle")
                  : t("currencies.dialog.createTitle")}
              </ModalHeading>
            </ModalHeader>

            <ModalBody className="gap-6 py-2">
              {!isRename && (
                <div>
                  <div className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-default-500">
                    {t("currencies.presets.label")}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESETS.map(({ code: presetCode, icon: Icon }) => {
                      const presetName = t(`currencies.presets.${presetCode}`);
                      const selected = code === presetCode;
                      return (
                        <button
                          key={presetCode}
                          type="button"
                          onClick={() => {
                            setCode(presetCode);
                            setName(presetName);
                          }}
                          className={
                            selected
                              ? "inline-flex items-center gap-1.5 rounded-full border border-primary-400 bg-primary-100 px-2.5 py-1 text-[12px] font-medium text-primary-600 transition"
                              : "inline-flex items-center gap-1.5 rounded-full border border-default-200 bg-default-50 px-2.5 py-1 text-[12px] text-default-600 transition hover:border-default-300 hover:bg-default-100"
                          }
                        >
                          <Icon size={13} />
                          {presetName}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor={codeId}
                  className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-default-500"
                >
                  {t("currencies.dialog.codeField")}
                </label>
                <Input
                  id={codeId}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder={t("currencies.dialog.codePlaceholder")}
                  autoComplete="off"
                  autoFocus={!isRename}
                  maxLength={8}
                  disabled={isRename}
                />
                <p className="mt-2 text-[11px] text-default-400">
                  {t("currencies.dialog.codeHint")}
                </p>
              </div>

              <div>
                <label
                  htmlFor={nameId}
                  className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-default-500"
                >
                  {t("currencies.dialog.nameField")}
                </label>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSubmit();
                  }}
                  placeholder={t("currencies.dialog.namePlaceholder")}
                  autoComplete="off"
                  autoFocus={isRename}
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
              <Button variant="ghost" onPress={close} isDisabled={pending}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                isPending={pending}
                isDisabled={!canSubmit}
                onPress={handleSubmit}
              >
                {isRename
                  ? t("currencies.dialog.saveRename")
                  : t("currencies.dialog.createSubmit")}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
