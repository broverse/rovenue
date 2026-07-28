-- 0097_paywall_fonts.sql
--
-- P10 wave E1: custom paywall fonts. `font_families` groups a named
-- font (e.g. "Brand Sans") uploaded to a project; `font_faces` is one
-- weight/style/format variant of it, with the actual font bytes stored
-- as `bytea` — there is no asset storage in this repo, and a mounted
-- volume would break under API_REPLICAS. `byteSize` is denormalised at
-- write time so the metadata-only list query never has to touch the
-- blob column. The unique index on (familyId, weight, style) is what
-- makes re-uploading the same weight/style replace rather than
-- duplicate the face row.
--
-- NOTE: `drizzle-kit generate` produced a much larger diff here because
-- the meta/ snapshot chain had fallen behind hand-applied migrations
-- 0090-0096 (no snapshot was committed for them). Everything below is
-- trimmed to just the two new tables; the rest of that diff described
-- tables/columns already applied by earlier migration files.

CREATE TABLE "font_families" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "font_faces" (
	"id" text PRIMARY KEY NOT NULL,
	"familyId" text NOT NULL,
	"weight" integer NOT NULL,
	"style" text NOT NULL,
	"format" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byteSize" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "font_families" ADD CONSTRAINT "font_families_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "font_faces" ADD CONSTRAINT "font_faces_familyId_font_families_id_fk" FOREIGN KEY ("familyId") REFERENCES "public"."font_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "font_faces_family_weight_style_key" ON "font_faces" USING btree ("familyId","weight","style");
