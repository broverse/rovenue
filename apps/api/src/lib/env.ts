import { z } from "zod";

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
    DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    BETTER_AUTH_SECRET: z.string().min(1).optional(),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
    DASHBOARD_URL: z.string().url().default("http://localhost:5173"),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    PUBSUB_PUSH_AUDIENCE: z.string().min(1).optional(),
    PUBSUB_PUSH_SERVICE_ACCOUNT: z.string().email().optional(),
    // 32-byte AES-256-GCM key, hex-encoded (64 chars). Required in
    // production for project credential encryption.
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "32 bytes in hex (64 chars)")
      .optional(),
    // Directory containing Apple root CA certs (AppleRootCA-G3.cer etc).
    // Required in production for SignedDataVerifier chain validation.
    APPLE_ROOT_CERTS_DIR: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== "production") return;

    const require = (
      value: string | undefined,
      key: string,
      reason: string,
    ): void => {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required in production — ${reason}`,
          path: [key],
        });
      }
    };

    require(
      data.ENCRYPTION_KEY,
      "ENCRYPTION_KEY",
      "project credentials must be encrypted at rest",
    );
    require(
      data.PUBSUB_PUSH_AUDIENCE,
      "PUBSUB_PUSH_AUDIENCE",
      "Google webhook must verify the Pub/Sub OIDC token",
    );
    require(
      data.APPLE_ROOT_CERTS_DIR,
      "APPLE_ROOT_CERTS_DIR",
      "Apple JWS x5c chain must be validated against Apple's root CA",
    );
    require(
      data.BETTER_AUTH_SECRET,
      "BETTER_AUTH_SECRET",
      "session encryption key must be set",
    );
  });

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
