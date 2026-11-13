CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campus_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid,
	"buyer_id" uuid,
	"opened_by_user_id" uuid NOT NULL,
	"category" varchar(32) NOT NULL,
	"status" varchar(24) DEFAULT 'reported' NOT NULL,
	"subject" varchar(200) NOT NULL,
	"details" varchar(4000) DEFAULT '' NOT NULL,
	"decision_reason" varchar(500),
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "cases_campus_id_id_uq" UNIQUE("campus_id","id"),
	CONSTRAINT "cases_category_check" CHECK ("cases"."category" in ('order_issue','no_show','quality','payment','schedule','other')),
	CONSTRAINT "cases_status_check" CHECK ("cases"."status" in ('reported','under_review','awaiting_information','approved_cancel','declined','resolved')),
	CONSTRAINT "cases_version_check" CHECK ("cases"."version" > 0),
	CONSTRAINT "cases_decision_check" CHECK (("cases"."status" in ('approved_cancel','declined','resolved') and "cases"."decided_at" is not null and "cases"."decided_by_user_id" is not null and "cases"."decision_reason" is not null) or ("cases"."status" not in ('approved_cancel','declined','resolved') and "cases"."decided_at" is null and "cases"."decided_by_user_id" is null)),
	CONSTRAINT "cases_subject_check" CHECK (length(trim("cases"."subject")) > 0)
);
--> statement-breakpoint
CREATE TABLE "refund_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"event_id" varchar(120) NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"amount_minor" numeric NOT NULL,
	"currency" varchar(3) NOT NULL,
	"provider_reference" varchar(120),
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "refund_provider_events_provider_event_uq" UNIQUE("provider","event_id"),
	CONSTRAINT "refund_provider_events_type_check" CHECK ("refund_provider_events"."event_type" in ('refund.succeeded','refund.failed','refund.pending')),
	CONSTRAINT "refund_provider_events_amount_check" CHECK ("refund_provider_events"."amount_minor" = trunc("refund_provider_events"."amount_minor") and "refund_provider_events"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "refund_request_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" varchar(500),
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_request_outbox_refund_uq" UNIQUE("refund_id"),
	CONSTRAINT "refund_request_outbox_status_check" CHECK ("refund_request_outbox"."status" in ('pending','processing','done','dead')),
	CONSTRAINT "refund_request_outbox_attempts_check" CHECK ("refund_request_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campus_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_payment_id" uuid,
	"case_id" uuid,
	"buyer_id" uuid NOT NULL,
	"amount_minor" numeric NOT NULL,
	"currency" varchar(3) DEFAULT 'IDR' NOT NULL,
	"status" varchar(20) DEFAULT 'requested' NOT NULL,
	"provider" varchar(32) DEFAULT 'sandbox' NOT NULL,
	"provider_reference" varchar(120),
	"reason" varchar(500) NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"ledger_transaction_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" varchar(500),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount_minor" = trunc("refunds"."amount_minor") and "refunds"."amount_minor" > 0 and "refunds"."amount_minor" < 1e38),
	CONSTRAINT "refunds_currency_check" CHECK ("refunds"."currency" = 'IDR'),
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" in ('requested','under_review','submitted','processing','succeeded','failed','needs_assistance')),
	CONSTRAINT "refunds_succeeded_check" CHECK (("refunds"."status" = 'succeeded' and "refunds"."succeeded_at" is not null and "refunds"."ledger_transaction_id" is not null) or ("refunds"."status" <> 'succeeded' and "refunds"."succeeded_at" is null and "refunds"."ledger_transaction_id" is null)),
	CONSTRAINT "refunds_failed_check" CHECK (("refunds"."status" = 'failed' and "refunds"."failed_at" is not null) or ("refunds"."status" <> 'failed' and "refunds"."failed_at" is null)),
	CONSTRAINT "refunds_attempts_check" CHECK ("refunds"."attempt_count" >= 0),
	CONSTRAINT "refunds_version_check" CHECK ("refunds"."version" > 0),
	CONSTRAINT "refunds_reason_check" CHECK (length(trim("refunds"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_id_uq" UNIQUE("order_id","id");
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refund_provider_events" ADD CONSTRAINT "refund_provider_events_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refund_request_outbox" ADD CONSTRAINT "refund_request_outbox_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_campus_id_campuses_id_fk" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_payment_fk" FOREIGN KEY ("order_id","order_payment_id") REFERENCES "public"."order_payments"("order_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."cases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cases_campus_status_idx" ON "cases" USING btree ("campus_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "cases_tenant_status_idx" ON "cases" USING btree ("tenant_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "cases_buyer_idx" ON "cases" USING btree ("buyer_id","created_at");
--> statement-breakpoint
CREATE INDEX "cases_order_idx" ON "cases" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX "refund_provider_events_refund_idx" ON "refund_provider_events" USING btree ("refund_id","received_at");
--> statement-breakpoint
CREATE INDEX "refund_request_outbox_due_idx" ON "refund_request_outbox" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_one_per_order_uq" ON "refunds" USING btree ("order_id") WHERE "refunds"."status" in ('requested','under_review','submitted','processing','succeeded','needs_assistance');
--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_reference_uq" ON "refunds" USING btree ("provider","provider_reference") WHERE "refunds"."provider_reference" is not null;
--> statement-breakpoint
CREATE INDEX "refunds_campus_status_idx" ON "refunds" USING btree ("campus_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "refunds_tenant_status_idx" ON "refunds" USING btree ("tenant_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "refunds_buyer_idx" ON "refunds" USING btree ("buyer_id","created_at");
--> statement-breakpoint
CREATE INDEX "refunds_due_idx" ON "refunds" USING btree ("next_attempt_at") WHERE "refunds"."next_attempt_at" is not null;
