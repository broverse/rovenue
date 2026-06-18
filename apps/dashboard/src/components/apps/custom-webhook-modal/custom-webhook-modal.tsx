import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import { WEBHOOK_EVENT_CATEGORIES, type WebhookEventCategory } from "@rovenue/shared";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Checkbox } from "../../../ui/checkbox";
import { Chip } from "../../../ui/chip";
import { CopyButton } from "../../../ui/copy-button";
import { cn } from "../../../lib/cn";
import { useProject } from "../../../lib/hooks/useProject";
import { useUpdateProjectWebhook } from "../../../lib/hooks/useUpdateProjectWebhook";
import { useRotateWebhookSecret } from "../../../lib/hooks/useRotateWebhookSecret";

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

function isValidUrl(value: string): boolean {
  if (value.trim() === "") return true; // empty clears the endpoint
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function CustomWebhookModal({ open, onClose, projectId }: Props) {
  const { t } = useTranslation();
  const { data: project } = useProject(projectId);
  const update = useUpdateProjectWebhook(projectId);
  const rotate = useRotateWebhookSecret(projectId);

  const [url, setUrl] = useState(project?.webhookUrl ?? "");
  const [categories, setCategories] = useState<WebhookEventCategory[]>(
    project?.webhookEventCategories ?? [],
  );
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const urlValid = isValidUrl(url);
  const canSave = urlValid && !update.isPending;

  const toggle = (cat: WebhookEventCategory) =>
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );

  const handleSave = async () => {
    await update.mutateAsync({
      webhookUrl: url.trim() === "" ? null : url.trim(),
      webhookEventCategories: categories,
    });
    onClose();
  };

  const handleRotate = async () => {
    const res = await rotate.mutateAsync();
    setRevealedSecret(res.webhookSecret);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          {/* Header */}
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("apps.customWebhook.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {t("apps.customWebhook.subtitle")}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-1 gap-4">
              {/* URL */}
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("apps.customWebhook.urlLabel")}
                </label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={t("apps.customWebhook.urlPlaceholder")}
                />
                {!urlValid && (
                  <p className="mt-1 text-[11px] text-rv-danger" role="alert">
                    {t("apps.customWebhook.urlInvalid")}
                  </p>
                )}
              </div>

              {/* Events */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("apps.customWebhook.eventsLabel")}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {WEBHOOK_EVENT_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggle(cat)}
                      className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-2 text-left text-[12.5px] text-foreground hover:bg-rv-c3"
                    >
                      <Checkbox
                        checked={categories.includes(cat)}
                        onChange={() => toggle(cat)}
                        ariaLabel={t(`apps.customWebhook.categories.${cat}`)}
                      />
                      {t(`apps.customWebhook.categories.${cat}`)}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-rv-mute-500">
                  {t("apps.customWebhook.eventsHint")}
                </p>
              </div>

              {/* Secret */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("apps.customWebhook.secretLabel")}
                </div>
                {revealedSecret ? (
                  <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <code className="truncate font-rv-mono text-[12px] text-foreground">
                        {revealedSecret}
                      </code>
                      <CopyButton size="xs" value={revealedSecret} />
                    </div>
                    <p className="mt-1 text-[11px] text-rv-warning">
                      {t("apps.customWebhook.secretRevealWarning")}
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Chip tone={project?.hasWebhookSecret ? "success" : "warning"}>
                      {project?.hasWebhookSecret
                        ? t("apps.customWebhook.secretConfigured")
                        : t("apps.customWebhook.secretMissing")}
                    </Chip>
                    <Button variant="flat" size="sm" onClick={handleRotate} disabled={rotate.isPending} type="button">
                      {rotate.isPending
                        ? t("apps.customWebhook.rotating")
                        : t("apps.customWebhook.rotate")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <footer className="flex items-center justify-between border-t border-rv-divider bg-rv-c1 px-5 py-3">
            <span className="text-[12px] text-rv-danger" role="alert">
              {update.isError ? t("apps.customWebhook.saveError") : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="flat" size="sm" onClick={onClose} type="button">
                {t("common.cancel")}
              </Button>
              <Button variant="solid-primary" size="sm" onClick={handleSave} disabled={!canSave} type="button">
                {update.isPending
                  ? t("apps.customWebhook.saving")
                  : t("apps.customWebhook.save")}
              </Button>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
