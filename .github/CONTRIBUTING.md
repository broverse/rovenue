# Contributing to Rovenue

Thanks for your interest in contributing!

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Run `pnpm test` before opening a PR
- Open an issue to discuss large changes first
- All code must pass TypeScript strict mode

## Expand/contract schema changes

Migrations run **before** the new application version finishes rolling out —
`pre-upgrade` on Helm, `docker compose run migrate` before `up -d` on compose.
For the length of that rollout the **old image is still serving, against the
new schema**. A migration that drops or renames a column therefore breaks
every still-running old pod.

So schema changes land in three separate releases:

1. **Expand.** Add the new column or table, nullable or defaulted. Old and new
   code both work.
2. **Migrate.** New code writes both shapes and backfills the old rows.
3. **Contract.** Only once no running version reads the old shape, drop it.

`DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN` and `SET NOT NULL` may never
appear in the same release that introduces their replacement.
`packages/db/src/migration-policy.test.ts` enforces this. When a migration
genuinely *is* the contract step, say so in the file:

    -- rovenue:contract-phase drops subscribers.legacy_tier, unread since v1.4.0

A change that cannot be expressed this way is marked **downtime-required** in
its release notes, and the upgrade runbook's procedure for those is
scale-to-zero, migrate, scale-up.
