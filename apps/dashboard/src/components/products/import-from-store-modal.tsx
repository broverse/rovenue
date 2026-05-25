import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { Check, X } from "lucide-react";
import type {
  DashboardProductImportInput,
  DashboardProductImportResponse,
  ProductTypeName,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { useImportProducts } from "../../lib/hooks/useProjectProducts";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
};

type Store = "ios" | "android" | "web";

type Step = "input" | "results";

const STORE_PLACEHOLDER: Record<Store, string> = {
  ios: "com.acme.app.pro_monthly\ncom.acme.app.pro_yearly\ncom.acme.app.coins_100",
  android: "pro_monthly\npro_yearly\ncoins_100",
  web: "price_1Abc...\nprice_1Def...\nprice_1Ghi...",
};

export function ImportFromStoreModal({ projectId, open, onClose }: Props) {
  const { t } = useTranslation();
  const importMut = useImportProducts(projectId);

  const [store, setStore] = useState<Store>("ios");
  const [type, setType] = useState<ProductTypeName>("SUBSCRIPTION");
  const [raw, setRaw] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [result, setResult] = useState<DashboardProductImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStore("ios");
      setType("SUBSCRIPTION");
      setRaw("");
      setStep("input");
      setResult(null);
      setError(null);
    }
  }, [open]);

  const parsed = useMemo(() => parseStoreIds(raw), [raw]);
  const idStore = useId();
  const idType = useId();
  const idRaw = useId();

  const submit = async () => {
    if (parsed.length === 0 || importMut.isPending) return;
    setError(null);
    const body: DashboardProductImportInput = {
      store,
      items: parsed.map((storeId) => ({ storeId, type })),
    };
    try {
      const res = await importMut.mutateAsync(body);
      setResult(res);
      setStep("results");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("products.import.errors.unknown"));
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[600px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("products.import.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {step === "input"
                  ? t("products.import.subtitle")
                  : t("products.import.resultsSubtitle")}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {step === "input" ? (
              <div className="grid grid-cols-1 gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("products.import.fields.store")} htmlFor={idStore}>
                    <Select
                      id={idStore}
                      value={store}
                      onChange={(e) => setStore(e.target.value as Store)}
                    >
                      <option value="ios">{t("products.import.stores.ios")}</option>
                      <option value="android">{t("products.import.stores.android")}</option>
                      <option value="web">{t("products.import.stores.web")}</option>
                    </Select>
                  </Field>
                  <Field label={t("products.import.fields.type")} htmlFor={idType}>
                    <Select
                      id={idType}
                      value={type}
                      onChange={(e) => setType(e.target.value as ProductTypeName)}
                    >
                      <option value="SUBSCRIPTION">{t("products.form.types.subscription")}</option>
                      <option value="CONSUMABLE">{t("products.form.types.consumable")}</option>
                      <option value="NON_CONSUMABLE">{t("products.form.types.nonConsumable")}</option>
                    </Select>
                  </Field>
                </div>

                <Field
                  label={t("products.import.fields.storeIds")}
                  htmlFor={idRaw}
                  hint={t("products.import.fields.storeIdsHint")}
                >
                  <Textarea
                    id={idRaw}
                    rows={8}
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    placeholder={STORE_PLACEHOLDER[store]}
                    className="font-rv-mono text-[12px]"
                  />
                </Field>

                <div className="rounded-md border border-rv-divider bg-rv-c2/50 px-3 py-2 text-[12px] text-rv-mute-500">
                  {t("products.import.preview", { count: parsed.length })}
                </div>
              </div>
            ) : (
              <ImportResults result={result!} />
            )}
          </div>

          <footer className="flex items-center justify-between border-t border-rv-divider bg-rv-c1 px-5 py-3">
            <span className="text-[12px] text-rv-danger" role="alert">
              {error ?? ""}
            </span>
            <div className="flex gap-2">
              {step === "input" ? (
                <>
                  <Button variant="flat" size="sm" onClick={onClose} type="button">
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="solid-primary"
                    size="sm"
                    onClick={submit}
                    disabled={parsed.length === 0 || importMut.isPending}
                    type="button"
                  >
                    {importMut.isPending
                      ? t("products.import.submitting")
                      : t("products.import.submit", { count: parsed.length })}
                  </Button>
                </>
              ) : (
                <Button variant="solid-primary" size="sm" onClick={onClose} type="button">
                  {t("common.close")}
                </Button>
              )}
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportResults({ result }: { result: DashboardProductImportResponse }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[13px]">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-rv-accent-500/[0.12] px-2 py-1 text-rv-accent-500">
          <Check size={12} /> {t("products.import.results.created", { count: result.created })}
        </span>
        {result.skipped > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-rv-mute-500/[0.12] px-2 py-1 text-rv-mute-800">
            {t("products.import.results.skipped", { count: result.skipped })}
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-rv-divider">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-rv-c2 text-[11px] uppercase tracking-wider text-rv-mute-500">
            <tr>
              <th className="px-3 py-2 font-medium">{t("products.import.results.storeId")}</th>
              <th className="px-3 py-2 font-medium">{t("products.import.results.identifier")}</th>
              <th className="px-3 py-2 font-medium">{t("products.import.results.status")}</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map((row, i) => (
              <tr key={`${row.storeId}-${i}`} className="border-t border-rv-divider">
                <td className="px-3 py-2 font-rv-mono">{row.storeId}</td>
                <td className="px-3 py-2 font-rv-mono">{row.identifier}</td>
                <td className="px-3 py-2">
                  {row.status === "created" ? (
                    <span className="text-rv-accent-500">
                      {t("products.import.results.created", { count: 1 })}
                    </span>
                  ) : (
                    <span className="text-rv-mute-800">
                      {t(`products.import.skipReasons.${row.reason ?? "invalid"}`)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
      >
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-rv-mute-500">{hint}</p>}
    </div>
  );
}

/**
 * Newline- or comma-separated IDs, trimmed and de-duplicated. Order from
 * the user's paste is preserved.
 */
function parseStoreIds(raw: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const v = part.trim();
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
