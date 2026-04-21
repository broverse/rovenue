import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  apiKeys,
  projects,
  type ApiKey,
} from "../schema";

// =============================================================
// API key + project join — Drizzle repository
// =============================================================
//
// Used by apps/api/src/middleware/api-key-auth.ts on every /v1
// request, so this is a hot path. Single-row by unique index in
// both lookups (keyPublic UNIQUE, or id PK).

type ApiKeyWithProject = ApiKey & {
  project: { id: string; name: string; slug: string };
};

function rowToRecord(r: {
  id: string;
  projectId: string;
  label: string;
  keyPublic: string;
  keySecretHash: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  environment: "PRODUCTION" | "SANDBOX";
  createdAt: Date;
  updatedAt: Date;
  projectName: string;
  projectSlug: string;
}): ApiKeyWithProject {
  return {
    id: r.id,
    projectId: r.projectId,
    label: r.label,
    keyPublic: r.keyPublic,
    keySecretHash: r.keySecretHash,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    environment: r.environment,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    project: {
      id: r.projectId,
      name: r.projectName,
      slug: r.projectSlug,
    },
  };
}

const selection = {
  id: apiKeys.id,
  projectId: apiKeys.projectId,
  label: apiKeys.label,
  keyPublic: apiKeys.keyPublic,
  keySecretHash: apiKeys.keySecretHash,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
  environment: apiKeys.environment,
  createdAt: apiKeys.createdAt,
  updatedAt: apiKeys.updatedAt,
  projectName: projects.name,
  projectSlug: projects.slug,
};

export async function findApiKeyByPublic(
  db: Db,
  keyPublic: string,
): Promise<ApiKeyWithProject | null> {
  const rows = await db
    .select(selection)
    .from(apiKeys)
    .innerJoin(projects, eq(projects.id, apiKeys.projectId))
    .where(eq(apiKeys.keyPublic, keyPublic))
    .limit(1);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function findApiKeyById(
  db: Db,
  id: string,
): Promise<ApiKeyWithProject | null> {
  const rows = await db
    .select(selection)
    .from(apiKeys)
    .innerJoin(projects, eq(projects.id, apiKeys.projectId))
    .where(eq(apiKeys.id, id))
    .limit(1);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export interface ActiveApiKeyRow {
  id: string;
  label: string;
  keyPublic: string;
  environment: "PRODUCTION" | "SANDBOX";
  createdAt: Date;
}

/**
 * Mirrors prisma.apiKey.findMany({ where: { projectId, revokedAt: null }, orderBy: { createdAt: "asc" }, select: {…} }).
 * Used by the dashboard's project detail endpoint.
 */
export async function listActiveApiKeys(
  db: Db,
  projectId: string,
): Promise<ActiveApiKeyRow[]> {
  return db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      keyPublic: apiKeys.keyPublic,
      environment: apiKeys.environment,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.projectId, projectId), isNull(apiKeys.revokedAt)),
    )
    .orderBy(asc(apiKeys.createdAt));
}

// --- writes ---

export interface CreateApiKeyInput {
  id: string;
  projectId: string;
  label: string;
  keyPublic: string;
  keySecretHash: string;
  environment: "PRODUCTION" | "SANDBOX";
}

/**
 * Insert a new api_keys row with the caller-supplied id so the id
 * embedded in the plaintext secret matches the stored row. See the
 * project create flow for why the id is pre-generated in JS.
 */
/**
 * Fire-and-forget lastUsedAt touch. Middleware calls this on every
 * authenticated request so the dashboard can surface "last seen"
 * per-key; failures are logged by the caller and swallowed (no
 * retry).
 */
export async function updateApiKeyLastUsed(
  db: Db,
  id: string,
  now: Date,
): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, id));
}

export async function createApiKey(
  db: Db,
  input: CreateApiKeyInput,
): Promise<ApiKey> {
  const rows = await db
    .insert(apiKeys)
    .values({
      id: input.id,
      projectId: input.projectId,
      label: input.label,
      keyPublic: input.keyPublic,
      keySecretHash: input.keySecretHash,
      environment: input.environment,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to create api key");
  return row;
}
