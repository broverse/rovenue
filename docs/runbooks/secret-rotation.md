# Secret and key rotation runbook

The runbook `integrations-manual-qa.md` and `backup-restore.md` gesture at
and don't provide. Every variable below is documented in `.env.example`;
this is the *rotation* procedure for each, not the variable's meaning.

Most of this list is "generate a new value, update `.env`, restart the
service(s) that read it" — no data migration, no hazard beyond a brief
service restart. `ENCRYPTION_KEY` is the one genuine exception and gets its
own section first because getting it wrong is silent and permanent.

## `ENCRYPTION_KEY` — hazardous, read before touching

This is the AES-256-GCM key (`packages/shared/src/crypto.ts`) that encrypts
stored third-party credentials. It is **not** the same key that encrypts
backup artifacts (`BACKUP_AGE_RECIPIENT`/`BACKUP_AGE_IDENTITY` — see
[`backup-restore.md`](../operations/backup-restore.md), which is emphatic
that these must stay separate keypairs).

### What it actually protects: three tables, four columns, two wire shapes

An earlier version of this runbook said `projects` held the only encrypted
fields. **That was wrong**, and a rotation that followed it would have left
two tables encrypted under the compromised key with nothing to say so.
The full surface:

| Table | Column | Wire shape | Written by |
|---|---|---|---|
| `projects` | `appleCredentials` | **A** — tagged JSONB `{ v: 1, enc: "iv:tag:data" }` | `encryptCredential` |
| `projects` | `googleCredentials` | **A** — tagged JSONB `{ v: 1, enc: "iv:tag:data" }` | `encryptCredential` |
| `copilot_credentials` | `api_key_encrypted` | **B** — bare `"iv:tag:data"` text | `encrypt()` |
| `integration_connections` | `credentials_cipher` | **B** — bare `"iv:tag:data"` text | `encrypt(JSON.stringify(…))` |

**Shape A** is the wrapper in `packages/db/src/helpers/encrypted-field.ts`:
`encryptCredential` / `decryptCredential` / `isEncryptedCredential`.
`decryptCredential` also passes *unwrapped* plaintext JSON through, so rows
written before encryption was wired still read — and are encrypted for the
first time by a rotation run.

**Shape B** is a plain string produced by `encrypt()` from
`@rovenue/shared/crypto`. `isEncryptedCredential` returns **false** for
these — it requires an object with `v === 1`, and these are strings — so
shape B needs its own code path. Any tool that only knows shape A silently
skips both of these columns.

`projects.webhookSecret` is **not** in this list: it is stored in plaintext
and rotated on its own, from the dashboard
(`POST /dashboard/projects/:id/webhook-secret`). Better Auth's `twoFactor`
secrets are encrypted too, but with `BETTER_AUTH_SECRET`, not this key.

### Two values derived from this key that CANNOT be rotated

Re-encryption only helps where the key produced *reversible* ciphertext.
Two places key `ENCRYPTION_KEY` into a one-way HMAC, and no tool can
migrate those — plan around them, do not expect a script to fix them:

1. **`funnel_purchases.email_hash` / `funnel_claim_tokens.email_hash`**
   (`apps/api/src/services/funnel/token.ts`). A keyed hash of the buyer's
   email, derived from `ENCRYPTION_KEY`. Rotating the key changes the
   derivation, so **every stored hash is orphaned**: the magic-link recovery
   path (`POST /v1/sdk/claim-via-email`) stops finding pre-rotation
   purchases, silently — the lookup simply misses, exactly as the code's own
   comment warns. The plaintext email is *not* retained here (it lives in
   Stripe), so the hashes cannot be recomputed from the database alone.
   Either accept that pre-rotation purchases lose email claim, or re-derive
   the column from Stripe's records after the rotation.

   **Setting `ENCRYPTION_KEY` for the FIRST time is a rotation of this
   value.** When the variable is unset, `emailHashKey()` falls back to a
   fixed development label (`token.ts`) rather than failing, so a stack that
   has been running without the key still writes `email_hash` values — they
   are just derived from that label. The moment you set a real key, every
   one of those hashes is orphaned exactly as a rotation orphans them, and
   with the same silent symptom. This is the one case that can reach a
   *self-hosted* deployment by accident: it does not feel like a rotation,
   because there is no old key. If your stack has ever taken a funnel
   purchase without `ENCRYPTION_KEY` set, treat setting it as a rotation of
   this column and plan for the same loss. (`ENCRYPTION_KEY` is required in
   production for exactly this class of reason — see `.env.example`.)
2. **GDPR anonymous ids** (`apps/api/src/services/gdpr/anonymize-subscriber.ts`).
   `anon_…` ids are an HMAC of the subscriber id peppered with
   `ENCRYPTION_KEY`. Ids already written stay as they are; re-anonymizing the
   same subscriber after a rotation yields a *different* id, so the
   operation stops being idempotent across the rotation boundary. The code
   documents this as the intended trade-off.

### Why rotating is hazardous

Every stored credential is encrypted under whatever `ENCRYPTION_KEY` was
active when it was written. Changing `ENCRYPTION_KEY` in the environment
without first re-encrypting every existing row under the new key means the
*next* receipt verification, the next Copilot call, and the next integration
delivery decrypt garbage — and fail silently until something actually tries
to use them. There is no error at the moment you change the env var; the
failure surfaces later, per-project, at the worst possible time.

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

### The correct order of operations

1. Generate the new key: `openssl rand -hex 32`.
2. Take a backup **now**, under the old key, and confirm it restores. This
   is the only copy of the data that a botched rotation can be recovered
   from.
3. Dry-run the rotation and read the report:

   ```
   OLD_KEY=<current hex> NEW_KEY=<new hex> \
     pnpm --filter @rovenue/scripts rotate-encryption-key -- --dry-run
   ```

   `--dry-run` opens a transaction and rolls it back — it writes nothing.
   Do not proceed while it reports any `[FAIL]` line (see below).
4. Run it for real, **before** changing the running environment's
   `ENCRYPTION_KEY`. Decrypting under the old key must still work at the
   moment this step runs, which is why it comes first.

   ```
   OLD_KEY=<current hex> NEW_KEY=<new hex> \
     pnpm --filter @rovenue/scripts rotate-encryption-key
   ```

   Exit status 0 with `failed=0` is the only "clean". Any other outcome
   means stop and read the report.
5. Only after step 4 completes cleanly: update `ENCRYPTION_KEY` in the
   deployed environment and restart every service that reads it (`api`,
   `dispatcher`, and any worker that loads project credentials or delivers
   integrations).
6. **Run the rotation a second time, after the restart**, with the same
   `OLD_KEY` and `NEW_KEY`:

   ```
   OLD_KEY=<old hex> NEW_KEY=<new hex> \
     pnpm --filter @rovenue/scripts rotate-encryption-key
   ```

   On a clean rotation this is a no-op — idempotency guarantees it, and a
   clean second run reports `rotated=0 failed=0`. It is not optional: it is
   how a credential written during the step 4 → step 5 window gets rotated
   instead of becoming permanently unreadable (see the hazard below).
   `rotated>0` here means somebody did write during the window; the run
   fixes those rows, and you should tell the owner of each named row to
   confirm the credential in the dashboard still says what they saved.
7. Keep the **old** key retrievable in your secret store for as long as you
   retain backups taken before this rotation (see the backup-restore
   interaction above).

#### The window between step 4 and step 5 is unsafe for credential writes

The rotation reads and rewrites rows in one transaction while the API is
still live and still encrypting with the **old** key. Nothing coordinates
the two, and there are two distinct ways a credential saved during that
window is lost:

* **Clobbered.** The rotation has already read the row's old value when the
  dashboard writes a new one. The rotation's `UPDATE` lands afterwards and
  writes the re-encryption of the value it read — the operator's save is
  silently gone, with a `[OK]` line claiming success.
* **Missed.** The row is inserted *after* the rotation's `SELECT`. It is
  encrypted under the old key, the rotation never sees it, and it becomes
  undecryptable the moment step 5 flips the env var. Nothing reports this;
  it surfaces later as a failed receipt verification or integration
  delivery.

The same hazard covers everything between step 4 finishing and step 5's
restart completing, because every service is still writing with the old key
for that whole stretch.

**So: announce a freeze on credential and integration edits for the duration
of steps 4 and 5, and run step 6 afterwards regardless.** Step 6 recovers
the *missed* case (the row is still readable under `OLD_KEY`, so a second
run rotates it normally). It cannot recover the *clobbered* case — no tool
can, the plaintext is gone — which is why the freeze matters and why step 6
naming any row is worth a follow-up with whoever saved it.

`SELECT … FOR UPDATE` is deliberately **not** used here. It would not close
the missed case at all — a row that does not exist yet cannot be locked —
and for the clobbered case it only swaps which writer loses: the dashboard's
`UPDATE` would block until the rotation commits and then overwrite the
rotated row with an *old-key* ciphertext, which is a worse end state than
losing the edit. The cost of buying that is holding row locks on every
credential row of three tables for the length of the run, stalling live
requests. The freeze plus the second run closes what a lock cannot.

### What the tool does and does not guarantee

`scripts/rotate-encryption-key.ts` covers all four columns above, with a
separate code path per wire shape, and is proved against a disposable
Postgres built from `deploy/postgres/` in
`scripts/rotate-encryption-key.integration.test.ts`.

* **Atomic, therefore not "resumable" — because there is nothing to
  resume.** Every write happens inside one transaction. If the process is
  killed, the network drops, or Postgres restarts mid-run, the whole run
  rolls back and every row is still readable under `OLD_KEY` — the key the
  running API is still configured with. There is no half-rotated state to
  recover from and no checkpoint to pick up: you simply run it again from
  the start with the same `OLD_KEY`/`NEW_KEY`.
* **Idempotent.** A value that already decrypts under `NEW_KEY` is skipped,
  never re-encrypted. A second run performs zero writes (`rotated=0`). Run
  it again freely if you are unsure whether a previous attempt committed.
* **NOT safe against concurrent credential writes.** It takes no lock
  against the live API, which is still encrypting with the old key while it
  runs. See "the window between step 4 and step 5 is unsafe for credential
  writes" above: freeze credential and integration edits for the duration,
  and run the tool a second time after the restart.
* **Loud about rows it cannot read.** A value that decrypts under neither
  key is reported by table, column and row id, both as a `[FAIL]` line and
  in the closing summary, and the process exits 1. Those rows are left
  byte-for-byte untouched — never partially written, never dropped — and the
  healthy rows around them still rotate. The run does not abort on them: a
  row that decrypts under neither key will never rotate no matter how many
  times the tool runs, so aborting would only guarantee that the rows which
  *can* rotate never do.

  **If you see any `[FAIL]`, do not change the deployed `ENCRYPTION_KEY`.**
  Each named row is a credential that will be unreadable afterwards. Restore
  it from a backup taken under the key that wrote it, or delete the row and
  re-enter the credential from the dashboard, then re-run.

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
