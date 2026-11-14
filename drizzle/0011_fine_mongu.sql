CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"order_updates" boolean DEFAULT true NOT NULL,
	"review_replies" boolean DEFAULT true NOT NULL,
	"case_updates" boolean DEFAULT true NOT NULL,
	"push_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_push_check" CHECK ("notification_preferences"."push_enabled" in (true, false))
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"label" varchar(100) DEFAULT '' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_platform_check" CHECK ("user_devices"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "risk_review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"decision" varchar(32) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_review_decisions_decision_check" CHECK ("risk_review_decisions"."decision" in ('no_violation', 'explanation_requested')),
	CONSTRAINT "risk_review_decisions_reason_check" CHECK (length(trim("risk_review_decisions"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "risk_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campus_id" uuid NOT NULL,
	"tenant_id" uuid,
	"subject_type" varchar(16) NOT NULL,
	"subject_id" uuid NOT NULL,
	"category" varchar(32) NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"model_version" varchar(64) NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_signals_subject_type_check" CHECK ("risk_signals"."subject_type" in ('tenant', 'buyer', 'order')),
	CONSTRAINT "risk_signals_category_check" CHECK ("risk_signals"."category" in ('rating_anomaly', 'payment_refund_chain', 'tenant_status_change')),
	CONSTRAINT "risk_signals_score_check" CHECK ("risk_signals"."score" >= 0 and "risk_signals"."score" <= 1),
	CONSTRAINT "risk_signals_explanation_check" CHECK (length(trim("risk_signals"."explanation")) > 0)
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "description" varchar(2000) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "contact" varchar(200) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pickup_instructions" varchar(1000) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_review_decisions" ADD CONSTRAINT "risk_review_decisions_signal_id_risk_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."risk_signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_review_decisions" ADD CONSTRAINT "risk_review_decisions_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_review_decisions" ADD CONSTRAINT "risk_review_decisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_token_hash_unique" ON "user_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_devices_user_active_idx" ON "user_devices" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "risk_review_decisions_signal_idx" ON "risk_review_decisions" USING btree ("signal_id","decided_at");--> statement-breakpoint
CREATE INDEX "risk_review_decisions_campus_idx" ON "risk_review_decisions" USING btree ("campus_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_signals_dedupe_key_unique" ON "risk_signals" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "risk_signals_campus_created_idx" ON "risk_signals" USING btree ("campus_id","created_at","id");