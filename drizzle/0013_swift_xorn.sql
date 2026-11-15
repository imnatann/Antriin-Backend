CREATE TABLE "tenant_staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invited_user_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_staff_invites_role_check" CHECK ("tenant_staff_invites"."role" in ('owner', 'kitchen', 'pickup')),
	CONSTRAINT "tenant_staff_invites_expiry_check" CHECK ("tenant_staff_invites"."expires_at" > "tenant_staff_invites"."created_at")
);
--> statement-breakpoint
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"campus_id" uuid,
	"kind" varchar(16) NOT NULL,
	"format" varchar(8) NOT NULL,
	"range_from" varchar(10),
	"range_to" varchar(10),
	"schedule" varchar(16) DEFAULT 'manual' NOT NULL,
	"schedule_hour" smallint,
	"next_run_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"media_asset_id" uuid,
	"error" varchar(500),
	"created_by" uuid NOT NULL,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_exports_kind_check" CHECK ("report_exports"."kind" in ('sales', 'dashboard')),
	CONSTRAINT "report_exports_format_check" CHECK ("report_exports"."format" in ('csv', 'pdf')),
	CONSTRAINT "report_exports_schedule_check" CHECK ("report_exports"."schedule" in ('manual', 'daily', 'weekly')),
	CONSTRAINT "report_exports_status_check" CHECK ("report_exports"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "report_exports_owner_check" CHECK (("report_exports"."tenant_id" is not null) <> ("report_exports"."campus_id" is not null)),
	CONSTRAINT "report_exports_schedule_hour_check" CHECK ("report_exports"."schedule_hour" is null or ("report_exports"."schedule_hour" >= 0 and "report_exports"."schedule_hour" <= 23))
);
--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'completed' NOT NULL,
	"reason" text,
	"retained_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_requests_status_check" CHECK ("account_deletion_requests"."status" in ('requested', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "campus_email_domains" ADD COLUMN "dns_token" varchar(64) DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 32) NOT NULL;--> statement-breakpoint
ALTER TABLE "campus_email_domains" ADD COLUMN "dns_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campus_email_domains" ADD COLUMN "dns_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campus_email_domains" ADD COLUMN "dns_last_error" varchar(300);--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "metadata_stripped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "thumbnail_key" varchar(200);--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "moderation_status" varchar(16) DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_staff_invites" ADD CONSTRAINT "tenant_staff_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_staff_invites" ADD CONSTRAINT "tenant_staff_invites_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_staff_invites" ADD CONSTRAINT "tenant_staff_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_staff_invites_token_unique" ON "tenant_staff_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "tenant_staff_invites_tenant_idx" ON "tenant_staff_invites" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "tenant_staff_invites_user_idx" ON "tenant_staff_invites" USING btree ("invited_user_id","accepted_at");--> statement-breakpoint
CREATE INDEX "report_exports_tenant_idx" ON "report_exports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "report_exports_campus_idx" ON "report_exports" USING btree ("campus_id","created_at");--> statement-breakpoint
CREATE INDEX "report_exports_due_idx" ON "report_exports" USING btree ("next_run_at","status");--> statement-breakpoint
CREATE INDEX "account_deletion_requests_user_idx" ON "account_deletion_requests" USING btree ("user_id","requested_at");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_moderation_check" CHECK ("media_assets"."moderation_status" in ('unreviewed', 'clear', 'flagged'));