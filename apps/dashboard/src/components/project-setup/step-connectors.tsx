import { useTranslation } from "react-i18next";
import { ConnectorChip } from "./connector-chip";
import { StepHead } from "./step-head";
import { ToggleRow } from "./toggle-row";
import { CONNECTORS } from "./mock-data";
import type { SetupForm } from "./types";

type StepConnectorsProps = {
  form: SetupForm;
  onToggleConnector: (id: string) => void;
};

export function StepConnectors({
  form,
  onToggleConnector,
}: StepConnectorsProps) {
  const { t } = useTranslation();

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.connectors.eyebrow")}
        title={t("projectSetup.connectors.title")}
        description={t("projectSetup.connectors.description")}
      />

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {CONNECTORS.map((connector) => (
          <ConnectorChip
            key={connector.id}
            connector={connector}
            selected={form.connectors.includes(connector.id)}
            onToggle={() => onToggleConnector(connector.id)}
          />
        ))}
      </div>

      {form.connectors.length === 0 ? (
        <div className="mt-5 rounded-md border border-dashed border-rv-divider px-4 py-3.5 text-center text-[12px] text-rv-mute-500">
          {t("projectSetup.connectors.empty")}
        </div>
      ) : null}

      <div className="mt-6">
        <ToggleRow
          title={t("projectSetup.connectors.broadcast.title")}
          description={t("projectSetup.connectors.broadcast.description")}
          checked
          onChange={() => {
            /* placeholder — broadcast switch is mock-only in the design */
          }}
        />
      </div>
    </>
  );
}
