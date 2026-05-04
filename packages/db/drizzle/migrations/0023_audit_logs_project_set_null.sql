-- =============================================================
-- audit_logs.projectId — preserve audit trail across project deletion
-- =============================================================
--
-- Previously the FK was ON DELETE CASCADE, so deleting a project
-- wiped its entire audit history (including the just-inserted
-- "project.deleted" entry that the dashboard handler writes).
-- Switch to ON DELETE SET NULL + drop NOT NULL on the column so
-- audit rows survive as orphans after a project delete. The
-- original project id is still retrievable from each row's
-- `resourceId` for "project.*" actions.

ALTER TABLE "audit_logs"
  DROP CONSTRAINT "audit_logs_projectId_projects_id_fk";--> statement-breakpoint

ALTER TABLE "audit_logs"
  ALTER COLUMN "projectId" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_projectId_projects_id_fk"
  FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
