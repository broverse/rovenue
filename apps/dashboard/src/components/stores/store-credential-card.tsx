import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Apple, ChevronDown, Store } from "lucide-react";
import type {
  CredentialStatus,
  CredentialStore,
  UpdateAppleCredentialsRequest,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Chip } from "../../ui/chip";
import { cn } from "../../lib/cn";
import {
  useDisconnectStore,
  useUpdateStoreCredentials,
  type StoreCredentialBody,
} from "../../lib/hooks/useStoreCredentials";

const STORE_ICON: Record<CredentialStore, typeof Apple> = {
  apple: Apple,
  google: Store,
};

interface Props {
  projectId: string;
  store: CredentialStore;
  status: CredentialStatus;
  /** OWNER-only: server rejects writes from other roles. */
  canEdit: boolean;
}

export function StoreCredentialCard({ projectId, store, status, canEdit }: Props) {
  const { t } = useTranslation();
  const update = useUpdateStoreCredentials(projectId);
  const disconnect = useDisconnectStore(projectId);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state. Non-secret fields seed from the safe fields the API echoes;
  // secrets always start empty (never returned) and must be re-entered, since
  // PUT replaces the whole credential rather than merging.
  const safe = status.safeFields ?? {};
  const [bundleId, setBundleId] = useState(safe.bundleId ?? "");
  const [appAppleId, setAppAppleId] = useState(safe.appAppleId ?? "");
  const [keyId, setKeyId] = useState(safe.keyId ?? "");
  const [issuerId, setIssuerId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [packageName, setPackageName] = useState(safe.packageName ?? "");
  const [serviceAccount, setServiceAccount] = useState("");

  const Icon = STORE_ICON[store];
  const name = t(`stores.${store}.name`);

  const summary =
    store === "apple"
      ? safe.bundleId
      : [safe.packageName, safe.clientEmail].filter(Boolean).join(" · ");

  const toggle = () => {
    setError(null);
    setExpanded((v) => !v);
  };

  const valid =
    store === "apple"
      ? bundleId.trim().length > 0
      : packageName.trim().length > 0 && serviceAccount.trim().length > 0;

  const buildBody = (): StoreCredentialBody | null => {
    if (store === "apple") {
      const apple: UpdateAppleCredentialsRequest = { bundleId: bundleId.trim() };
      if (appAppleId.trim()) {
        const n = Number(appAppleId.trim());
        if (Number.isInteger(n) && n > 0) apple.appAppleId = n;
      }
      if (keyId.trim()) apple.keyId = keyId.trim();
      if (issuerId.trim()) apple.issuerId = issuerId.trim();
      if (privateKey.trim()) apple.privateKey = privateKey;
      return apple;
    }
    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(serviceAccount);
    } catch {
      setError(t("stores.google.invalidJson"));
      return null;
    }
    if (!parsed?.client_email || !parsed?.private_key) {
      setError(t("stores.google.invalidJson"));
      return null;
    }
    return {
      packageName: packageName.trim(),
      serviceAccount: parsed as { client_email: string; private_key: string },
    };
  };

  const handleSave = async () => {
    setError(null);
    const body = buildBody();
    if (!body) return;
    try {
      await update.mutateAsync({ store, body });
      setExpanded(false);
      setPrivateKey("");
      setServiceAccount("");
    } catch {
      setError(t("stores.saveError"));
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm(t("stores.disconnectConfirm"))) return;
    setError(null);
    try {
      await disconnect.mutateAsync(store);
      setExpanded(false);
    } catch {
      setError(t("stores.saveError"));
    }
  };

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600">
            <Icon size={17} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-foreground">{name}</span>
              <Chip tone={status.configured ? "success" : "default"}>
                {status.configured
                  ? t("stores.status.connected")
                  : t("stores.status.notConfigured")}
              </Chip>
            </div>
            {summary ? (
              <div className="mt-0.5 truncate font-rv-mono text-[11.5px] text-rv-mute-500">
                {summary}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status.configured && canEdit ? (
            <Button
              variant="flat"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnect.isPending}
              type="button"
            >
              {disconnect.isPending
                ? t("stores.actions.disconnecting")
                : t("stores.actions.disconnect")}
            </Button>
          ) : null}
          <Button
            variant={status.configured ? "flat" : "solid-primary"}
            size="sm"
            onClick={toggle}
            disabled={!canEdit}
            type="button"
          >
            {status.configured ? t("stores.actions.edit") : t("stores.actions.configure")}
            <ChevronDown
              size={13}
              className={cn("transition-transform", expanded && "rotate-180")}
            />
          </Button>
        </div>
      </header>

      {!canEdit ? (
        <p className="border-t border-rv-divider px-4 py-2.5 text-[11.5px] text-rv-mute-500 sm:px-5">
          {t("stores.ownerOnly")}
        </p>
      ) : null}

      {expanded && canEdit ? (
        <div className="border-t border-rv-divider px-4 py-4 sm:px-5">
          <div className="grid gap-3">
            {store === "apple" ? (
              <>
                <Field label={t("stores.apple.fields.bundleId")}>
                  <Input
                    mono
                    value={bundleId}
                    onChange={(e) => setBundleId(e.target.value)}
                    placeholder={t("stores.apple.placeholders.bundleId")}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("stores.apple.fields.appAppleId")}>
                    <Input
                      mono
                      inputMode="numeric"
                      value={appAppleId}
                      onChange={(e) => setAppAppleId(e.target.value)}
                      placeholder={t("stores.apple.placeholders.appAppleId")}
                    />
                  </Field>
                  <Field label={t("stores.apple.fields.keyId")}>
                    <Input
                      mono
                      value={keyId}
                      onChange={(e) => setKeyId(e.target.value)}
                      placeholder={t("stores.apple.placeholders.keyId")}
                    />
                  </Field>
                </div>
                <Field label={t("stores.apple.fields.issuerId")}>
                  <Input
                    mono
                    value={issuerId}
                    onChange={(e) => setIssuerId(e.target.value)}
                    placeholder={t("stores.apple.placeholders.issuerId")}
                  />
                </Field>
                <Field label={t("stores.apple.fields.privateKey")}>
                  <Textarea
                    className="min-h-[120px] font-rv-mono text-[12px]"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder={t("stores.apple.placeholders.privateKey")}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={t("stores.google.fields.packageName")}>
                  <Input
                    mono
                    value={packageName}
                    onChange={(e) => setPackageName(e.target.value)}
                    placeholder={t("stores.google.placeholders.packageName")}
                  />
                </Field>
                <Field label={t("stores.google.fields.serviceAccount")}>
                  <Textarea
                    className="min-h-[140px] font-rv-mono text-[12px]"
                    value={serviceAccount}
                    onChange={(e) => setServiceAccount(e.target.value)}
                    placeholder={t("stores.google.placeholders.serviceAccount")}
                  />
                </Field>
              </>
            )}

            <p className="text-[11px] text-rv-mute-500">{t("stores.updateHint")}</p>
            {error ? (
              <p className="text-[11.5px] text-rv-danger" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button variant="flat" size="sm" onClick={toggle} type="button">
                {t("stores.actions.cancel")}
              </Button>
              <Button
                variant="solid-primary"
                size="sm"
                onClick={handleSave}
                disabled={!valid || update.isPending}
                type="button"
              >
                {update.isPending ? t("stores.actions.saving") : t("stores.actions.save")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </span>
      {children}
    </label>
  );
}
