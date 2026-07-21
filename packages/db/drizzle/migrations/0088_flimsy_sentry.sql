CREATE TABLE "paywalls" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"offeringId" text NOT NULL,
	"remoteConfig" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"configFormatVersion" integer DEFAULT 1 NOT NULL,
	"builderConfig" jsonb,
	"isActive" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placements" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paywalls" ADD CONSTRAINT "paywalls_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paywalls" ADD CONSTRAINT "paywalls_offeringId_offerings_id_fk" FOREIGN KEY ("offeringId") REFERENCES "public"."offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paywalls_projectId_identifier_key" ON "paywalls" USING btree ("projectId","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "placements_projectId_identifier_key" ON "placements" USING btree ("projectId","identifier");
