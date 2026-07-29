-- 0098_font_face_content_hash.sql
--
-- P10 wave E1, Task 7: version the device font-file URL by content hash
-- so `Cache-Control: immutable` (Task 5) becomes honest against Task 1's
-- replace-in-place `upsertFace` (ON CONFLICT DO UPDATE on
-- (familyId, weight, style) overwrites bytes under the same face id).
-- `contentHash` is SHA-256 of `font_faces.bytes`, lowercase hex — the
-- same value stored, served as the ETag, and used as the URL segment.
--
-- Nullable first so existing rows can be backfilled before the NOT NULL
-- constraint is added. Postgres has a built-in sha256() (bytea -> bytea)
-- since PG 11 (this repo targets PG 16), so the backfill needs no
-- pgcrypto extension.

ALTER TABLE "font_faces" ADD COLUMN "contentHash" text;
--> statement-breakpoint
UPDATE "font_faces" SET "contentHash" = encode(sha256("bytes"), 'hex');
--> statement-breakpoint
ALTER TABLE "font_faces" ALTER COLUMN "contentHash" SET NOT NULL;
