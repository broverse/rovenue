import { useTranslation } from "react-i18next";

export function JsonPayloadViewer({
  payload,
}: {
  payload: Record<string, unknown> | null;
}) {
  const { t } = useTranslation();
  if (!payload) {
    return (
      <p className="text-[12px] text-rv-mute-500">
        {t("refundShield.detail.payload.empty")}
      </p>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-rv-divider bg-rv-c1 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}
