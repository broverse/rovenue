import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { encrypt, decrypt } from "@rovenue/shared/crypto";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { ok } from "../../../lib/response";
import {
  resolveProviderForProject,
  buildAiSdkModel,
} from "../../../services/copilot/providers";
import { env } from "../../../lib/env";

const upsertBody = z.object({
  provider: z.enum(["openai", "anthropic", "mistral", "ollama"]),
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

export const copilotCredentialsRoute = new Hono()
  .use("*", requireDashboardAuth)

  // GET / — any project member can read (key is masked)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const row = await drizzle.copilotCredentialRepo.getCredentials(
      drizzle.db,
      projectId,
    );

    return c.json(
      ok({
        provider: row?.provider ?? null,
        defaultModel: row?.defaultModel ?? null,
        baseUrl: row?.baseUrl ?? null,
        hasKey: Boolean(row?.apiKeyEncrypted),
        updatedAt: row?.updatedAt ?? null,
      }),
    );
  })

  // PUT / — OWNER only; encrypts and stores the API key
  .put("/", zValidator("json", upsertBody), async (c) => {
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const body = c.req.valid("json");

    if (!env.ENCRYPTION_KEY) {
      throw new HTTPException(500, {
        message: "ENCRYPTION_KEY is not configured on this server",
      });
    }

    const apiKeyEncrypted = encrypt(body.apiKey, env.ENCRYPTION_KEY);

    await drizzle.copilotCredentialRepo.upsertCredentials(drizzle.db, {
      projectId,
      provider: body.provider,
      apiKeyEncrypted,
      defaultModel: body.defaultModel,
      baseUrl: body.baseUrl ?? null,
      updatedByUserId: user.id,
    });

    return c.json(ok({ saved: true }));
  })

  // POST /test — OWNER only; decrypts, pings provider with 1 token
  .post("/test", async (c) => {
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const row = await drizzle.copilotCredentialRepo.getCredentials(
      drizzle.db,
      projectId,
    );
    if (!row) {
      throw new HTTPException(412, { message: "No credentials saved" });
    }

    if (!env.ENCRYPTION_KEY) {
      throw new HTTPException(500, {
        message: "ENCRYPTION_KEY is not configured on this server",
      });
    }

    const apiKey = decrypt(row.apiKeyEncrypted, env.ENCRYPTION_KEY);

    const resolved = await resolveProviderForProject({
      projectId,
      loadCreds: async () => ({
        provider: row.provider as "openai" | "anthropic" | "mistral" | "ollama",
        defaultModel: row.defaultModel,
        apiKey,
        baseUrl: row.baseUrl ?? undefined,
      }),
      env,
    });

    try {
      const { generateText } = await import("ai");
      await generateText({
        model: buildAiSdkModel(resolved),
        prompt: "ping",
        maxOutputTokens: 1,
      });
      return c.json(ok({ ok: true, model: resolved.model }));
    } catch (e) {
      throw new HTTPException(502, {
        message: `Provider rejected key: ${(e as Error).message}`,
      });
    }
  });
