CREATE TABLE "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"userId" text NOT NULL,
	"label" text NOT NULL,
	"scope" text NOT NULL,
	"keyPublic" text NOT NULL,
	"keySecretHash" text NOT NULL,
	"lastUsedAt" timestamp with time zone,
	"expiresAt" timestamp with time zone,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_keyPublic_unique" UNIQUE("keyPublic")
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tokens_projectId_idx" ON "mcp_tokens" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "mcp_tokens_userId_idx" ON "mcp_tokens" USING btree ("userId");