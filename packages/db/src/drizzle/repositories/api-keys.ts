import { eq } from "drizzle-orm";
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
