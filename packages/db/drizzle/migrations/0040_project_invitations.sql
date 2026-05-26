CREATE TYPE "InvitationDeliveryStatus" AS ENUM (
  'PENDING', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED'
);--> statement-breakpoint

CREATE TABLE "project_invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "projectId" text NOT NULL,
  "email" text NOT NULL,
  "role" "MemberRole" NOT NULL,
  "tokenHash" text NOT NULL,
  "invitedByUserId" text NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "acceptedAt" timestamp with time zone,
  "revokedAt" timestamp with time zone,
  "deliveryStatus" "InvitationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "deliveryError" text,
  "lastSentAt" timestamp with time zone,
  "sesMessageId" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "project_invitations"
  ADD CONSTRAINT "project_invitations_projectId_projects_id_fk"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "project_invitations"
  ADD CONSTRAINT "project_invitations_invitedByUserId_user_id_fk"
  FOREIGN KEY ("invitedByUserId") REFERENCES "user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "project_invitations_pending_uniq"
  ON "project_invitations" ("projectId", "email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "project_invitations_token_hash_key"
  ON "project_invitations" ("tokenHash");--> statement-breakpoint

CREATE INDEX "project_invitations_expiresAt_idx"
  ON "project_invitations" ("expiresAt");--> statement-breakpoint

CREATE INDEX "project_invitations_sesMessageId_idx"
  ON "project_invitations" ("sesMessageId");--> statement-breakpoint

CREATE INDEX "project_invitations_projectId_email_idx"
  ON "project_invitations" ("projectId", "email");
