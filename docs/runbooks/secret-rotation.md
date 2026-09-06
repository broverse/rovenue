# Secret and key rotation runbook

The runbook `integrations-manual-qa.md` and `backup-restore.md` gesture at
and don't provide. Every variable below is documented in `.env.example`;
this is the *rotation* procedure for each, not the variable's meaning.

Most of this list is "generate a new value, update `.env`, restart the
service(s) that read it" — no data migration, no hazard beyond a brief
service restart. `ENCRYPTION_KEY` is the one genuine exception and gets its
own section first because getting it wrong is silent and permanent.

## `ENCRYPTION_KEY` — hazardous, read before touching

This is the AES-256-GCM key that encrypts stored Apple/Google project
credentials (`appleCredentials`/`googleCredentials` JSONB columns —
`packages/db/src/helpers/encrypted-field.ts`). It is **not** the same key
that encrypts backup artifacts (`BACKUP_AGE_RECIPIENT`/`BACKUP_AGE_IDENTITY`
— see [`backup-restore.md`](../operations/backup-restore.md), which is
emphatic that these must stay separate keypairs).

**Why rotating it is hazardous:** every stored credential is encrypted
under whatever `ENCRYPTION_KEY` was active when it was written. Changing
`ENCRYPTION_KEY` in the environment without first re-encrypting every
existing row under the new key means the *next* receipt verification for
any project decrypts garbage instead of Apple/Google credentials — and
fails silently until something actually tries to use them. There is no
error at the moment you change the env var; the failure surfaces later,
per-project, at the worst possible time.

**Also relevant:** [`backup-restore.md`](../operations/backup-restore.md)
documents that `restore.sh` refuses to restore a backup whose manifest's
`ENCRYPTION_KEY` fingerprint doesn't match the fingerprint of the key in the
environment being restored into. That means: once you rotate
`ENCRYPTION_KEY`, **every backup taken under the old key becomes
unrestorable into a normally-configured environment** — the restoring
environment would need the *old* key set temporarily to pass that check.
Plan a rotation around your backup retention window, not independently of
it: either keep the old key retrievable (in the same secret store) for as
long as you retain backups taken under it, or accept that those older
backups are only restorable by an operator who still has both keys on hand.

**The correct order of operations:**

1. Generate the new key: `openssl rand -hex 32`.
2. Re-encrypt every stored credential **in place, in the database**, from
   the old key to the new key — **before** changing the running
   environment's `ENCRYPTION_KEY`. Decrypting under the old key must still
   work at the moment this step runs, which is why it comes first.
3. Only after step 2 completes cleanly: update `ENCRYPTION_KEY` in the
   deployed environment and restart every service that reads it (`api`,
   `dispatcher`, and any worker that loads project credentials).
4. Keep the **old** key retrievable in your secret store for as long as you
   retain backups taken before this rotation (see the backup-restore
   interaction above).

**The tool for step 2 does not currently work.**
`scripts/rotate-encryption-key.ts` is intended to do exactly this — decrypt
every project's credentials with `OLD_KEY` and re-encrypt with `NEW_KEY`,
idempotently. Verified today, executed in this session:

```
$ pnpm --filter @rovenue/scripts typecheck
rotate-encryption-key.ts(18,8): error TS1192: Module '.../packages/db/src/index' has no default export.
```

The script does `import prisma, { ... } from "@rovenue/db"` — a leftover
from before this codebase moved to Drizzle (see CLAUDE.md: "Drizzle not
Prisma"). `@rovenue/db` has no default export at all, and the script's own
`CREDENTIAL_FIELDS` list includes `stripeCredentials`, a column that
doesn't exist in the schema (`appleCredentials`/`googleCredentials` are the
only two encrypted JSONB fields on `projects` — Stripe uses Connect OAuth,
not a stored encrypted credential). **Do not run this script as-is in
production.** The three real building blocks it should be rewritten around
already exist and do work — `encryptCredential`, `decryptCredential`, and
`isEncryptedCredential`, all exported from `@rovenue/db`
(`packages/db/src/helpers/encrypted-field.ts`) — a corrected version would
use Drizzle to select/update `projects.appleCredentials`/`googleCredentials`
directly instead of a Prisma client that isn't part of this stack. Until
that rewrite happens, a from-scratch rotation script (or a one-off
`tsx` invocation using those three exports directly) is required — do not
assume the shipped script is a working tool.

## Session and signing secrets (safe: rotate, restart, done — but invalidates active state)

| Variable | Rotating it invalidates | Rotate by |
|---|---|---|
| `BETTER_AUTH_SECRET` | Every active dashboard session (Better Auth encrypts sessions with it) | Generate new (`openssl rand -hex 32`), update `.env`, restart `api`. Every logged-in dashboard user is signed out. |
| `UNSUB_SIGNING_KEY` | Every outstanding one-click-unsubscribe link already sent in an email | Generate new (`openssl rand -hex 32`), update `.env`, restart `api`/`send-email-worker`. Old links 404/fail signature verification; new sends get valid links immediately. |
| `EDGE_CACHE_PURGE_SECRET` | The Cloudflare edge-cache Worker's ability to accept purge calls until both sides agree | Rotate `wrangler secret put PURGE_SECRET` on the Worker **and** `.env`'s `EDGE_CACHE_PURGE_SECRET` together — mismatched values fail purges silently (best-effort, no alert) until the 60s TTL expires them anyway. |

## Infrastructure passwords

| Variable | Rotate by |
|---|---|
| `POSTGRES_PASSWORD` | Requires changing the role's password inside Postgres itself (`ALTER ROLE ... PASSWORD ...`) in addition to `.env` — `docker-compose.yml`'s `POSTGRES_PASSWORD` env var only seeds the role on first container init; on an existing volume it has no effect. Update `.env`, run the `ALTER ROLE`, then update `DATABASE_URL` everywhere it's set and restart every service that connects (`api`, `dispatcher`, all workers, `migrate`). |
| `CLICKHOUSE_PASSWORD_SHA256` / `CLICKHOUSE_READER_PASSWORD_SHA256` | ClickHouse user config lives in `deploy/clickhouse/users.d/rovenue.xml`, read from these SHA-256 hashes at startup only — `docker compose restart clickhouse` is required for a new hash to take effect (the same restart `upgrade.md` §3 already documents for an unrelated reason). Compute the new hash with `echo -n 'new-password' \| sha256sum \| awk '{print $1}'`, update both the `_SHA256` var (for `clickhouse`) and the matching plaintext `CLICKHOUSE_PASSWORD`/`CLICKHOUSE_WRITE_PASSWORD` (for `api`/`migrate`), then restart `clickhouse` followed by every service that authenticates against it. |
| `REDIS_URL` (if you add auth) | This stack ships Redis with no password by default (`REDIS_URL: redis://redis:6379` in `docker-compose.yml`, no `requirepass`). If you add one for a network-exposed Redis, update `.env` and restart every service that connects — `api`, all workers, `dispatcher`. |
| `ASSET_STORAGE_ACCESS_KEY_ID` / `ASSET_STORAGE_SECRET_ACCESS_KEY` | These are also MinIO's root credentials (`docker-compose.yml`'s `minio`/`minio-init` services read the same two vars). Rotating them for a self-hosted MinIO means updating the MinIO server's own credential store, not just `.env` — a root-password change on a running MinIO requires `mc admin user`/`mc admin config` against the instance, not a container restart alone. If you're on R2 instead, rotate the R2 API token in the Cloudflare dashboard and update `.env` only. |

## Third-party API keys and webhook secrets

These rotate entirely on the provider's side plus a `.env` update and a
restart of whatever reads them — no data migration:

- `GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` — dashboard OAuth login;
  restart `api`. Existing dashboard sessions are unaffected (only new OAuth
  handshakes use the new secret).
- `STRIPE_PLATFORM_SECRET_KEY(_TEST)`, `STRIPE_CONNECT_WEBHOOK_SECRET`,
  `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET` — rotate in
  the Stripe dashboard first, then `.env`, then restart `api`. A webhook
  secret rotated in `.env` before Stripe's dashboard confirms it will
  reject every incoming webhook with a signature-verification failure in
  the gap.
- `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`, `AWS_SES_*` — same pattern:
  provider-side rotation, then `.env`, then restart `send-email-worker`.
- `APNS_KEY_ID`/`APNS_KEY_P8` (Apple Developer portal), `FCM_SERVICE_ACCOUNT_JSON`
  (Firebase/GCP service account) — restart `send-push-worker` after
  updating `.env`. A revoked-but-not-yet-rotated key surfaces as the
  `ExpiredProviderToken`/auth-refresh failures already covered in
  [`notifications.md`](./notifications.md#scenario-2--push-transport-down).

## Backup encryption keys

`BACKUP_AGE_RECIPIENT` / `BACKUP_AGE_IDENTITY` are covered in full in
[`backup-restore.md`](../operations/backup-restore.md) — generate a fresh
`age` keypair, keep the **old** identity file retrievable for as long as
you retain backups encrypted under it (an `age`-encrypted backup can only
be decrypted with the identity that matches the recipient key it was
encrypted for), and never let this become the same keypair as
`ENCRYPTION_KEY` (the two protect different things and a shared compromise
would lose both the live data and every backup at once).
