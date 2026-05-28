import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useRoviCredentials } from "../../../../../lib/hooks/useRoviCredentials";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/rovi",
)({
  component: RoviSettingsRoute,
});

const PROVIDERS = ["openai", "anthropic", "mistral", "ollama"] as const;
type Provider = (typeof PROVIDERS)[number];

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  mistral: "mistral-small",
  ollama: "llama3.1",
};

function RoviSettingsRoute() {
  useParams({ from: "/_authed/projects/$projectId/settings/rovi" });
  const { query, upsert, test } = useRoviCredentials();
  const existing = query.data;

  const [provider, setProvider] = useState<Provider>(
    (existing?.provider as Provider | null) ?? "openai",
  );
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(existing?.defaultModel ?? DEFAULT_MODELS.openai);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function onProviderChange(next: Provider) {
    setProvider(next);
    setModel(DEFAULT_MODELS[next]);
  }

  async function save() {
    setSaveError(null);
    try {
      await upsert.mutateAsync({
        provider,
        apiKey,
        defaultModel: model,
        baseUrl: baseUrl || undefined,
      });
      setApiKey("");
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  async function runTest() {
    setTestResult(null);
    try {
      const result = await test.mutateAsync();
      setTestResult(`OK — ${result.model}`);
    } catch (e) {
      setTestResult(`Failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-2">
        <Sparkles size={18} className="text-rv-mute-600" />
        <h1 className="text-lg font-semibold text-foreground">Rovi</h1>
      </header>
      <p className="max-w-prose text-sm text-rv-mute-600">
        Bring your own API key so Rovi can run on your provider account. Keys are
        encrypted at rest (AES-256-GCM). Owners only.
      </p>

      <div className="space-y-4 rounded-md border border-rv-divider bg-rv-c1 p-4">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
            Provider
          </label>
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as Provider)}
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground focus:border-rv-c4 focus:outline-none"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
            API key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing?.hasKey ? "•••••••• (saved)" : "sk-…"}
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground placeholder:text-rv-mute-500 focus:border-rv-c4 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-rv-mute-500">
            Leave blank to keep the existing key.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
            Default model
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground focus:border-rv-c4 focus:outline-none"
          />
        </div>

        {provider === "ollama" ? (
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
              Base URL
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground placeholder:text-rv-mute-500 focus:border-rv-c4 focus:outline-none"
            />
          </div>
        ) : null}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={save}
            disabled={upsert.isPending || (!apiKey && !existing?.hasKey)}
            className="h-9 rounded-md bg-rv-c4 px-3 text-sm font-medium text-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {upsert.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={!existing?.hasKey || test.isPending}
            className="h-9 rounded-md border border-rv-divider px-3 text-sm text-rv-mute-700 transition hover:bg-rv-c2 hover:text-foreground disabled:opacity-40"
          >
            {test.isPending ? "Testing…" : "Test"}
          </button>
          {testResult ? (
            <span className="text-xs text-rv-mute-600">{testResult}</span>
          ) : null}
          {saveError ? (
            <span className="text-xs text-red-500">{saveError}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
