import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Search } from "lucide-react";
import { Chip, type ChipProps } from "../../ui/chip";
import { CopyButton } from "../../ui/copy-button";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import { REST_ENDPOINTS, API_BASE_URL } from "./mock-data";
import type { RestEndpoint, RestMethod } from "./types";

const METHOD_TONE: Record<RestMethod, NonNullable<ChipProps["tone"]>> = {
  GET: "primary",
  POST: "success",
  PATCH: "warning",
  DELETE: "danger",
};

const SCOPE_FILTERS: ReadonlyArray<"all" | RestEndpoint["scopeKey"]> = [
  "all",
  "read",
  "write",
  "admin",
];

export function EndpointsCard() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<(typeof SCOPE_FILTERS)[number]>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo<ReadonlyArray<RestEndpoint>>(() => {
    const needle = query.trim().toLowerCase();
    return REST_ENDPOINTS.filter((endpoint) => {
      if (scope !== "all" && endpoint.scopeKey !== scope) return false;
      if (!needle) return true;
      return (
        endpoint.path.toLowerCase().includes(needle) ||
        endpoint.method.toLowerCase().includes(needle) ||
        t(`sdkApi.endpoints.items.${endpoint.summaryKey}`).toLowerCase().includes(needle)
      );
    });
  }, [query, scope, t]);

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rv-divider px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-5 text-foreground">
            {t("sdkApi.endpoints.title")}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
            {t("sdkApi.endpoints.subtitle", { baseUrl: API_BASE_URL })}
          </p>
        </div>
        <a
          href="#"
          className="inline-flex items-center gap-1 text-[12px] text-rv-accent-500 hover:text-rv-accent-400"
        >
          {t("sdkApi.endpoints.openReference")}
          <ArrowUpRight size={12} />
        </a>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-rv-divider px-4 py-3 sm:px-5">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("sdkApi.endpoints.searchPlaceholder")}
          aria-label={t("sdkApi.endpoints.searchAria")}
          size="md"
          rootClassName="w-full min-w-0 flex-1 sm:w-auto sm:min-w-[200px]"
        />
        <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {SCOPE_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setScope(option)}
              className={cn(
                "inline-flex h-[26px] shrink-0 cursor-pointer items-center rounded px-2.5 text-[11.5px] transition",
                scope === option
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t(`sdkApi.endpoints.scopes.${option}`)}
            </button>
          ))}
        </div>
      </div>

      <ul className="divide-y divide-rv-divider">
        {filtered.length === 0 ? (
          <li className="flex flex-col items-center gap-1.5 px-4 py-10 text-center sm:px-5">
            <Search size={18} className="text-rv-mute-500" />
            <span className="text-[13px] text-rv-mute-700">
              {t("sdkApi.endpoints.empty.title")}
            </span>
            <span className="text-[12px] text-rv-mute-500">
              {t("sdkApi.endpoints.empty.body")}
            </span>
          </li>
        ) : (
          filtered.map((endpoint) => (
            <li
              key={endpoint.id}
              className="grid items-center gap-3 px-4 py-2.5 sm:px-5 grid-cols-[64px_minmax(0,1fr)_auto] sm:grid-cols-[72px_minmax(0,2fr)_minmax(0,1.5fr)_auto]"
            >
              <Chip tone={METHOD_TONE[endpoint.method]}>{endpoint.method}</Chip>
              <code className="truncate font-rv-mono text-[12px] text-foreground">
                {endpoint.path}
              </code>
              <span className="hidden truncate text-[12px] text-rv-mute-600 sm:block">
                {t(`sdkApi.endpoints.items.${endpoint.summaryKey}`)}
              </span>
              <CopyButton
                size="xs"
                value={`${endpoint.method} ${API_BASE_URL.replace(/\/v1$/, "")}${endpoint.path}`}
                label={t("sdkApi.copy.idle")}
                copiedLabel={t("sdkApi.copy.copied")}
              />
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
