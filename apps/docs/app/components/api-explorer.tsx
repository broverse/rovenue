import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Callout } from 'fumadocs-ui/components/callout';
import { ERROR_CATALOG } from '@rovenue/shared/error-catalog';

// =============================================================
// The API explorer (Task 28)
// =============================================================
//
// Renders apps/api/openapi/openapi.json (fetched from /openapi.json, a
// static copy refreshed on every docs build/dev run — see
// scripts/copy-openapi.mjs) as a browsable, "try it" reference.
//
// PRERENDER SAFETY: apps/docs ships as static files behind Caddy with no
// Node process (see apps/docs/Dockerfile), and react-router.config.ts
// prerenders every route, including this one, at build time in Node. This
// component's data comes from `fetch()` and `window.localStorage`, both of
// which either don't exist or shouldn't run in that Node build pass. React
// never invokes effects during server rendering, so gating every browser
// API behind `useEffect` (never the render body) is sufficient on its own;
// the `mounted` flag below is a second, explicit guard so the prerendered
// HTML for this page is an inert, honest "loads in your browser" message
// instead of an empty shell — see app/routes/docs.tsx's `createClientLoader`
// for the sibling mechanism that keeps the surrounding MDX page itself off
// the prerender's critical path.

type JsonSchema = Record<string, any>;

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Array<Record<string, unknown[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
  responses: Record<string, OpenApiResponse>;
}

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonSchema>; securitySchemes?: Record<string, unknown> };
  'x-rovenue-browser-surface'?: {
    description: string;
    pathPrefix: string;
    publicKeyParameter: OpenApiParameter;
    cors: string;
    rateLimit: string;
  };
  'x-rovenue-generation'?: {
    generatedFrom: string;
    derived: string[];
    handMaintained: string[];
    handMaintainedIn: string;
  };
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'] as const;

const METHOD_STYLES: Record<string, string> = {
  get: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  post: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  put: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  patch: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  delete: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

const SETTINGS_STORAGE_KEY = 'rovenue-api-explorer-settings-v1';

interface StoredSettings {
  baseUrl: string;
  bearerToken: string;
  useBrowserSurface: boolean;
  publicKey: string;
}

// WIRE VALUE, not the ERROR_CODE key — `entry.code` is what an
// `error.code` field actually contains on the wire (five codes are
// lowercase even though their key is SCREAMING_CASE: asset_in_use,
// asset_missing, purchase_not_paid, apple_offer_signing_unavailable,
// apple_offer_signing_failed). Anchors on /docs/reference/api-errors are
// generated the same way (generate-error-catalog.mjs's `anchorFor`):
// `code.toLowerCase()`.
const ERROR_BY_WIRE_CODE = new Map<string, (typeof ERROR_CATALOG)[keyof typeof ERROR_CATALOG]>(
  Object.values(ERROR_CATALOG).map((entry) => [entry.code, entry]),
);

function errorAnchor(wireCode: string): string {
  return wireCode.toLowerCase();
}

/**
 * Renders free text that may contain backtick-wrapped code spans, turning
 * any span that's an exact wire-value match for a documented error code
 * into a link to its entry on /docs/reference/api-errors. Every other
 * backtick span still renders as `<code>`, just unlinked.
 */
function textWithErrorLinks(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      const code = part.slice(1, -1);
      const entry = ERROR_BY_WIRE_CODE.get(code);
      if (entry) {
        return (
          <a
            key={`${keyPrefix}-${i}`}
            href={`/docs/reference/api-errors#${errorAnchor(entry.code)}`}
            className="underline decoration-dotted underline-offset-2"
          >
            <code>{code}</code>
          </a>
        );
      }
      return <code key={`${keyPrefix}-${i}`}>{code}</code>;
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function resolveSchema(schema: JsonSchema | undefined, doc: OpenApiDoc): JsonSchema | undefined {
  if (!schema) return schema;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    return doc.components?.schemas?.[name];
  }
  return schema;
}

/** Best-effort example value from a JSON Schema, for a prefillable request body. */
function exampleFromSchema(schema: JsonSchema | undefined, doc: OpenApiDoc, depth = 0): unknown {
  const resolved = resolveSchema(schema, doc);
  if (!resolved || depth > 6) return null;
  if (resolved.example !== undefined) return resolved.example;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];

  const rawType = resolved.type;
  const type: string | undefined = Array.isArray(rawType) ? rawType.find((t) => t !== 'null') ?? rawType[0] : rawType;

  switch (type) {
    case 'string':
      if (resolved.format === 'date-time') return new Date().toISOString();
      if (resolved.format === 'uri') return 'https://example.com';
      return 'string';
    case 'integer':
    case 'number':
      return typeof resolved.minimum === 'number' ? resolved.minimum : 1;
    case 'boolean':
      return true;
    case 'array':
      return [exampleFromSchema(resolved.items, doc, depth + 1)];
    case 'object': {
      const props = resolved.properties ?? {};
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(props)) {
        out[key] = exampleFromSchema(props[key], doc, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

function operationsFrom(doc: OpenApiDoc) {
  const ops: Array<{ path: string; method: string; op: OpenApiOperation }> = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of METHOD_ORDER) {
      const op = methods[method];
      if (op) ops.push({ path, method, op });
    }
  }
  return ops;
}

function groupByTag(ops: Array<{ path: string; method: string; op: OpenApiOperation }>) {
  const groups = new Map<string, Array<{ path: string; method: string; op: OpenApiOperation }>>();
  for (const entry of ops) {
    const tag = entry.op.tags?.[0] ?? 'Other';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(entry);
  }
  return groups;
}

function securityLabel(security: OpenApiOperation['security']): string {
  if (!security || security.length === 0) return 'None (public endpoint)';
  const labels = security.map((requirement) => {
    if ('publicApiKey' in requirement) return 'Public key';
    if ('secretApiKey' in requirement) return 'Secret key';
    return Object.keys(requirement).join(', ');
  });
  return labels.join(' or ');
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: OpenApiParameter[],
  values: Record<string, string>,
  useBrowserSurface: boolean,
  publicKey: string,
  browserSurfacePrefix: string,
): { url: string; error?: string } {
  let effectivePath = path;
  if (useBrowserSurface) {
    if (!publicKey.trim()) return { url: '', error: 'Enter a publishable key to use the browser surface.' };
    effectivePath = path.replace(/^\/v1/, browserSurfacePrefix.replace('{publicKey}', publicKey.trim()));
  }

  let pathWithParams = effectivePath;
  const queryParts: string[] = [];
  for (const param of params) {
    const value = values[param.name] ?? '';
    if (param.in === 'path') {
      pathWithParams = pathWithParams.replace(`{${param.name}}`, encodeURIComponent(value));
    } else if (param.in === 'query' && value) {
      queryParts.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`);
    }
  }

  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmedBase) return { url: '', error: 'Enter a base URL for your Rovenue deployment first.' };

  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  return { url: `${trimmedBase}${pathWithParams}${query}` };
}

function buildCurl(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): string {
  const lines = [`curl -X ${method.toUpperCase()} \\`, `  '${url}' \\`];
  for (const [name, value] of Object.entries(headers)) {
    if (!value) continue;
    lines.push(`  -H '${name}: ${value}' \\`);
  }
  if (body) {
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  } else {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, '');
  }
  return lines.join('\n');
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-md border border-fd-border bg-fd-secondary px-2 py-1 text-xs text-fd-secondary-foreground hover:bg-fd-accent"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            /* clipboard may be unavailable (permissions, insecure context) */
          });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

interface TryItState {
  paramValues: Record<string, string>;
  bodyText: string;
  status: 'idle' | 'sending' | 'done' | 'error';
  responseSummary: string | null;
}

function EndpointCard({
  path,
  method,
  op,
  doc,
  baseUrl,
  bearerToken,
  useBrowserSurface,
  publicKey,
  browserSurfacePrefix,
}: {
  path: string;
  method: string;
  op: OpenApiOperation;
  doc: OpenApiDoc;
  baseUrl: string;
  bearerToken: string;
  useBrowserSurface: boolean;
  publicKey: string;
  browserSurfacePrefix: string;
}) {
  const requestSchema = op.requestBody?.content?.['application/json']?.schema;
  const initialBody = useMemo(
    () => (requestSchema ? JSON.stringify(exampleFromSchema(requestSchema, doc), null, 2) : ''),
    [requestSchema, doc],
  );

  const [state, setState] = useState<TryItState>({
    paramValues: {},
    bodyText: initialBody,
    status: 'idle',
    responseSummary: null,
  });

  const headerParams = (op.parameters ?? []).filter((p) => p.in === 'header');
  const pathAndQueryParams = (op.parameters ?? []).filter((p) => p.in !== 'header');

  const headers: Record<string, string> = {};
  if (bearerToken.trim()) headers.Authorization = `Bearer ${bearerToken.trim()}`;
  for (const param of headerParams) {
    const value = state.paramValues[param.name];
    if (value) headers[param.name] = value;
  }

  const { url, error: urlError } = buildUrl(
    baseUrl,
    path,
    pathAndQueryParams,
    state.paramValues,
    useBrowserSurface,
    publicKey,
    browserSurfacePrefix,
  );

  const bodyForRequest = op.requestBody ? state.bodyText : null;
  const curl = url ? buildCurl(method, url, headers, bodyForRequest) : null;

  async function send() {
    if (!url) return;
    setState((s) => ({ ...s, status: 'sending', responseSummary: null }));
    try {
      const init: RequestInit = { method: method.toUpperCase(), headers: { ...headers } };
      if (bodyForRequest) {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = bodyForRequest;
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON, show raw text */
      }
      setState((s) => ({
        ...s,
        status: 'done',
        responseSummary: `HTTP ${res.status} ${res.statusText}\n\n${pretty}`,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'error',
        responseSummary:
          `Request failed before a response arrived — this is almost always CORS, not a broken API: a plain ` +
          `\`/v1\` path only allows same-origin/server callers. Try the browser surface toggle above ` +
          `(/v1/web/:publicKey), or run the curl command below from a terminal instead.\n\n` +
          `${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {op.description && <p className="text-sm text-fd-muted-foreground">{textWithErrorLinks(op.description, 'desc')}</p>}

      <div className="text-sm">
        <span className="font-medium">Auth:</span> {securityLabel(op.security)}
      </div>

      {pathAndQueryParams.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Parameters</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-fd-border text-left text-fd-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">In</th>
                  <th className="py-1 pr-3 font-medium">Description</th>
                  <th className="py-1 font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {pathAndQueryParams.map((param) => (
                  <tr key={param.name} className="border-b border-fd-border last:border-0">
                    <td className="py-1.5 pr-3 align-top font-mono text-xs">
                      {param.name}
                      {param.required && <span className="text-red-500"> *</span>}
                    </td>
                    <td className="py-1.5 pr-3 align-top text-xs text-fd-muted-foreground">{param.in}</td>
                    <td className="py-1.5 pr-3 align-top text-xs text-fd-muted-foreground">
                      {param.description && textWithErrorLinks(param.description, `p-${param.name}`)}
                    </td>
                    <td className="py-1.5 align-top">
                      <input
                        type="text"
                        className="w-full rounded border border-fd-border bg-fd-background px-2 py-1 text-xs"
                        placeholder={param.schema?.enum?.[0] ?? param.name}
                        value={state.paramValues[param.name] ?? ''}
                        onChange={(e) =>
                          setState((s) => ({
                            ...s,
                            paramValues: { ...s.paramValues, [param.name]: e.target.value },
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {headerParams.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Headers</div>
          {headerParams.map((param) => (
            <div key={param.name} className="flex items-center gap-2 text-sm">
              <span className="w-56 font-mono text-xs">
                {param.name}
                {param.required && <span className="text-red-500"> *</span>}
              </span>
              <input
                type="text"
                className="flex-1 rounded border border-fd-border bg-fd-background px-2 py-1 text-xs"
                placeholder={param.schema?.enum?.join(' | ') ?? param.description ?? ''}
                value={state.paramValues[param.name] ?? ''}
                onChange={(e) =>
                  setState((s) => ({ ...s, paramValues: { ...s.paramValues, [param.name]: e.target.value } }))
                }
              />
            </div>
          ))}
        </div>
      )}

      {op.requestBody && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">
            Request body{op.requestBody.required ? ' (required)' : ' (optional)'}
          </div>
          <textarea
            className="h-40 w-full rounded border border-fd-border bg-fd-background p-2 font-mono text-xs"
            value={state.bodyText}
            onChange={(e) => setState((s) => ({ ...s, bodyText: e.target.value }))}
            spellCheck={false}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Responses</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-fd-border text-left text-fd-muted-foreground">
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(op.responses).map(([status, response]) => {
                const isErrorEnvelope =
                  response.content?.['application/json']?.schema?.$ref === '#/components/schemas/ErrorEnvelope';
                return (
                  <tr key={status} className="border-b border-fd-border last:border-0 align-top">
                    <td className="py-1.5 pr-3 font-mono text-xs">{status}</td>
                    <td className="py-1.5 text-xs text-fd-muted-foreground">
                      {textWithErrorLinks(response.description, `r-${status}`)}
                      {isErrorEnvelope && (
                        <>
                          {' '}
                          Returns{' '}
                          <code>{'{ error: { code, message } }'}</code> — see{' '}
                          <a href="/docs/reference/api-errors" className="underline decoration-dotted underline-offset-2">
                            API Errors
                          </a>
                          .
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-fd-border bg-fd-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!url || state.status === 'sending'}
            onClick={send}
            className="rounded-md bg-fd-primary px-3 py-1.5 text-xs font-medium text-fd-primary-foreground disabled:opacity-50"
          >
            {state.status === 'sending' ? 'Sending…' : 'Send request'}
          </button>
          <span className="break-all font-mono text-xs text-fd-muted-foreground">{url || urlError}</span>
        </div>

        {curl && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fd-muted-foreground">curl</span>
              <CopyButton text={curl} />
            </div>
            <pre className="overflow-x-auto rounded bg-fd-secondary p-2 text-xs">
              <code>{curl}</code>
            </pre>
          </div>
        )}

        {state.responseSummary && (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-fd-secondary p-2 text-xs">
            <code>{state.responseSummary}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

function SpecProvenance({ doc }: { doc: OpenApiDoc }) {
  const generation = doc['x-rovenue-generation'];
  return (
    <Callout type="info" title="This spec is half generated, half hand-maintained">
      <p className="mb-2">
        {generation
          ? `Generated from ${generation.generatedFrom}: ${generation.derived.join(', ')}. These cannot drift from what actually ships.`
          : 'The endpoint set, request bodies, and auth requirements are generated from the live route table and cannot drift.'}
      </p>
      <p>
        {generation
          ? `Hand-maintained in ${generation.handMaintainedIn}: ${generation.handMaintained.join(', ')}. These CAN drift from real responses — a contract test pins the endpoint set, but nothing re-checks response field shapes against a live server.`
          : 'Response bodies, parameters, and prose are hand-maintained and can drift from real responses.'}
      </p>
    </Callout>
  );
}

function ConnectionPanel({
  doc,
  baseUrl,
  setBaseUrl,
  bearerToken,
  setBearerToken,
  useBrowserSurface,
  setUseBrowserSurface,
  publicKey,
  setPublicKey,
}: {
  doc: OpenApiDoc;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  bearerToken: string;
  setBearerToken: (v: string) => void;
  useBrowserSurface: boolean;
  setUseBrowserSurface: (v: boolean) => void;
  publicKey: string;
  setPublicKey: (v: string) => void;
}) {
  const browserSurface = doc['x-rovenue-browser-surface'];
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-fd-border bg-fd-card p-4">
      <div>
        <label className="text-sm font-medium" htmlFor="rovenue-explorer-base-url">
          Your Rovenue API base URL
        </label>
        <p className="mb-1 text-xs text-fd-muted-foreground">
          Rovenue is self-hosted — there is no canonical host to default to. Point this at your own deployment
          (e.g. <code>https://api.your-domain.com</code>).
        </p>
        <input
          id="rovenue-explorer-base-url"
          type="text"
          className="w-full rounded border border-fd-border bg-fd-background px-2 py-1.5 text-sm"
          placeholder="https://api.your-domain.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div>
        <label className="text-sm font-medium" htmlFor="rovenue-explorer-bearer">
          API key (sent as <code>Authorization: Bearer …</code>)
        </label>
        <p className="mb-1 text-xs text-fd-muted-foreground">
          Stored only in this browser's <code>localStorage</code>, never sent anywhere but the base URL above.
        </p>
        <input
          id="rovenue-explorer-bearer"
          type="password"
          autoComplete="off"
          className="w-full rounded border border-fd-border bg-fd-background px-2 py-1.5 text-sm"
          placeholder="rov_pub_… or rov_sec_…"
          value={bearerToken}
          onChange={(e) => setBearerToken(e.target.value)}
        />
      </div>

      <div className="flex items-start gap-2">
        <input
          id="rovenue-explorer-browser-surface"
          type="checkbox"
          className="mt-1"
          checked={useBrowserSurface}
          onChange={(e) => setUseBrowserSurface(e.target.checked)}
        />
        <label htmlFor="rovenue-explorer-browser-surface" className="text-sm">
          Use the browser surface (<code>{browserSurface?.pathPrefix ?? '/v1/web/{publicKey}'}</code>) instead of
          plain <code>/v1</code>
        </label>
      </div>

      {useBrowserSurface && (
        <div>
          <label className="text-sm font-medium" htmlFor="rovenue-explorer-public-key">
            Publishable key for the path (must match the Bearer key above)
          </label>
          <input
            id="rovenue-explorer-public-key"
            type="text"
            className="w-full rounded border border-fd-border bg-fd-background px-2 py-1.5 text-sm"
            placeholder="rov_pub_…"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
          />
        </div>
      )}

      <Callout type="warn" title="A plain /v1 request from this page may fail with no response at all">
        <p>
          That's CORS, not a broken API: browsers reject cross-origin calls that don't opt in, and a plain{' '}
          <code>/v1/…</code> path isn't meant to be called from arbitrary origins. The browser-safe surface is{' '}
          <code>{browserSurface?.pathPrefix ?? '/v1/web/{publicKey}'}</code>, paired with{' '}
          <code>requireMatchingPathKey</code> — it only allows origins your project has explicitly allow-listed for
          that key. Toggle it on above, or skip the browser entirely and run the generated curl command from a
          terminal, which has no CORS restriction.
        </p>
      </Callout>
    </div>
  );
}

function ExplorerContent({ doc }: { doc: OpenApiDoc }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [useBrowserSurface, setUseBrowserSurface] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [hydrated, setHydrated] = useState(false);

  // Load persisted settings once, client-side only.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredSettings>;
        if (typeof parsed.baseUrl === 'string') setBaseUrl(parsed.baseUrl);
        if (typeof parsed.bearerToken === 'string') setBearerToken(parsed.bearerToken);
        if (typeof parsed.useBrowserSurface === 'boolean') setUseBrowserSurface(parsed.useBrowserSurface);
        if (typeof parsed.publicKey === 'string') setPublicKey(parsed.publicKey);
      }
    } catch {
      /* corrupt or unavailable storage — start from defaults */
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const settings: StoredSettings = { baseUrl, bearerToken, useBrowserSurface, publicKey };
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage may be unavailable (private mode, quota) — settings just won't persist */
    }
  }, [hydrated, baseUrl, bearerToken, useBrowserSurface, publicKey]);

  const ops = useMemo(() => operationsFrom(doc), [doc]);
  const groups = useMemo(() => groupByTag(ops), [ops]);
  const tagOrder = useMemo(() => {
    const declared = (doc.tags ?? []).map((t) => t.name);
    const rest = [...groups.keys()].filter((t) => !declared.includes(t));
    return [...declared.filter((t) => groups.has(t)), ...rest];
  }, [doc.tags, groups]);

  const browserSurfacePrefix = doc['x-rovenue-browser-surface']?.pathPrefix ?? '/v1/web/{publicKey}';

  return (
    <div className="flex flex-col gap-6">
      <SpecProvenance doc={doc} />
      <ConnectionPanel
        doc={doc}
        baseUrl={baseUrl}
        setBaseUrl={setBaseUrl}
        bearerToken={bearerToken}
        setBearerToken={setBearerToken}
        useBrowserSurface={useBrowserSurface}
        setUseBrowserSurface={setUseBrowserSurface}
        publicKey={publicKey}
        setPublicKey={setPublicKey}
      />

      <div className="flex flex-col gap-8">
        {tagOrder.map((tag) => (
          <div key={tag} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">{tag}</h2>
            <Accordions type="multiple">
              {groups.get(tag)!.map(({ path, method, op }) => (
                <Accordion
                  key={`${method}-${path}`}
                  title={
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold uppercase ${METHOD_STYLES[method] ?? ''}`}>
                        {method}
                      </span>
                      <span className="font-mono text-sm">{path}</span>
                      {op.summary && <span className="text-sm text-fd-muted-foreground">— {op.summary}</span>}
                    </div>
                  }
                >
                  <EndpointCard
                    path={path}
                    method={method}
                    op={op}
                    doc={doc}
                    baseUrl={baseUrl}
                    bearerToken={bearerToken}
                    useBrowserSurface={useBrowserSurface}
                    publicKey={publicKey}
                    browserSurfacePrefix={browserSurfacePrefix}
                  />
                </Accordion>
              ))}
            </Accordions>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ApiExplorer() {
  const [mounted, setMounted] = useState(false);
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Two-phase mount so the first client render matches the prerendered
  // (Node-built, static) HTML exactly, THEN — only after that commit —
  // effects run and it's safe to touch `fetch`/`window`.
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    fetch('/openapi.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching /openapi.json`);
        return res.json();
      })
      .then((data: OpenApiDoc) => {
        if (!cancelled) setDoc(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  if (!mounted) {
    return (
      <div className="rounded-lg border border-fd-border bg-fd-card p-4 text-sm text-fd-muted-foreground">
        Loading the interactive API explorer…
      </div>
    );
  }

  if (loadError) {
    return (
      <Callout type="error" title="Could not load the OpenAPI spec">
        <p>
          Fetching <code>/openapi.json</code> failed: {loadError}. Reload the page, or read the spec directly:{' '}
          <a href="/openapi.json" className="underline decoration-dotted underline-offset-2">
            /openapi.json
          </a>
          .
        </p>
      </Callout>
    );
  }

  if (!doc) {
    return (
      <div className="rounded-lg border border-fd-border bg-fd-card p-4 text-sm text-fd-muted-foreground">
        Loading OpenAPI spec…
      </div>
    );
  }

  return <ExplorerContent doc={doc} />;
}

export default ApiExplorer;
