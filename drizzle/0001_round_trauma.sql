CREATE TABLE "access_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"details" text[] DEFAULT '{}'::text[] NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_audit_scope_type_check" CHECK ("access_audit_events"."scope_type" in ('tenant', 'campus')),
	CONSTRAINT "access_audit_action_check" CHECK ("access_audit_events"."action" in ('grant', 'revoke'))
);
--> statement-breakpoint
CREATE TABLE "campus_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campus_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campus_memberships_status_check" CHECK ("campus_memberships"."status" in ('active', 'revoked')),
	CONSTRAINT "campus_memberships_revoked_at_check" CHECK (("campus_memberships"."status" = 'active' and "campus_memberships"."revoked_at" is null) or ("campus_memberships"."status" = 'revoked' and "campus_memberships"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(24) NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"owner_verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_role_check" CHECK ("tenant_memberships"."role" in ('owner', 'kitchen', 'pickup')),
	CONSTRAINT "tenant_memberships_status_check" CHECK ("tenant_memberships"."status" in ('active', 'revoked')),
	CONSTRAINT "tenant_memberships_owner_verification_check" CHECK ("tenant_memberships"."role" <> 'owner' or "tenant_memberships"."owner_verified_at" is not null),
	CONSTRAINT "tenant_memberships_revoked_at_check" CHECK (("tenant_memberships"."status" = 'active' and "tenant_memberships"."revoked_at" is null) or ("tenant_memberships"."status" = 'revoked' and "tenant_memberships"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "access_audit_events" ADD CONSTRAINT "access_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_audit_events" ADD CONSTRAINT "access_audit_events_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_memberships" ADD CONSTRAINT "campus_memberships_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_memberships" ADD CONSTRAINT "campus_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_audit_scope_occurred_idx" ON "access_audit_events" USING btree ("scope_type","scope_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campus_memberships_campus_user_unique" ON "campus_memberships" USING btree ("campus_id","user_id");--> statement-breakpoint
CREATE INDEX "campus_memberships_user_status_idx" ON "campus_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_memberships_tenant_user_unique" ON "tenant_memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_status_idx" ON "tenant_memberships" USING btree ("user_id","status");
--> statement-breakpoint
CREATE FUNCTION access_audit_events_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access_audit_events is append-only';
END;
$$;

CREATE TRIGGER access_audit_events_immutable
BEFORE UPDATE OR DELETE ON access_audit_events
FOR EACH ROW EXECUTE FUNCTION access_audit_events_prevent_mutation();
