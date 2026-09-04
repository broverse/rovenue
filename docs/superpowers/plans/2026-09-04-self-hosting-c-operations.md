# Self-hosting C — Upgrade, Backup/Restore & Asset Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three operating documents a self-hoster needs after install — how to upgrade, how to back up and actually restore, and how to check that the asset origin is serving the headers it claims — each backed by something that runs, not only prose.

**Architecture:** A header verifier that issues a real `HEAD` against a live object and exits non-zero naming what is missing. Backup and restore scripts covering Postgres, ClickHouse and object storage, encrypted at rest, with the encryption-key fingerprint recorded in the manifest so a restore into the wrong environment aborts instead of succeeding quietly. Two runbooks that name the specific traps this repo has already hit.

**Tech Stack:** TypeScript (tsx), Vitest + testcontainers (real Postgres, ClickHouse, MinIO), POSIX shell, `pg_dump`/`pg_restore`, ClickHouse native `BACKUP`/`RESTORE`, MinIO `mc`, `age`.

**Spec:** `docs/superpowers/specs/2026-09-04-self-hosting-packaging-design.md` — §6 (upgrade runbook), §7 (backup/restore), §8 (asset headers).

**Plan set:** Plan **C** of three. **A** (publishable images) is COMPLETE — `5d8d78fd..3622da85`. **B** (Coolify + Helm) is independent; this plan does not depend on it and can run before, after, or alongside.

## What already exists — do not rebuild it

| Fact | Where |
|---|---|
| `nosniff` is already documented for both hosts | `deploy/cloudflare/asset-headers/README.md` (Cloudflare Transform Rule), `deploy/caddy/conf.d/assets.caddy.example` (Caddy drop-in) |
| The ETag question is already settled | Same README: the store's own strong ETag is a content hash and stays correct for multipart uploads, which a rewritten one would not. **Do not add ETag rewriting.** |
| ClickHouse verification | `pnpm --filter @rovenue/db db:verify:clickhouse` |
| Migration routing | `db:migrate` self-routes; `db:migrate:fresh` must never touch an upgraded database |
| Asset config | `ASSET_PUBLIC_BASE_URL` is the public read origin; `ASSET_STORAGE_ENDPOINT` is the S3 write API. **Different hosts on R2, the same only on MinIO** |
| Testcontainers | `testcontainers@^10` is a devDependency of `apps/api`; see `apps/api/src/services/metrics/schema-contract.integration.test.ts` for the house pattern |

**The gap this plan closes for §8 is not documentation.** Both host configurations are already written down. They are *applied by hand and verified by hand*, and both fail silently: a Cloudflare Transform Rule scoped to the wrong hostname matches nothing, and `assets.caddy.example` does nothing at all until an operator copies it to `assets.caddy`.

## Global Constraints

- **Never switch or create git branches.** Work on the current branch; no worktrees. The user develops on `main` in parallel — stage only the paths a task owns, explicitly. Never `git add -A`, `git add .`, `git stash`, `git checkout .`, or `git restore`.
- **Throttle test runs.** `nice -n 19 npx vitest run --maxWorkers=2`; named files only. Integration tests here start real containers — run them one file at a time.
- **Docker may be unavailable.** Docker Desktop was down for part of Plan A. Any step needing containers must check first and, if it cannot run, report precisely what is unproven rather than claiming success.
- **No magic values.** Header names, expected values, exit codes, dump format flags, retry counts and the backup manifest's field names are named constants in one place per artifact.
- **No self-confirming tests.** The verifier is exercised against a real MinIO container serving a real object, and against a deliberately misconfigured origin that must make it fail. The backup scripts are exercised by an actual backup-then-restore against testcontainers Postgres and ClickHouse, comparing row counts — a mocked `pg_dump` would prove only that the script calls it.
- **Shell scripts** run under `set -euo pipefail` and must be `shellcheck`-clean at default severity. Note that `pipefail` is not POSIX `sh`; these scripts use `#!/usr/bin/env bash` deliberately, unlike the container entrypoint from Plan A.
- **Restore is destructive.** `restore.sh` must refuse to run against a database with existing Rovenue tables unless `--force` is given, and must never offer a table selector.
- TypeScript strict. Conventional commits.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/verify-asset-headers.ts` (create) | `HEAD` a real object; check nosniff, strong ETag, immutable cache, content-type; check a `PUT` is refused. Exit 1 naming each failure. |
| `apps/api/src/services/assets/asset-headers.integration.test.ts` (create) | Runs the verifier against a real MinIO container, positive and negative. |
| `deploy/clickhouse/config.d/backup.xml` (create) | Declares the `backups` disk so native `BACKUP`/`RESTORE` is available. |
| `deploy/backup/backup.sh` (create) | Postgres + ClickHouse + object storage, age-encrypted, writes `manifest.json`. |
| `deploy/backup/restore.sh` (create) | Fingerprint guard, service stop, ordered restore, CH detach/attach, verification. |
| `deploy/backup/backup-restore.integration.test.ts` (create) | Real round trip against testcontainers; row counts compared. |
| `docs/operations/backup-restore.md` (create) | What is and is not backed up, and why; the two things easy to get wrong; test-restore cadence. |
| `docs/operations/upgrade.md` (create) | Version-to-version procedure per install path; rollback stated plainly. |
| `docs/operations/deployment.md` (modify) | Point at both new runbooks; add the `assets.caddy` copy step to the self-host path. |

---

### Task 1: The asset-header verifier

**Files:**
- Create: `scripts/verify-asset-headers.ts`
- Modify: `scripts/package.json` (add the script entry)

**Interfaces:**
- Consumes: `ASSET_PUBLIC_BASE_URL` from the environment; an object key as `argv[2]` or `ASSET_VERIFY_KEY`.
- Produces: `pnpm verify:asset-headers <key>` — exit 0 all-pass, exit 1 with each failure named. Tasks 3, 5 and 6 reference it.

- [ ] **Step 1: Read what is already documented, so the checks match reality**

```bash
cd /Volumes/Development/rovenue
cat deploy/cloudflare/asset-headers/README.md
sed -n '1,80p' deploy/caddy/conf.d/assets.caddy.example
```

The expected header set and the ETag reasoning are settled there. Your job is to check what those documents promise — not to invent a new policy.

- [ ] **Step 2: Write the verifier**

Create `scripts/verify-asset-headers.ts`. Shape it as a pure check function plus a thin CLI, so Task 2's test can drive it without spawning a process:

```ts
/**
 * Verifies that the paywall asset origin actually serves the response
 * headers its configuration promises.
 *
 * The configurations already exist — deploy/cloudflare/asset-headers
 * (Transform Rule) and deploy/caddy/conf.d/assets.caddy.example — but
 * both are applied by hand and BOTH FAIL SILENTLY. A Transform Rule
 * scoped to the wrong hostname matches nothing; the Caddy drop-in does
 * nothing until an operator copies it into place. Nobody finds out.
 */

export const REQUIRED_HEADERS = {
  contentTypeOptions: "x-content-type-options",
  etag: "etag",
  cacheControl: "cache-control",
  contentType: "content-type",
} as const;

export const EXPECTED_NOSNIFF = "nosniff";
export const EXPECTED_CACHE_DIRECTIVE = "immutable";
/** A W/ prefix means a weak validator: conditional requests degrade. */
export const WEAK_ETAG_PREFIX = "W/";

export const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".json": "application/json",
};

export interface CheckFailure {
  check: string;
  detail: string;
}

export interface VerifyResult {
  url: string;
  failures: CheckFailure[];
}

export async function verifyAssetHeaders(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> { /* ... */ }
```

The checks, each producing a named failure rather than a bare throw:

1. `HEAD` returns 200.
2. `x-content-type-options` is exactly `nosniff`.
3. `etag` is present and does **not** start with `W/`.
4. `cache-control` contains `immutable`.
5. `content-type` matches the key's extension via `EXTENSION_CONTENT_TYPES`. An unknown extension is a failure that says so, not a silent pass.
6. A `PUT` to the same URL is refused (any 4xx or 405). This is the read-only guarantee both the Caddy block and the MinIO bucket policy claim; a `PUT` that succeeds means an anonymous write reached the bucket.

The CLI resolves the base URL from `ASSET_PUBLIC_BASE_URL` and the key from `argv[2] ?? process.env.ASSET_VERIFY_KEY`, prints one line per failure prefixed with the check name, and `process.exit(1)` when `failures.length > 0`. When everything passes it prints the URL and the four header values it saw, so a green run is still evidence.

- [ ] **Step 3: Add the script entry**

In `scripts/package.json`, add:

```json
    "verify:asset-headers": "tsx --env-file-if-exists=../.env verify-asset-headers.ts"
```

Match the `--env-file-if-exists` idiom the `@rovenue/db` package already uses, adjusting the relative path for `scripts/`.

- [ ] **Step 4: Run it against a deliberately wrong origin and confirm it fails by name**

```bash
cd /Volumes/Development/rovenue/scripts
ASSET_PUBLIC_BASE_URL=https://example.com npx tsx verify-asset-headers.ts /nope.webp; echo "exit=$?"
```

Expected: `exit=1`, with named failures. This is a smoke test of the failure path, not the real verification — Task 2 does that against a real object store.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add scripts/verify-asset-headers.ts scripts/package.json
git commit -m "feat(scripts): verify the asset origin serves the headers it promises

Both host configurations already exist and both fail silently — a
Cloudflare Transform Rule scoped to the wrong hostname matches nothing,
and the Caddy drop-in does nothing until an operator copies it into
place. This makes the claim measurable: a real HEAD against a real
object, each missing header named, exit 1.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Prove the verifier against a real object store

**Files:**
- Create: `apps/api/src/services/assets/asset-headers.integration.test.ts`
- Modify: `docs/operations/deployment.md`
- Modify: `deploy/caddy/conf.d/assets.caddy.example` (only if Step 3 finds a gap)

**Interfaces:**
- Consumes: Task 1's `verifyAssetHeaders`.
- Produces: the operator-facing wiring the later runbooks link to.

- [ ] **Step 1: Check Docker before writing anything**

```bash
docker version --format '{{.Server.Version}}' 2>&1 | head -2
```

If the daemon is down, **stop and report BLOCKED for this task specifically** — its entire value is running against a real container, and a version of it with a mocked `fetch` would be exactly the self-confirming test the constraints forbid. Tasks 3–6 do not depend on it and can proceed.

- [ ] **Step 2: Write the integration test**

Follow the house pattern in `apps/api/src/services/metrics/schema-contract.integration.test.ts` for container lifecycle and timeouts.

```ts
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAssetHeaders } from "../../../../../scripts/verify-asset-headers";
```

(Resolve the real relative path from the test's location; the import must reach `scripts/verify-asset-headers.ts` without copying it.)

Start MinIO, create a bucket, apply an anonymous **`s3:GetObject`-only** policy — hand-authored, not `mc anonymous set download`, which also grants `ListBucket` — and put one object with `Content-Type: application/json` and `Cache-Control: public, max-age=31536000, immutable`, matching what `AssetStore` sets at upload time.

Then assert:
- The happy path returns **zero** failures against the real object.
- A wrong key returns a failure naming the non-200.
- The negative direction: the bucket is **not** listable anonymously, and an anonymous `PUT` is refused — the verifier's check 6 must report a failure if it ever succeeds.

The Lottie case is the one that matters most: `application/json` is the single accepted asset type a browser could be talked into sniffing as something else, which is the whole reason `nosniff` is required.

- [ ] **Step 3: Run it and record what MinIO actually sends**

```bash
cd /Volumes/Development/rovenue
nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/assets/asset-headers.integration.test.ts
```

Expected: PASS. If MinIO does **not** send `nosniff` on object responses, the Cloudflare README's claim that it does is wrong — record the real observed headers in your report and say so, because that claim is what justifies calling the Caddy block "belt-and-braces" on a stock self-host.

- [ ] **Step 4: Make the Caddy drop-in discoverable**

`deploy/caddy/conf.d/assets.caddy.example` is inert until copied, and nothing in the deployment runbook says to copy it. Add the step to `docs/operations/deployment.md`'s self-host path — the copy, the hostname edit, `docker compose restart caddy`, and then the verification command from Task 1, with its expected output. Keep the file's own explanation of why the hostname cannot ship as a default (naming a site makes Caddy solicit an ACME certificate for it at startup).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add apps/api/src/services/assets/asset-headers.integration.test.ts docs/operations/deployment.md
git commit -m "test(assets): verify headers against a real MinIO, and wire the check in

The verifier now runs against a real object store serving a real object,
including the negative direction — anonymous PUT refused, bucket not
listable. The deployment runbook gains the assets.caddy copy step, which
was previously an inert .example nobody was told to enable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backup

**Files:**
- Create: `deploy/clickhouse/config.d/backup.xml`
- Create: `deploy/backup/backup.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a backup directory containing `manifest.json`, `postgres.dump.age`, `clickhouse/`, `assets/` — the exact layout Task 4's `restore.sh` reads. The manifest fields are the contract: `createdAt`, `rovenueVersion`, `encryptionKeyFingerprint`, `postgres`, `clickhouse`, `assets`, `skipped`.

- [ ] **Step 1: Declare the ClickHouse backup disk**

Create `deploy/clickhouse/config.d/backup.xml` declaring a `backups` disk and allowing it as a backup destination. Native `BACKUP`/`RESTORE` needs this; without it the only alternative is a per-table export that drifts from the schema every time a migration lands.

Mount it in the root `docker-compose.yml`'s clickhouse service — it already mounts `./deploy/clickhouse/config.d`, so the file is picked up automatically. Verify that, and say so rather than assuming:

```bash
cd /Volumes/Development/rovenue
grep -n "config.d" docker-compose.yml
```

- [ ] **Step 2: Write `backup.sh`**

`#!/usr/bin/env bash`, `set -euo pipefail`. Named constants at the top for every path fragment and filename. Behaviour:

1. **Refuse to run unencrypted by default.** Encrypt each artifact with `age` using `BACKUP_AGE_RECIPIENT`. `--allow-plaintext` is available — a local dump piped straight into a restore is a legitimate thing to do — but never the default. A Rovenue Postgres dump contains subscriber records, device identifiers, email addresses and purchase history, in a product that ships GDPR/KVKK tooling; producing an unencrypted copy of the entire subject database and leaving it on a disk would undo that at the first step.

2. **Record the encryption-key fingerprint, never the key.** `sha256` of `ENCRYPTION_KEY` into `manifest.json`. This is what makes Task 4's guard possible. Say in a comment why the age recipient must be a *different* key from `ENCRYPTION_KEY`: reusing the application's data key as the backup key means one compromise loses both.

3. **Postgres:** `pg_dump -Fc --no-owner`. Custom format so `pg_restore` can be selective on failure; `--no-owner` so a restore into a differently-named role works.

4. **ClickHouse:** `BACKUP DATABASE rovenue TO Disk('backups', '<name>')` over HTTP with the **write** user, not `rovenue_reader`.

5. **Object storage:** `mc mirror` from the configured alias into `assets/`.

6. **Redis and Redpanda are skipped, on purpose, and the script says so** — printing the reason rather than silently omitting them. BullMQ repeatable jobs re-arm themselves, but *delayed* jobs pending at backup time are lost. That belongs in the output, not only in the document.

7. Print a summary of what was written and its size. A backup script that says nothing is a backup script nobody notices has stopped working.

- [ ] **Step 3: Shellcheck and a dry run**

```bash
cd /Volumes/Development/rovenue
shellcheck deploy/backup/backup.sh && echo "shellcheck clean"
bash -n deploy/backup/backup.sh && echo "syntax ok"
./deploy/backup/backup.sh --help
```

Expected: shellcheck silent at default severity, syntax ok, `--help` explains the flags including `--allow-plaintext` and what it costs.

- [ ] **Step 4: Prove the plaintext refusal actually refuses**

```bash
cd /Volumes/Development/rovenue
BACKUP_AGE_RECIPIENT= ./deploy/backup/backup.sh --out /tmp/bk-probe; echo "exit=$?"
```

Expected: non-zero, with a message naming `BACKUP_AGE_RECIPIENT` and mentioning `--allow-plaintext`. Then confirm the escape hatch works as far as the argument check (it will fail later for want of a database, which is fine and expected at this stage — say so in your report). Clean up `/tmp/bk-probe`.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/clickhouse/config.d/backup.xml deploy/backup/backup.sh
git commit -m "feat(backup): encrypted backup of Postgres, ClickHouse and assets

ClickHouse is backed up, not treated as derived data: outbox rows are
deleted after dispatch, so the event history that produced the analytics
tables no longer exists in Postgres and a lost ClickHouse is permanently
lost analytics.

Artifacts are age-encrypted by default — the dump holds subscriber PII in
a product that ships GDPR/KVKK tooling. The manifest records the SHA-256
fingerprint of ENCRYPTION_KEY (never the key), which is what lets restore
refuse a wrong-key environment.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Restore, with the guards that make it survivable

**Files:**
- Create: `deploy/backup/restore.sh`

**Interfaces:**
- Consumes: Task 3's backup layout and `manifest.json` fields.
- Produces: the procedure Task 5's document describes.

- [ ] **Step 1: Write `restore.sh`**

`#!/usr/bin/env bash`, `set -euo pipefail`. The order and the guards are the whole content:

1. **Fingerprint guard, first.** Compare `manifest.json`'s `encryptionKeyFingerprint` against the `sha256` of the `ENCRYPTION_KEY` in the environment being restored into. A mismatch **aborts**, printing both fingerprints. A missing key aborts.

   A restore with the *wrong* key is worse than one with a lost key: it succeeds, and the damage only surfaces the next time a receipt is verified. A warning cannot fix that, because the person restoring at 3am is the person who skims warnings.

2. **Stop the api, dispatcher and workers** before touching anything, and stop the dispatcher specifically for the duration of the ClickHouse step (see 5).

3. **Refuse to run against a database with existing Rovenue tables** unless `--force`. No table selector, ever: `audit_logs` is a per-project SHA-256 hash chain, and restoring some tables from one snapshot and others from another breaks it with no repair. Whole-database only.

4. **Postgres → object storage → ClickHouse.** Postgres first because it is the only store the others are consistent *against*; ClickHouse last because the api may re-drive outbox rows on start.

5. **ClickHouse restores with the Kafka-facing objects detached.** `BACKUP DATABASE` captures the Kafka Engine tables and their materialised views along with the data tables. On restore those start consuming from the topic immediately, at whatever offset the consumer group happens to hold — re-ingesting events the restored data tables already contain. So: detach them, restore, re-attach. This also interacts with the known hazard that recreating a Kafka-fed materialised view loses in-flight events, which is why the dispatcher is stopped for the duration: the outbox holds rather than the topic dropping.

6. **Verification is part of restore, not a separate step.** Row counts on the tables the script names, `pnpm --filter @rovenue/db db:verify:clickhouse`, and the asset-header check from Task 1.

- [ ] **Step 2: Shellcheck and the guard probes**

```bash
cd /Volumes/Development/rovenue
shellcheck deploy/backup/restore.sh && echo "shellcheck clean"
```

Then prove the fingerprint guard fires — this is the guard that justifies the whole design, so a probe is not optional:

```bash
cd /Volumes/Development/rovenue
mkdir -p /tmp/bk-fake
printf '{"encryptionKeyFingerprint":"%s"}\n' "$(printf 'aaaa' | shasum -a 256 | cut -d' ' -f1)" > /tmp/bk-fake/manifest.json
ENCRYPTION_KEY=bbbb ./deploy/backup/restore.sh --from /tmp/bk-fake; echo "exit=$?"
ENCRYPTION_KEY= ./deploy/backup/restore.sh --from /tmp/bk-fake; echo "exit=$?"
rm -rf /tmp/bk-fake
```

Expected: the first aborts naming BOTH fingerprints; the second aborts saying the key is unset. Neither may proceed to touching a database.

- [ ] **Step 3: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/backup/restore.sh
git commit -m "feat(backup): restore, guarded by the encryption-key fingerprint

A restore with the WRONG key is worse than one with a lost key: it
succeeds, and the damage surfaces the next time a receipt is verified.
So the manifest's fingerprint is compared against the target
environment's ENCRYPTION_KEY and a mismatch aborts naming both.

Whole-database only — audit_logs is a per-project hash chain and a
mixed-snapshot restore breaks it with no repair. ClickHouse restores
with the Kafka engine tables detached, or they resume consuming and
re-ingest events the restored tables already hold.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Prove backup and restore actually round-trip

**Files:**
- Create: `deploy/backup/backup-restore.integration.test.ts`
- Create: `docs/operations/backup-restore.md`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: the document Task 6's upgrade runbook links to for its rollback step.

- [ ] **Step 1: Check Docker; if it is down, do the document and report the test BLOCKED**

```bash
docker version --format '{{.Server.Version}}' 2>&1 | head -2
```

The document does not need containers. The test does, and there is no honest substitute — a backup pipeline that has never restored is exactly what this task exists to disprove.

- [ ] **Step 2: Write the round-trip test**

Start a real Postgres (the `rovenue-postgres` image if it can be built, else `postgres:16`) and a real ClickHouse. Create a small schema with known row counts, run `backup.sh` against them, drop everything, run `restore.sh`, and compare row counts before and after — plus one row's content, so a restore that creates empty tables cannot pass.

Assert the fingerprint guard in the same test: restoring the same backup with a different `ENCRYPTION_KEY` must fail, and the failure must be non-zero exit, not a warning.

Give the test a generous timeout and start containers once in `beforeAll`.

- [ ] **Step 3: Run it**

```bash
cd /Volumes/Development/rovenue
nice -n 19 npx vitest run --maxWorkers=2 deploy/backup/backup-restore.integration.test.ts
```

If the test file is outside the vitest include globs of any package, say which config you added it to and why, rather than moving the scripts.

- [ ] **Step 4: Write `docs/operations/backup-restore.md`**

Open with the `ENCRYPTION_KEY` warning, then the table of what is and is not backed up with the reason per row — including, stated plainly, that **ClickHouse is not derived data**: outbox rows are deleted after dispatch, so a lost ClickHouse is permanently lost analytics history. Then the two things easy to get wrong (§7.2), the restore order and why (§7.5), and the **quarterly test restore** as a calendar obligation with its procedure: restore into a throwaway environment, run `db:verify:clickhouse`, compare the row counts the script prints against the source, check the audit chain verifies.

Scheduling belongs to the operator: give a cron example and a compose `backup` profile, state a retention recommendation, and do not implement rotation.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add deploy/backup/backup-restore.integration.test.ts docs/operations/backup-restore.md
git commit -m "test(backup): a real backup-then-restore round trip, and the runbook

Row counts and one row's content compared across a real backup, drop and
restore against testcontainers Postgres and ClickHouse — a mocked pg_dump
would prove only that the script calls it. The fingerprint guard is
asserted in the same test.

The document states the quarterly test restore as a calendar obligation:
a backup nobody has restored is not a backup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The upgrade runbook

**Files:**
- Create: `docs/operations/upgrade.md`
- Modify: `docs/operations/deployment.md`

**Interfaces:**
- Consumes: Task 1's verifier, Task 5's document, and — if Plan B has landed — its Coolify and Helm paths. If Plan B has **not** landed, write the compose path in full and mark the other two as forthcoming rather than inventing commands for artifacts that do not exist.

- [ ] **Step 1: Check what install paths actually exist**

```bash
cd /Volumes/Development/rovenue
ls deploy/coolify deploy/helm 2>/dev/null || echo "Plan B has not landed — document the compose path only"
```

- [ ] **Step 2: Write `docs/operations/upgrade.md`**

Cover, in this order:

- **Pin the version.** `latest` is for a first install; upgrades name a tag.
- **Read the release notes for breaking changes** before anything else, and specifically for a **downtime-required** marker.
- **Back up first** — this is the rollback plan; link to Task 5's document.
- **Order of operations per install path.** Compose: `docker compose pull`, `docker compose run --rm migrate`, then `up -d`. Coolify: redeploy with the new tag. Helm: `helm upgrade` — the `pre-upgrade` hook Job handles ordering.
- **The expand/contract policy**, referencing `.github/CONTRIBUTING.md` (added in Plan A). Explain the operator-facing consequence: migrations run before the new version finishes rolling out, so during a rolling update the old image serves against the new schema. A release that cannot be expand/contract is marked downtime-required, and the procedure for those is scale-to-zero, migrate, scale-up.
- **Migration routing.** `db:migrate` self-routes. **Never point `db:migrate:fresh` at a database that has been upgraded** — it dedupes by content hash while drizzle uses a `created_at` watermark, and four migration files were edited after they were applied.
- **ClickHouse migrations run from inside the compose network**, never from the host: Docker Desktop traffic arrives from `192.168.65.1`, which the allow-list rejects and which surfaces to clients as *"password is incorrect"*. Include the socat bridge recipe for one-offs.
- **Recreating a Kafka-fed materialised view loses in-flight events.** Pause the corresponding `*_queue` consumer first, or backfill from Postgres. Any release whose notes mention a ClickHouse MV change needs this.
- **`caddy-data` must persist** — losing it re-issues every certificate and risks Let's Encrypt rate limits. Name it for compose volumes, Coolify persistent storage, and the chart's PVC.
- **Rollback, stated plainly.** Postgres migrations are forward-only; there are no down-migrations. Rolling back the image is safe only when the release notes say the schema is unchanged. Otherwise rollback means restoring the backup from step 3. Pretending otherwise would be the most expensive sentence in this document.
- **Post-upgrade verification checklist**, ending in `pnpm verify:asset-headers`.

- [ ] **Step 3: Cross-link and re-check the existing runbook for staleness**

Add pointers from `docs/operations/deployment.md` to both new documents. While you are in that file, verify every claim in its prerequisites section is still true after Plan A — the Apple certificate prerequisite was already corrected there, so check the rest rather than assuming it was the only one. Report what you checked.

- [ ] **Step 4: Verify every command you wrote is real**

Do not ship a runbook containing a command that does not exist. For each one, confirm the script or flag is present:

```bash
cd /Volumes/Development/rovenue
grep -n '"db:migrate"\|"db:migrate:fresh"\|"db:verify:clickhouse"\|"db:clickhouse:migrate"' packages/db/package.json
grep -n '"verify:asset-headers"' scripts/package.json
grep -n "COMPOSE_PROFILES\|profiles" docker-compose.yml | head -3
```

Any command in the document that does not resolve here is a defect — fix the document, not the check.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Development/rovenue
git status --short
git add docs/operations/upgrade.md docs/operations/deployment.md
git commit -m "docs(ops): the version upgrade runbook

Order of operations per install path, the expand/contract consequence
for rolling updates, the db:migrate:fresh prohibition, the ClickHouse
allow-list error that reports itself as a wrong password, and the Kafka
MV recreation gap.

Rollback is stated plainly rather than implied: Postgres migrations are
forward-only, so rolling back the image is safe only when the notes say
the schema is unchanged — otherwise rollback means restoring the backup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `pnpm verify:asset-headers <key>` passes against a correctly configured origin and exits 1 naming each missing header against a misconfigured one, proven against a real MinIO container in both directions.
- `deploy/backup/backup.sh` refuses to write plaintext without `--allow-plaintext` and records the encryption-key fingerprint.
- `deploy/backup/restore.sh` aborts on a fingerprint mismatch and on a missing key, naming both values, before touching any database.
- A real backup-then-restore round trip against testcontainers Postgres and ClickHouse restores identical row counts and content.
- Both shell scripts are shellcheck-clean at default severity.
- `docs/operations/upgrade.md` and `backup-restore.md` exist, are linked from `deployment.md`, and every command in them resolves to a real script or flag.

**Not verifiable from here:** no production-scale database, no R2 account, and no ClickHouse instance holding real analytics volume. The round-trip test proves the mechanism on small data; it does not prove `pg_dump` timings or ClickHouse backup sizes at production scale, and the runbooks should not imply otherwise.
