import { useTranslation } from "react-i18next";
import type { PaywallNode } from "@rovenue/shared/paywall";
import { NODE_ICON, NODE_TYPE_LABEL, NODE_TYPES } from "./node-meta";

// Simple absolutely-positioned popover — mirrors funnel-builder's
// add-content-popover.tsx pattern (fixed backdrop + anchored panel) but
// with a flat list since there are only 7 node types to choose from.
export function AddNodePopover({
  onPick,
  onClose,
}: {
  onPick: (type: PaywallNode["type"]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="fixed inset-0 z-[49]" onClick={onClose} />
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute left-0 top-full z-50 mt-1 w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]"
      >
        <div className="mb-1 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.addNode.title", "Add node")}
        </div>
        {NODE_TYPES.map((type) => {
          const Icon = NODE_ICON[type];
          return (
            <button
              key={type}
              type="button"
              onClick={() => onPick(type)}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground transition hover:bg-rv-c2"
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-rv-c3 text-rv-mute-600">
                <Icon size={13} />
              </span>
              {t(`paywalls.builder.nodeTypes.${type}`, NODE_TYPE_LABEL[type])}
            </button>
          );
        })}
      </div>
    </>
  );
}
