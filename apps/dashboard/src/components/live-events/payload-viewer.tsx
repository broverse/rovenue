import type { LiveEvent } from "./types";

const escapeHtml = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

const tokenRegex =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const TOKEN_CLASSES = {
  key: "text-sky-300",
  str: "text-emerald-300",
  num: "text-amber-300",
  bool: "text-pink-300",
  null: "text-rv-mute-500",
} as const;

/**
 * Hand-rolled JSON syntax highlighter — keeps us from pulling in a heavy
 * code-block library for the one place we need it.
 */
const highlightJson = (value: unknown): string => {
  const json = JSON.stringify(value, null, 2) ?? "null";
  return escapeHtml(json).replace(tokenRegex, (match) => {
    let cls: keyof typeof TOKEN_CLASSES = "num";
    if (match.startsWith('"')) cls = match.endsWith(":") ? "key" : "str";
    else if (match === "true" || match === "false") cls = "bool";
    else if (match === "null") cls = "null";
    return `<span class="${TOKEN_CLASSES[cls]}">${match}</span>`;
  });
};

export const buildEventPayload = (event: LiveEvent) => ({
  id: event.id,
  type: event.type,
  api_version: "2026-03-14",
  created_at: event.receivedAt.toISOString(),
  environment: event.environment,
  data: {
    app_user_id: event.user,
    transaction_id: event.txnId,
    product: {
      id: event.productId,
      identifier: event.productSku,
      display_name: event.product,
      price: event.amount == null ? null : Math.abs(event.amount),
      currency: event.currency,
    },
    platform: event.platform,
    store: event.store,
    country_code: event.country,
    app_version: event.appVersion,
    sdk_version: event.sdkVersion,
  },
});

type Props = {
  payload: unknown;
};

export function PayloadViewer({ payload }: Props) {
  return (
    <pre
      className="overflow-x-auto whitespace-pre rounded-md border border-rv-divider bg-rv-bg p-3 font-rv-mono text-[11px] leading-6 text-rv-mute-800"
      dangerouslySetInnerHTML={{ __html: highlightJson(payload) }}
    />
  );
}
