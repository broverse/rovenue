/**
 * =============================================================
 * OpenAPI 3.1 generator for the public `/v1` surface
 * =============================================================
 *
 * Run:  pnpm --filter @rovenue/api openapi:generate
 * Emits: apps/api/openapi/openapi.json
 *
 * Three facts about the API are DERIVED here, from the same Hono app that
 * serves production traffic, so they cannot drift from it:
 *
 *   1. Which endpoints exist  — `app.routes`.
 *   2. What each accepts      — the `{ target, schema }` tag `validate()`
 *                               stamps on its middleware (lib/validate.ts).
 *   3. What each requires     — the `{ required }` tag `apiKeyAuth()` stamps
 *                               on its middleware, narrowed by reference
 *                               equality against the two shared guards
 *                               `requireSecretKey` / `requirePublicApiKey`.
 *
 * Everything else — responses, parameters, prose — is hand-maintained in
 * `openapi/responses.ts`, because nothing in the codebase describes it as
 * data. That file's header explains why in detail; the generated document
 * says so too, in `info.description`, because a consumer needs to know which
 * half of the document can silently rot.
 *
 * Four shapes in the route table would mis-document the API if ignored, and
 * each is handled explicitly below:
 *
 *   - `v1Route` is mounted TWICE (`/v1` and `/v1/web/:publicKey`), so the raw
 *     table double-counts every endpoint. The browser mount is described as
 *     the CORS-restricted variant it is, under `x-rovenue-browser-surface`,
 *     and asserted to contribute no paths.
 *   - Two endpoints bypass `v1Route` and mount their own literal `/v1/...`
 *     paths at the root app, with OPPOSITE auth postures. Neither is
 *     special-cased by name: auth is resolved from registration order and the
 *     `apiKeyAuth` tag, which is what Hono itself does.
 *   - No response schema exists anywhere (`ok<T>` is an identity generic,
 *     erased at runtime), so none is generated.
 *   - No route uses `validate("query"|"param")`, so no parameter is
 *     generated. If one ever does, this generator throws rather than
 *     silently dropping it.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouterRoute } from "hono/types";
import { zodToJsonSchema } from "zod-to-json-schema";
import { API_KEY_KIND, type ApiKeyKind } from "@rovenue/shared";
import { app } from "../src/app";
import { getRouteSchemaTag } from "../src/lib/validate";
import {
  getApiKeyAuthTag,
  requirePublicApiKey,
  requireSecretKey,
  type ApiKeyRequirement,
} from "../src/middleware/api-key-auth";
import {
  HAND_AUTHORED_ENDPOINTS,
  HAND_AUTHORED_OPERATIONS,
  SHARED_SCHEMAS,
  TAG_DESCRIPTIONS,
  type JsonSchema,
} from "../openapi/responses";

// =============================================================
// Constants
// =============================================================

const V1_PREFIX = "/v1";
/** Mirrors `BROWSER_SURFACE_PREFIX` in src/app.ts. */
const BROWSER_SURFACE_PREFIX = "/v1/web/";
/** Hono's catch-all method for `.use()` registrations. */
const ANY_METHOD = "ALL";
const OPENAPI_VERSION = "3.1.0";
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SECURITY_SCHEME = {
  PUBLIC: "publicApiKey",
  SECRET: "secretApiKey",
} as const satisfies Record<ApiKeyKind, string>;
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../openapi/openapi.json",
);

// =============================================================
// Route-table walking
// =============================================================

export interface V1EndpointChain {
  /** Uppercase HTTP method, as Hono stores it. */
  method: string;
  /** Hono path, `:param` style — e.g. `/v1/subscribers/:appUserId/access`. */
  path: string;
  /** Index in `app.routes` of the chain's first entry. Auth is resolved
   *  against registration order, so this is load-bearing, not diagnostic. */
  firstIndex: number;
  /** Every entry Hono stored for this method+path, in registration order. */
  entries: RouterRoute[];
}

export type AuthPosture =
  | { kind: "none" }
  | { kind: "any" }
  | { kind: "specific"; required: ApiKeyKind };

interface RoutesOwner {
  routes: RouterRoute[];
}

/**
 * True when a Hono registration path pattern covers a concrete target path.
 *
 * Only the wildcard forms Hono produces when a sub-app's `.use("*", …)` is
 * lifted into its parent are handled — `/v1/*`, `*`, and exact paths. A
 * pattern with a `:param` segment is never a middleware pattern in this tree
 * (`/v1/web/:publicKey/*` is, but the browser mount is excluded before this
 * is reached), so it is matched literally and would simply fail to cover
 * anything — the safe direction, since a missed middleware can only cause an
 * endpoint to be reported as LESS protected, which the contradiction checks
 * below then surface.
 */
function patternCovers(pattern: string, target: string): boolean {
  if (pattern === "*" || pattern === "/*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith("*")) return target.startsWith(pattern.slice(0, -1));
  return pattern === target;
}

function isCanonicalV1Path(path: string): boolean {
  if (path.startsWith(BROWSER_SURFACE_PREFIX)) return false;
  return path === V1_PREFIX || path.startsWith(`${V1_PREFIX}/`);
}

/**
 * Groups `app.routes` into one chain per canonical `/v1` endpoint.
 *
 * Hono stores ONE entry per handler, so a route's middleware chain appears as
 * several entries sharing method+path. They are adjacent in practice, but the
 * grouping is keyed rather than positional: two registrations of the same
 * method+path in different places are the same endpoint either way, and a
 * positional grouper would report it as two.
 */
export function collectV1Chains(target: RoutesOwner): V1EndpointChain[] {
  const chains = new Map<string, V1EndpointChain>();

  target.routes.forEach((route, index) => {
    if (!isCanonicalV1Path(route.path)) return;
    // `.use()` registrations — the auth envelope, appUserContext, CORS.
    // They are middleware, not endpoints; they are read again below when
    // resolving auth.
    if (route.method === ANY_METHOD) return;
    if (route.path.includes("*")) return;

    const key = `${route.method} ${route.path}`;
    const existing = chains.get(key);
    if (existing) {
      existing.entries.push(route);
      return;
    }
    chains.set(key, {
      method: route.method,
      path: route.path,
      firstIndex: index,
      entries: [route],
    });
  });

  return [...chains.values()];
}

/**
 * The public `/v1` endpoint set, as `"<METHOD> <hono path>"`.
 *
 * This is the generator's contract with the rest of the repo: the contract
 * test pairs it with `HAND_AUTHORED_ENDPOINTS` so an endpoint cannot appear,
 * vanish or be renamed without the documentation being updated in the same
 * change. Keep the string form (`:param`, not `{param}`) — it is what
 * `app.routes` holds, and normalising here would let a real difference hide
 * inside the normalisation.
 */
export function walkV1Endpoints(target: RoutesOwner): Set<string> {
  return new Set(
    collectV1Chains(target).map((chain) => `${chain.method} ${chain.path}`),
  );
}

/**
 * Resolves what an endpoint requires of a caller, exactly the way Hono
 * resolves it at request time: middleware registered EARLIER at a covering
 * path runs, middleware registered later does not.
 *
 * This is why the two bypass endpoints come out right without being named:
 *
 *   - `/v1/preview/paywalls/:token` is registered BEFORE the `/v1` mount
 *     (deliberately — see src/app.ts), so the envelope's `apiKeyAuth`
 *     wildcard never covers it, and it has none of its own → unauthenticated.
 *   - `/v1/config/stream` is registered AFTER it, so the envelope DOES cover
 *     it, on top of the `apiKeyAuth("any")` it registers for itself.
 *
 * A generator that assumed "under /v1 ⇒ behind the /v1 envelope" would call
 * the first one authenticated, which is the one error here that actually
 * endangers someone.
 */
export function resolveAuth(
  chain: V1EndpointChain,
  target: RoutesOwner,
): AuthPosture {
  const ownAuth = chain.entries
    .map((entry) => getApiKeyAuthTag(entry.handler))
    .filter((tag): tag is NonNullable<typeof tag> => tag != null);

  const envelopeAuth = target.routes
    .slice(0, chain.firstIndex)
    .filter(
      (route) =>
        (route.method === ANY_METHOD || route.method === chain.method) &&
        patternCovers(route.path, chain.path),
    )
    .map((route) => getApiKeyAuthTag(route.handler))
    .filter((tag): tag is NonNullable<typeof tag> => tag != null);

  const hasSecretGuard = chain.entries.some(
    (entry) => entry.handler === requireSecretKey,
  );
  const hasPublicGuard = chain.entries.some(
    (entry) => entry.handler === requirePublicApiKey,
  );

  const requirements = new Set<ApiKeyRequirement>([
    ...ownAuth.map((tag) => tag.required),
    ...envelopeAuth.map((tag) => tag.required),
  ]);

  if (requirements.size === 0) {
    // `requireSecretKey` / `requirePublicApiKey` read `project` off the
    // context, which only `apiKeyAuth` sets. One without the other is a
    // guard that can only ever 403 — a bug, not a documentable posture.
    if (hasSecretGuard || hasPublicGuard) {
      throw new Error(
        `${chain.method} ${chain.path} carries a key-kind guard but no apiKeyAuth covers it — the guard can only ever reject.`,
      );
    }
    return { kind: "none" };
  }

  const specific = new Set<ApiKeyKind>();
  for (const requirement of requirements) {
    if (requirement !== "any") specific.add(requirement);
  }
  if (hasSecretGuard) specific.add(API_KEY_KIND.SECRET);
  if (hasPublicGuard) specific.add(API_KEY_KIND.PUBLIC);

  if (specific.size > 1) {
    throw new Error(
      `${chain.method} ${chain.path} requires contradictory key kinds (${[...specific].join(", ")}) — no caller can satisfy it.`,
    );
  }

  const [required] = [...specific];
  return required ? { kind: "specific", required } : { kind: "any" };
}

/**
 * The request body a route validates, as JSON Schema, or `undefined`.
 *
 * `jsonSchema7` rather than the `openApi3` target: OpenAPI 3.1 schemas ARE
 * JSON Schema 2020-12, in which `nullable: true` — what the `openApi3` target
 * emits — is not a keyword at all. `$refStrategy: "none"` inlines everything,
 * because the library's default `#/definitions/...` pointers do not resolve
 * inside an OpenAPI document.
 *
 * `removeAdditionalStrategy: "strict"` is the confusingly-named option that
 * makes `additionalProperties` mean what the server does. Zod objects default
 * to `strip`, which ACCEPTS unknown keys and silently drops them; the
 * library's default emits `additionalProperties: false` for those, which
 * documents a rejection that never happens. With this setting only `.strict()`
 * objects — which really do reject — get `false`.
 *
 * Returns the schema plus whatever it could NOT express, which the caller
 * surfaces rather than swallows.
 */
export interface ResolvedRequestBody {
  schema: JsonSchema;
  /** Constraints the server enforces that JSON Schema cannot state. */
  inexpressible: string[];
}

/**
 * A Zod refinement/transform (`.refine`, `.superRefine`, `.transform`) is a
 * function. JSON Schema has nowhere to put it, so `zod-to-json-schema` drops
 * it — meaning the emitted body is strictly MORE permissive than the server
 * for these routes. That is a real gap, and it is reported rather than left
 * for someone to discover from a 400.
 */
function describeInexpressible(schema: unknown): string[] {
  const def = (schema as { _def?: { typeName?: string } })._def;
  if (def?.typeName !== "ZodEffects") return [];
  return [
    "carries a Zod refinement or transform, which JSON Schema cannot express — the server enforces at least one cross-field rule this body schema does not state",
  ];
}

export function resolveRequestBody(
  chain: V1EndpointChain,
): ResolvedRequestBody | undefined {
  const tags = chain.entries
    .map((entry) => getRouteSchemaTag(entry.handler))
    .filter((tag): tag is NonNullable<typeof tag> => tag != null);

  const unsupported = tags.filter((tag) => tag.target !== "json");
  if (unsupported.length > 0) {
    throw new Error(
      `${chain.method} ${chain.path} validates ${unsupported
        .map((tag) => `"${tag.target}"`)
        .join(", ")}, which this generator does not emit. Teach it to convert ` +
        `that target into OpenAPI parameters and drop the hand-written ones ` +
        `for this route — do not leave it silently undocumented.`,
    );
  }

  const jsonTag = tags.find((tag) => tag.target === "json");
  if (!jsonTag) return undefined;

  const converted = zodToJsonSchema(jsonTag.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
    removeAdditionalStrategy: "strict",
  }) as JsonSchema;
  // `$schema` is meaningless inside an OpenAPI schema object.
  delete converted.$schema;
  return { schema: converted, inexpressible: describeInexpressible(jsonTag.schema) };
}

// =============================================================
// Document assembly
// =============================================================

/** `/v1/subscribers/:appUserId/access` → `/v1/subscribers/{appUserId}/access` */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function templateVariables(openApiPath: string): string[] {
  return [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
}

function securityFor(auth: AuthPosture): Array<Record<string, string[]>> {
  switch (auth.kind) {
    case "none":
      return [];
    case "specific":
      return [{ [SECURITY_SCHEME[auth.required]]: [] }];
    case "any":
      // Two alternatives, not one scheme with two scopes: either kind of key
      // is accepted, and OpenAPI spells "either" as sibling requirements.
      return [
        { [SECURITY_SCHEME.PUBLIC]: [] },
        { [SECURITY_SCHEME.SECRET]: [] },
      ];
  }
}

const DOCUMENT_DESCRIPTION = `The public Rovenue \`/v1\` API — the surface the mobile and web SDKs talk to.

**How much of this document you can trust blindly.** Half of it is generated by walking the running Hono route table (\`apps/api/scripts/generate-openapi.ts\`) and half is written by hand, and the two halves fail differently:

- **Generated, cannot drift:** which endpoints exist, every request body (converted from the Zod schema the route actually validates against), and every authentication requirement (read from the middleware chain, resolved in Hono's own registration order).
- **Hand-maintained, can drift:** all response bodies, all parameters (path, query, header), and all prose. Nothing in the codebase describes these as data — \`ok<T>(data)\` is an identity generic erased at runtime, and no route uses \`validate("query")\` or \`validate("param")\` — so generating them would mean inventing them. A contract test pins the endpoint *set* so nothing can appear or vanish undocumented, but it cannot notice a response field that changed shape.

**Authentication.** Every endpoint except one is gated by a per-project API key presented as \`Authorization: Bearer <key>\`. Public keys (\`rov_pub_…\`) ship inside your app; secret keys (\`rov_sec_…\`) must never leave your server. Endpoints marked with only \`secretApiKey\` reject a public key with 403, and vice versa. The single exception is \`GET /v1/preview/paywalls/{token}\`, which takes no key at all — see its description.

**Envelope.** Successful responses are \`{ "data": … }\`; failures are \`{ "error": { "code", "message" } }\`. Two funnel endpoints return the *success* envelope with a null payload on 404/202 rather than the error envelope; both say so.

**Browser surface.** The same router is mounted a second time under \`/v1/web/{publicKey}\` for browser callers, because a CORS preflight carries no \`Authorization\` header and the project has to be resolvable from the URL alone. It is not a second set of endpoints and is not listed as one — see \`x-rovenue-browser-surface\`.`;

const BROWSER_SURFACE_EXTENSION = {
  description:
    "The `/v1` router is mounted twice. Browser callers use the second mount, whose path carries the publishable key because a CORS preflight (an OPTIONS request with no `Authorization` header) has no other way to identify the project whose origin allow-list should answer it. Every path in `paths` is reachable under this prefix too, with identical request bodies, responses and key requirements — that is why they are not listed twice.",
  pathPrefix: "/v1/web/{publicKey}",
  publicKeyParameter: {
    name: "publicKey",
    in: "path",
    required: true,
    description:
      "The publishable key (`rov_pub_…`) of the calling project. Must be the SAME key presented in the `Authorization` header: `requireMatchingPathKey` rejects the pair otherwise, so a site cannot combine its own allow-listed path key with another project's Bearer key and call from an origin that project never permitted.",
    schema: { type: "string" },
  },
  cors: "Per-key: the allowed origins are the calling key's `allowedOrigins`. An unknown or revoked key yields an empty list, which refuses every origin — indistinguishable from a real key that was never enabled for browser use. `Access-Control-Allow-Credentials` is deliberately NOT set on this surface, since it would land on top of a reflected customer origin.",
  rateLimit:
    "The unauthenticated preflight lookup sits behind the global per-IP limiter, which is registered before the per-key CORS middleware for exactly that reason.",
};

export function buildOpenApiDocument(target: RoutesOwner): Record<string, unknown> {
  const chains = collectV1Chains(target).sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );

  // The browser mount must contribute nothing. Asserted rather than assumed:
  // if the exclusion ever stops matching (a renamed prefix, say), the raw
  // table silently doubles and this is the only place that would notice.
  const leakedBrowserPaths = chains.filter((chain) =>
    chain.path.startsWith(BROWSER_SURFACE_PREFIX),
  );
  if (leakedBrowserPaths.length > 0) {
    throw new Error(
      `The browser mount leaked ${leakedBrowserPaths.length} duplicate endpoint(s) into the document.`,
    );
  }

  const generated = new Set(chains.map((c) => `${c.method} ${c.path}`));
  const missing = [...generated].filter((k) => !HAND_AUTHORED_ENDPOINTS.has(k));
  const stale = [...HAND_AUTHORED_ENDPOINTS].filter((k) => !generated.has(k));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      [
        "openapi/responses.ts is out of sync with the route table.",
        missing.length > 0
          ? `  Undocumented endpoints: ${missing.join(", ")}`
          : "",
        stale.length > 0
          ? `  Documented but no longer routed: ${stale.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const tagNames = new Set<string>();

  for (const chain of chains) {
    const key = `${chain.method} ${chain.path}`;
    const authored = HAND_AUTHORED_OPERATIONS[key]!;
    const openApiPath = toOpenApiPath(chain.path);
    const parameters = authored.parameters ?? [];

    // OpenAPI requires a `required: true` path parameter for every template
    // variable. Checked here so a route that grows a segment fails the
    // generator instead of emitting an invalid document.
    for (const variable of templateVariables(openApiPath)) {
      const declared = parameters.find(
        (parameter) => parameter.in === "path" && parameter.name === variable,
      );
      if (!declared) {
        throw new Error(
          `${key} templates {${variable}} but openapi/responses.ts declares no path parameter for it.`,
        );
      }
      if (declared.required !== true) {
        throw new Error(
          `${key}: path parameter {${variable}} must be required.`,
        );
      }
    }

    const auth = resolveAuth(chain, target);
    const requestBody = resolveRequestBody(chain);
    for (const tag of authored.tags) tagNames.add(tag);

    const operation: Record<string, unknown> = {
      operationId: operationIdFor(chain),
      summary: authored.summary,
      tags: authored.tags,
      security: securityFor(auth),
      responses: authored.responses,
    };
    if (authored.description) operation.description = authored.description;
    if (parameters.length > 0) operation.parameters = parameters;
    if (requestBody) {
      const schema = { ...requestBody.schema };
      if (requestBody.inexpressible.length > 0) {
        schema.description = [
          typeof schema.description === "string" ? schema.description : "",
          `Note: this endpoint ${requestBody.inexpressible.join("; ")}.`,
        ]
          .filter(Boolean)
          .join(" ");
      }
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema } },
      };
    }

    paths[openApiPath] ??= {};
    paths[openApiPath]![chain.method.toLowerCase()] = operation;
  }

  return {
    openapi: OPENAPI_VERSION,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: {
      title: "Rovenue API",
      version: "1.0.0",
      description: DOCUMENT_DESCRIPTION,
      license: { name: "AGPL-3.0", identifier: "AGPL-3.0-only" },
    },
    servers: [
      {
        // Relative, deliberately. Rovenue is self-hosted, so there is no
        // canonical host to name — and a `{variable}`-templated absolute URL
        // is not a valid `uri-reference`, which strict 3.1 validators reject.
        url: "/",
        description:
          "Relative to your own Rovenue deployment (e.g. https://api.example.com). Rovenue is self-hosted; there is no canonical host.",
      },
    ],
    tags: [...tagNames].sort().map((name) => {
      const description = TAG_DESCRIPTIONS[name];
      if (!description) {
        throw new Error(
          `Tag "${name}" has no entry in TAG_DESCRIPTIONS (openapi/responses.ts).`,
        );
      }
      return { name, description };
    }),
    paths,
    components: {
      securitySchemes: {
        [SECURITY_SCHEME.PUBLIC]: {
          type: "http",
          scheme: "bearer",
          description:
            "A publishable project key (`rov_pub_…`), safe to ship inside a client application.",
        },
        [SECURITY_SCHEME.SECRET]: {
          type: "http",
          scheme: "bearer",
          description:
            "A secret project key (`rov_sec_…`). Server-to-server only — it must never reach a client.",
        },
      },
      schemas: SHARED_SCHEMAS,
    },
    "x-rovenue-browser-surface": BROWSER_SURFACE_EXTENSION,
    "x-rovenue-generation": {
      generatedFrom: "apps/api/scripts/generate-openapi.ts, walking app.routes",
      derived: ["endpoint set", "request bodies", "security requirements"],
      handMaintained: [
        "responses",
        "parameters",
        "summaries and descriptions",
        "tags",
      ],
      handMaintainedIn: "apps/api/openapi/responses.ts",
    },
  };
}

/** `POST /v1/subscribers/:appUserId/restore` → `postV1SubscribersByAppUserIdRestore` */
function operationIdFor(chain: V1EndpointChain): string {
  const segments = chain.path
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(":")
        ? `By${capitalise(segment.slice(1))}`
        : capitalise(segment.replace(/[^A-Za-z0-9]/g, "")),
    );
  return chain.method.toLowerCase() + segments.join("");
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// =============================================================
// CLI
// =============================================================

/** `--check`: exit 1 rather than write, when the committed file is stale. */
const CHECK_FLAG = "--check";

/**
 * Regenerates the document in memory and compares it byte-for-byte against
 * the committed `openapi.json`, without writing anything.
 *
 * Nothing before this enforced that the committed file matches what the
 * generator would produce right now — the previous task's reviewer verified
 * that by hand. A zod schema edited without re-running `openapi:generate`
 * would leave `openapi.json` describing a request body the server no longer
 * accepts (or now requires), silently, since nothing re-derives it. This is
 * the CI gate for that: same document builder, same serialisation, run
 * against the file already on disk instead of overwriting it.
 */
function checkUpToDate(): boolean {
  const document = buildOpenApiDocument(app);
  const fresh = `${JSON.stringify(document, null, 2)}\n`;

  let committed: string | undefined;
  try {
    committed = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    committed = undefined;
  }

  if (committed === fresh) {
    process.stdout.write(
      `${OUTPUT_PATH} is up to date with the route table and openapi/responses.ts.\n`,
    );
    return true;
  }

  process.stderr.write(
    [
      committed === undefined
        ? `${OUTPUT_PATH} does not exist.`
        : `${OUTPUT_PATH} is stale — it no longer matches what the app and openapi/responses.ts would generate.`,
      "A route, its Zod schema, its auth, or openapi/responses.ts changed without regenerating the spec.",
      "Run `pnpm --filter @rovenue/api openapi:generate` and commit the result.",
      "",
    ].join("\n"),
  );
  return false;
}

function main(): void {
  if (process.argv.includes(CHECK_FLAG)) {
    process.exitCode = checkUpToDate() ? 0 : 1;
    return;
  }

  const document = buildOpenApiDocument(app);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const chains = collectV1Chains(app);
  const unauthenticated = chains.filter(
    (chain) => resolveAuth(chain, app).kind === "none",
  );
  const secretOnly = chains.filter((chain) => {
    const auth = resolveAuth(chain, app);
    return auth.kind === "specific" && auth.required === API_KEY_KIND.SECRET;
  });
  const publicOnly = chains.filter((chain) => {
    const auth = resolveAuth(chain, app);
    return auth.kind === "specific" && auth.required === API_KEY_KIND.PUBLIC;
  });
  const withBody = chains.filter((chain) => resolveRequestBody(chain));
  const partiallyExpressed = chains.filter(
    (chain) => (resolveRequestBody(chain)?.inexpressible.length ?? 0) > 0,
  );

  process.stdout.write(
    [
      `Wrote ${OUTPUT_PATH}`,
      `  route-table entries:        ${app.routes.length}`,
      `  canonical /v1 endpoints:    ${chains.length}`,
      `  with a generated body:      ${withBody.length}`,
      `  public-key only:            ${publicOnly.length}`,
      `  secret-key only:            ${secretOnly.length}`,
      `  UNAUTHENTICATED:            ${unauthenticated.length}` +
        (unauthenticated.length > 0
          ? ` (${unauthenticated.map((c) => `${c.method} ${c.path}`).join(", ")})`
          : ""),
      `  body under-states the server (Zod refinement dropped): ${partiallyExpressed.length}` +
        (partiallyExpressed.length > 0
          ? ` (${partiallyExpressed.map((c) => `${c.method} ${c.path}`).join(", ")})`
          : ""),
      "",
    ].join("\n"),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))
) {
  main();
  // The app opens no connections at import time, but tsx keeps the process
  // alive if anything did; exiting explicitly keeps the script a script.
  // `process.exitCode` carries `--check`'s pass/fail — default to 0 for the
  // plain generate path, which never sets it.
  process.exit(process.exitCode ?? 0);
}
