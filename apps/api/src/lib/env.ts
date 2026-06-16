import { z } from "zod";

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    // Internal-only port for the Caddy on-demand-TLS ask endpoint.
    // Bind to a separate listener so it's never reachable from the
    // public network — Caddy hits it over the docker network only.
    INTERNAL_PORT: z.coerce.number().int().positive().default(3001),
    // Comma-separated list of hostnames that the canonical edge
    // also serves. Used by the on-demand-TLS guard to refuse cert
    // issuance for anything outside (custom domains | canonical).
    CANONICAL_HOSTS: z
      .string()
      .default("rovenue.io,edge.rovenue.io")
      .transform((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
    DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    // ClickHouse read replica for analytics. Optional in dev (analytics
    // router degrades to "no data" responses); required in production.
    CLICKHOUSE_URL: z.string().url().optional(),
    CLICKHOUSE_USER: z.string().min(1).default("rovenue_reader"),
    CLICKHOUSE_PASSWORD: z.string().min(1).optional(),
    // Redpanda/Kafka brokers — comma-separated host:port list
    // consumed by kafkajs. Optional in dev (the outbox-dispatcher
    // worker logs and exits cleanly if missing — OLTP writes still
    // land in outbox_events, pending a dispatcher). Required in
    // production; without it exposure events never reach CH.
    KAFKA_BROKERS: z.string().min(1).optional(),
    // Gates the in-process outbox→Kafka dispatcher loop. Default true
    // (every instance runs it, as before). Set to "false" on all but one
    // instance when scaling the API horizontally so only a single
    // dispatcher publishes — delivery is at-least-once, so multiple
    // dispatchers merely re-publish (collapsed downstream by the 0012
    // idempotent CH views) and waste load.
    OUTBOX_DISPATCHER_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    // Optional global edge cache (Cloudflare edge-cache Worker, see
    // deploy/cloudflare/edge-cache). When both are set, catalog
    // mutations POST a per-project purge so cached /v1/offerings
    // responses are invalidated worldwide. Unset → purge is a no-op
    // (self-host without a CDN keeps working unchanged).
    EDGE_CACHE_PURGE_URL: z.string().url().optional(),
    EDGE_CACHE_PURGE_SECRET: z.string().min(1).optional(),
    BETTER_AUTH_SECRET: z.string().min(1).optional(),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
    DASHBOARD_URL: z.string().url().default("http://localhost:5173"),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    PUBSUB_PUSH_AUDIENCE: z.string().min(1).optional(),
    PUBSUB_PUSH_SERVICE_ACCOUNT: z.string().email().optional(),
    // Accepted clock skew (seconds) between a webhook event's
    // timestamp and our wall clock. Deliveries outside this window
    // are rejected by the replay-guard middleware.
    WEBHOOK_REPLAY_TOLERANCE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3600)
      .default(300),
    // 32-byte AES-256-GCM key, hex-encoded (64 chars). Required in
    // production for project credential encryption.
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "32 bytes in hex (64 chars)")
      .optional(),
    // Directory containing Apple root CA certs (AppleRootCA-G3.cer etc).
    // Required in production for SignedDataVerifier chain validation.
    APPLE_ROOT_CERTS_DIR: z.string().optional(),
    // Legacy shadow-read toggle retained for future cross-DB
    // comparisons. No-op while Drizzle is the sole ORM.
    DB_SHADOW_READS: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    // OpenExchangeRates app_id for the daily FX worker. Free tier
    // is USD-base + /latest only — exactly what we need. When blank
    // the worker logs and skips the fetch; convertToUsd then falls
    // through to Redis cache → Postgres fx_rates → static table.
    OPEN_EXCHANGE_RATES_APP_ID: z.string().min(1).optional(),
    // ---- Amazon SES (optional; enables transactional emails) ----
    // Credentials come from the default AWS SDK provider chain
    // (env vars, EC2/ECS/Fargate IAM role, ~/.aws/credentials).
    AWS_SES_REGION: z.string().min(1).default("us-east-1"),
    AWS_SES_FROM_EMAIL: z.string().email().optional(),
    AWS_SES_CONFIGURATION_SET: z.string().min(1).optional(),
    AWS_SES_EVENTS_VERIFY_SIGNATURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    // ---- Billing (Stripe) --------------------------------------------------
    // Set BILLING_ENABLED=true to activate the /billing routes and Stripe
    // integration. When false (default) all billing endpoints return 404 and
    // no Stripe client is initialised.
    BILLING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    STRIPE_BILLING_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_BILLING_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_BILLING_PUBLISHABLE_KEY: z.string().min(1).optional(),
    STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID: z.string().min(1).optional(),
    // ---- Email transport selection -----------------------------
    // EMAIL_PROVIDER picks the Mailer impl. "ses" is the default
    // (uses AWS_SES_* above). "smtp" enables the nodemailer path
    // for self-hosted instances without AWS credentials.
    EMAIL_PROVIDER: z.enum(["ses", "smtp"]).default("ses"),
    // Overrides AWS_SES_FROM_EMAIL when set (also required by the
    // SMTP path which has no SES equivalent).
    EMAIL_FROM: z.string().email().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // ---- Unsubscribe-link signing -----------------------------
    // 32-byte hex key used to HMAC-SHA256 the one-click
    // unsubscribe payloads embedded in List-Unsubscribe headers.
    // Required in production for the public unsubscribe flow.
    UNSUB_SIGNING_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "32 bytes in hex (64 chars)")
      .optional(),
    // Static mailbox advertised in the `mailto:` half of the
    // List-Unsubscribe header. Inbox providers fall back to this
    // when the one-click URL is unreachable; the address is read
    // by an ops mailbox that forwards to the suppression worker.
    UNSUB_MAILTO: z.string().email().default("unsubscribe@rovenue.io"),
    // ---- Push notifications (optional; enables iOS push) -------
    // Token-based APNs auth. APNS_KEY_P8 is the .p8 file contents
    // verbatim (BEGIN/END lines included); APNS_ENVIRONMENT picks
    // the production gateway vs the sandbox host TestFlight uses.
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    APNS_KEY_P8: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),
    APNS_ENVIRONMENT: z
      .enum(["production", "sandbox"])
      .default("production"),
    // ---- Push notifications (optional; enables Android push) ---
    // FCM v1 HTTP API. Service-account JSON pasted verbatim into
    // the env var so secrets stay in the same place as everything
    // else. The factory parses it lazily on first use.
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
    // ---- Rovi (AI copilot) ------------------------------------------------
    // Self-host: set ROVI_UNLIMITED=true to disable tier quotas.
    // Cloud: leave false and set ROVI_TIER per deployment if not stored in
    // projects.metadata. Defaults to false (cloud safety, quota enforcement).
    ROVI_UNLIMITED: z.coerce.boolean().default(false),
    ROVI_TIER: z.enum(["free", "team", "business", "enterprise"]).optional(),
    ROVI_RATE_LIMIT_PER_USER: z.coerce.number().int().positive().default(30),
    ROVI_MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    // Optional operator-funded fallback when a project has no BYOK
    // credentials.
    ROVI_DEFAULT_PROVIDER: z
      .enum(["openai", "anthropic", "mistral", "ollama"])
      .optional(),
    ROVI_DEFAULT_MODEL: z.string().optional(),
    ROVI_DEFAULT_API_KEY: z.string().optional(),
    ROVI_DEFAULT_BASE_URL: z.string().url().optional(),
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
      data.DATABASE_URL,
      "DATABASE_URL",
      "the API cannot serve any request without a Postgres connection",
    );
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
    require(
      data.UNSUB_SIGNING_KEY,
      "UNSUB_SIGNING_KEY",
      "one-click unsubscribe links must be signed",
    );
    require(
      data.CLICKHOUSE_URL,
      "CLICKHOUSE_URL",
      "analytics queries require a ClickHouse cluster in production",
    );
    require(
      data.CLICKHOUSE_PASSWORD,
      "CLICKHOUSE_PASSWORD",
      "analytics reader must authenticate in production",
    );
    require(
      data.KAFKA_BROKERS,
      "KAFKA_BROKERS",
      "analytics ingestion requires a Kafka/Redpanda cluster in production",
    );

    if (data.BILLING_ENABLED) {
      require(
        data.STRIPE_BILLING_SECRET_KEY,
        "STRIPE_BILLING_SECRET_KEY",
        "BILLING_ENABLED=true requires a Stripe secret key in production",
      );
      require(
        data.STRIPE_BILLING_WEBHOOK_SECRET,
        "STRIPE_BILLING_WEBHOOK_SECRET",
        "BILLING_ENABLED=true requires a Stripe webhook secret in production",
      );
      require(
        data.STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID,
        "STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID",
        "BILLING_ENABLED=true requires the Indie monthly Stripe price id",
      );
    }
  });

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
