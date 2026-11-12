CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"identity_hash" varchar(64) NOT NULL,
	"destination_ciphertext" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_channel_check" CHECK ("auth_identities"."channel" in ('email', 'phone'))
);
--> statement-breakpoint
CREATE TABLE "auth_otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"campus_id" uuid,
	"purpose" varchar(32) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"identity_hash" varchar(64) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"destination_ciphertext" text NOT NULL,
	"display_name" varchar(200),
	"status" varchar(24) DEFAULT 'created' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_otp_challenges_purpose_check" CHECK ("auth_otp_challenges"."purpose" in ('login', 'campus_email')),
	CONSTRAINT "auth_otp_challenges_channel_check" CHECK ("auth_otp_challenges"."channel" in ('email', 'phone')),
	CONSTRAINT "auth_otp_challenges_status_check" CHECK ("auth_otp_challenges"."status" in ('created', 'sent', 'delivery_failed', 'consumed', 'expired', 'locked', 'revoked')),
	CONSTRAINT "auth_otp_challenges_attempts_check" CHECK ("auth_otp_challenges"."attempts" >= 0),
	CONSTRAINT "auth_otp_challenges_max_attempts_check" CHECK ("auth_otp_challenges"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "auth_otp_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"destination_ciphertext" text,
	"code_ciphertext" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_otp_deliveries_channel_check" CHECK ("auth_otp_deliveries"."channel" in ('email', 'phone')),
	CONSTRAINT "auth_otp_deliveries_status_check" CHECK ("auth_otp_deliveries"."status" in ('pending', 'processing', 'sent', 'dead')),
	CONSTRAINT "auth_otp_deliveries_attempts_check" CHECK ("auth_otp_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"rotated_to_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus_email_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campus_id" uuid NOT NULL,
	"domain" varchar(253) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campus_email_domains_lowercase_check" CHECK ("campus_email_domains"."domain" = lower("campus_email_domains"."domain"))
);
--> statement-breakpoint
CREATE TABLE "campus_email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"identity_hash" varchar(64) NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"template" varchar(100) NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_template_check" CHECK (length("notifications"."template") > 0)
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"aggregate_type" varchar(40) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"recipient_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_otp_challenges" ADD CONSTRAINT "auth_otp_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_otp_challenges" ADD CONSTRAINT "auth_otp_challenges_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_otp_deliveries" ADD CONSTRAINT "auth_otp_deliveries_challenge_id_auth_otp_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."auth_otp_challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_email_domains" ADD CONSTRAINT "campus_email_domains_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_email_verifications" ADD CONSTRAINT "campus_email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_email_verifications" ADD CONSTRAINT "campus_email_verifications_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_channel_hash_unique" ON "auth_identities" USING btree ("channel","identity_hash");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_otp_challenges_identity_created_idx" ON "auth_otp_challenges" USING btree ("identity_hash","created_at");--> statement-breakpoint
CREATE INDEX "auth_otp_challenges_expiry_idx" ON "auth_otp_challenges" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_otp_deliveries_challenge_unique" ON "auth_otp_deliveries" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "auth_otp_deliveries_queue_idx" ON "auth_otp_deliveries" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_unique" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_active_idx" ON "auth_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campus_email_domains_domain_unique" ON "campus_email_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "campus_email_domains_campus_idx" ON "campus_email_domains" USING btree ("campus_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "campus_email_verifications_user_unique" ON "campus_email_verifications" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campus_email_verifications_identity_unique" ON "campus_email_verifications" USING btree ("identity_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_event_recipient_uq" ON "notifications" USING btree ("event_id","recipient_user_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_cursor_idx" ON "notifications" USING btree ("recipient_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_event_key_uq" ON "outbox_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at","id") WHERE "outbox_events"."published_at" is null and "outbox_events"."failed_at" is null;
--> statement-breakpoint
CREATE FUNCTION antriin_outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox events cannot be deleted';
  END IF;
  IF ROW(NEW.id, NEW.event_key, NEW.request_hash, NEW.event_type, NEW.aggregate_type,
         NEW.aggregate_id, NEW.recipient_ids, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.event_key, OLD.request_hash, OLD.event_type, OLD.aggregate_type,
         OLD.aggregate_id, OLD.recipient_ids, OLD.created_at) THEN
    RAISE EXCEPTION 'outbox event content is immutable';
  END IF;
  IF (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at)
     OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
     OR (OLD.failed_at IS NOT NULL AND NEW.failed_at IS DISTINCT FROM OLD.failed_at)
     OR (NEW.delivered_at IS NOT NULL AND NEW.failed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'outbox event state cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbox_events_immutable BEFORE UPDATE OR DELETE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION antriin_outbox_immutable();
