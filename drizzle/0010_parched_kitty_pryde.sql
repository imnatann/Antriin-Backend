CREATE TABLE "review_moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_moderation_actions_action_check" CHECK ("review_moderation_actions"."action" in ('keep','hide')),
	CONSTRAINT "review_moderation_actions_reason_check" CHECK (length(trim("review_moderation_actions"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "review_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" varchar(2000) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_replies_body_check" CHECK (length(trim("review_replies"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "review_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_reports_status_check" CHECK ("review_reports"."status" in ('open','resolved')),
	CONSTRAINT "review_reports_resolved_check" CHECK (("review_reports"."status" = 'resolved' and "review_reports"."resolved_at" is not null) or ("review_reports"."status" = 'open' and "review_reports"."resolved_at" is null)),
	CONSTRAINT "review_reports_reason_check" CHECK (length(trim("review_reports"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campus_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"body" varchar(2000) NOT NULL,
	"status" varchar(16) DEFAULT 'visible' NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "reviews_campus_id_id_uq" UNIQUE("campus_id","id"),
	CONSTRAINT "reviews_rating_check" CHECK ("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_body_check" CHECK (length(trim("reviews"."body")) > 0),
	CONSTRAINT "reviews_status_check" CHECK ("reviews"."status" in ('visible','reported','under_review','hidden','resolved')),
	CONSTRAINT "reviews_hidden_check" CHECK (("reviews"."status" = 'hidden' and "reviews"."hidden_at" is not null and "reviews"."hidden_by_user_id" is not null) or ("reviews"."status" <> 'hidden' and "reviews"."hidden_at" is null and "reviews"."hidden_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "review_moderation_actions" ADD CONSTRAINT "review_moderation_actions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_moderation_actions" ADD CONSTRAINT "review_moderation_actions_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_moderation_actions" ADD CONSTRAINT "review_moderation_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_tenant_review_fk" FOREIGN KEY ("tenant_id","review_id") REFERENCES "public"."reviews"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_hidden_by_user_id_users_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_moderation_actions_review_idx" ON "review_moderation_actions" USING btree ("review_id","created_at");--> statement-breakpoint
CREATE INDEX "review_moderation_actions_campus_idx" ON "review_moderation_actions" USING btree ("campus_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_replies_review_unique" ON "review_replies" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_reports_reporter_unique" ON "review_reports" USING btree ("review_id","reporter_user_id");--> statement-breakpoint
CREATE INDEX "review_reports_campus_status_idx" ON "review_reports" USING btree ("campus_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_order_unique" ON "reviews" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "reviews_tenant_status_created_idx" ON "reviews" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reviews_campus_status_created_idx" ON "reviews" USING btree ("campus_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reviews_buyer_created_idx" ON "reviews" USING btree ("buyer_id","created_at");