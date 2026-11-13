CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_payment_id" uuid NOT NULL,
	"amount_minor" numeric NOT NULL,
	"currency" varchar(3) DEFAULT 'IDR' NOT NULL,
	"status" varchar(16) DEFAULT 'available' NOT NULL,
	"paid_out_minor" numeric DEFAULT '0' NOT NULL,
	"release_ledger_transaction_id" uuid,
	"released_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_one_per_order_uq" UNIQUE("order_id"),
	CONSTRAINT "settlements_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "settlements_amount_check" CHECK ("settlements"."amount_minor" = trunc("settlements"."amount_minor") and "settlements"."amount_minor" > 0 and "settlements"."amount_minor" < 1e38),
	CONSTRAINT "settlements_currency_check" CHECK ("settlements"."currency" = 'IDR'),
	CONSTRAINT "settlements_status_check" CHECK ("settlements"."status" in ('pending','available','paid_out','voided','reversed')),
	CONSTRAINT "settlements_paid_out_check" CHECK ("settlements"."paid_out_minor" = trunc("settlements"."paid_out_minor") and "settlements"."paid_out_minor" >= 0 and "settlements"."paid_out_minor" <= "settlements"."amount_minor"),
	CONSTRAINT "settlements_status_timestamps_check" CHECK (("settlements"."status" = 'pending' and "settlements"."released_at" is null and "settlements"."release_ledger_transaction_id" is null and "settlements"."paid_out_minor" = 0)
        or ("settlements"."status" = 'available' and "settlements"."released_at" is not null and "settlements"."release_ledger_transaction_id" is not null and "settlements"."paid_out_minor" < "settlements"."amount_minor")
        or ("settlements"."status" = 'paid_out' and "settlements"."released_at" is not null and "settlements"."release_ledger_transaction_id" is not null and "settlements"."paid_out_minor" = "settlements"."amount_minor")
        or ("settlements"."status" = 'voided' and "settlements"."voided_at" is not null and "settlements"."paid_out_minor" = 0)
        or ("settlements"."status" = 'reversed' and "settlements"."reversed_at" is not null and "settlements"."paid_out_minor" = 0))
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"bank_code" varchar(20) NOT NULL,
	"account_holder_name" varchar(200) NOT NULL,
	"account_number_ciphertext" varchar(500) NOT NULL,
	"account_number_hash" varchar(64) NOT NULL,
	"account_number_masked" varchar(32) NOT NULL,
	"verification_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"verification_method" varchar(32),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_accounts_verification_check" CHECK (("bank_accounts"."verification_status" = 'verified' and "bank_accounts"."verified_at" is not null and "bank_accounts"."verified_by_user_id" is not null and "bank_accounts"."verification_method" is not null)
        or ("bank_accounts"."verification_status" <> 'verified' and "bank_accounts"."verified_at" is null and "bank_accounts"."verified_by_user_id" is null and "bank_accounts"."verification_method" is null)),
	CONSTRAINT "bank_accounts_verification_status_check" CHECK ("bank_accounts"."verification_status" in ('pending','verified','rejected')),
	CONSTRAINT "bank_accounts_status_check" CHECK ("bank_accounts"."status" in ('active','disabled')),
	CONSTRAINT "bank_accounts_hash_check" CHECK ("bank_accounts"."account_number_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_accounts_masked_check" CHECK (length("bank_accounts"."account_number_masked") between 4 and 32),
	CONSTRAINT "bank_accounts_version_check" CHECK ("bank_accounts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "payout_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payout_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"amount_minor" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_allocations_payout_settlement_uq" UNIQUE("payout_id","settlement_id"),
	CONSTRAINT "payout_allocations_amount_check" CHECK ("payout_allocations"."amount_minor" = trunc("payout_allocations"."amount_minor") and "payout_allocations"."amount_minor" > 0 and "payout_allocations"."amount_minor" < 1e38)
);
--> statement-breakpoint
CREATE TABLE "payout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"provider_reference" varchar(120),
	"error_code" varchar(64),
	"error_message" varchar(500),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "payout_attempts_payout_attempt_uq" UNIQUE("payout_id","attempt_no"),
	CONSTRAINT "payout_attempts_no_check" CHECK ("payout_attempts"."attempt_no" > 0),
	CONSTRAINT "payout_attempts_status_check" CHECK ("payout_attempts"."status" in ('pending','succeeded','failed','unknown')),
	CONSTRAINT "payout_attempts_finished_check" CHECK (("payout_attempts"."status" = 'pending' and "payout_attempts"."finished_at" is null) or ("payout_attempts"."status" <> 'pending' and "payout_attempts"."finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payout_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"from_status" varchar(16),
	"to_status" varchar(16) NOT NULL,
	"actor_user_id" uuid,
	"actor_service" varchar(80),
	"reason" varchar(500) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_events_payout_version_uq" UNIQUE("payout_id","version"),
	CONSTRAINT "payout_events_version_check" CHECK ("payout_events"."version" > 0),
	CONSTRAINT "payout_events_actor_check" CHECK (("payout_events"."actor_user_id" is not null and "payout_events"."actor_service" is null) or ("payout_events"."actor_user_id" is null and "payout_events"."actor_service" is not null))
);
--> statement-breakpoint
CREATE TABLE "payout_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"event_id" varchar(120) NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"amount_minor" numeric NOT NULL,
	"currency" varchar(3) NOT NULL,
	"provider_reference" varchar(120),
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payout_provider_events_provider_event_uq" UNIQUE("provider","event_id"),
	CONSTRAINT "payout_provider_events_type_check" CHECK ("payout_provider_events"."event_type" in ('payout.succeeded','payout.failed','payout.pending')),
	CONSTRAINT "payout_provider_events_amount_check" CHECK ("payout_provider_events"."amount_minor" = trunc("payout_provider_events"."amount_minor") and "payout_provider_events"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payout_request_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" varchar(500),
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_request_outbox_payout_uq" UNIQUE("payout_id"),
	CONSTRAINT "payout_request_outbox_status_check" CHECK ("payout_request_outbox"."status" in ('pending','processing','done','dead')),
	CONSTRAINT "payout_request_outbox_attempts_check" CHECK ("payout_request_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"bank_code" varchar(20) NOT NULL,
	"account_number_masked" varchar(32) NOT NULL,
	"account_holder_name" varchar(200) NOT NULL,
	"amount_minor" numeric NOT NULL,
	"currency" varchar(3) DEFAULT 'IDR' NOT NULL,
	"status" varchar(16) DEFAULT 'requested' NOT NULL,
	"provider" varchar(32) DEFAULT 'sandbox' NOT NULL,
	"provider_reference" varchar(120),
	"hold_ledger_transaction_id" uuid NOT NULL,
	"settle_ledger_transaction_id" uuid,
	"release_ledger_transaction_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"failure_code" varchar(64),
	"last_error" varchar(500),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payouts_amount_check" CHECK ("payouts"."amount_minor" = trunc("payouts"."amount_minor") and "payouts"."amount_minor" > 0 and "payouts"."amount_minor" < 1e38),
	CONSTRAINT "payouts_currency_check" CHECK ("payouts"."currency" = 'IDR'),
	CONSTRAINT "payouts_status_check" CHECK ("payouts"."status" in ('requested','processing','succeeded','failed','cancelled')),
	CONSTRAINT "payouts_ledger_legs_check" CHECK ("payouts"."hold_ledger_transaction_id" is not null
        and (("payouts"."status" = 'succeeded' and "payouts"."settle_ledger_transaction_id" is not null and "payouts"."release_ledger_transaction_id" is null)
          or ("payouts"."status" in ('failed','cancelled') and "payouts"."settle_ledger_transaction_id" is null and "payouts"."release_ledger_transaction_id" is not null)
          or ("payouts"."status" in ('requested','processing') and "payouts"."settle_ledger_transaction_id" is null and "payouts"."release_ledger_transaction_id" is null))),
	CONSTRAINT "payouts_timestamps_check" CHECK (("payouts"."status" = 'requested' and "payouts"."processing_at" is null and "payouts"."succeeded_at" is null and "payouts"."failed_at" is null and "payouts"."cancelled_at" is null)
        or ("payouts"."status" = 'processing' and "payouts"."processing_at" is not null and "payouts"."succeeded_at" is null and "payouts"."failed_at" is null and "payouts"."cancelled_at" is null)
        or ("payouts"."status" = 'succeeded' and "payouts"."succeeded_at" is not null and "payouts"."failed_at" is null and "payouts"."cancelled_at" is null)
        or ("payouts"."status" = 'failed' and "payouts"."failed_at" is not null and "payouts"."succeeded_at" is null and "payouts"."cancelled_at" is null)
        or ("payouts"."status" = 'cancelled' and "payouts"."cancelled_at" is not null and "payouts"."succeeded_at" is null and "payouts"."failed_at" is null)),
	CONSTRAINT "payouts_version_check" CHECK ("payouts"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_release_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("release_ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_order_payment_fk" FOREIGN KEY ("order_id","order_payment_id") REFERENCES "public"."order_payments"("order_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payout_allocations" ADD CONSTRAINT "payout_allocations_tenant_payout_fk" FOREIGN KEY ("tenant_id","payout_id") REFERENCES "public"."payouts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payout_allocations" ADD CONSTRAINT "payout_allocations_tenant_settlement_fk" FOREIGN KEY ("tenant_id","settlement_id") REFERENCES "public"."settlements"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payout_events" ADD CONSTRAINT "payout_events_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payout_events" ADD CONSTRAINT "payout_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payout_provider_events" ADD CONSTRAINT "payout_provider_events_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payout_request_outbox" ADD CONSTRAINT "payout_request_outbox_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_hold_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("hold_ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_settle_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("settle_ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_release_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("release_ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "settlements_tenant_status_idx" ON "settlements" USING btree ("tenant_id","status","released_at");
--> statement-breakpoint
CREATE INDEX "settlements_status_released_idx" ON "settlements" USING btree ("status","released_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_one_default_uq" ON "bank_accounts" USING btree ("tenant_id") WHERE "bank_accounts"."is_default" and "bank_accounts"."status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_tenant_number_uq" ON "bank_accounts" USING btree ("tenant_id","bank_code","account_number_hash") WHERE "bank_accounts"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "bank_accounts_tenant_status_idx" ON "bank_accounts" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX "payout_allocations_settlement_idx" ON "payout_allocations" USING btree ("settlement_id");
--> statement-breakpoint
CREATE INDEX "payout_attempts_payout_idx" ON "payout_attempts" USING btree ("payout_id","started_at");
--> statement-breakpoint
CREATE INDEX "payout_events_payout_occurred_idx" ON "payout_events" USING btree ("payout_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "payout_provider_events_payout_idx" ON "payout_provider_events" USING btree ("payout_id","received_at");
--> statement-breakpoint
CREATE INDEX "payout_request_outbox_due_idx" ON "payout_request_outbox" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_one_active_per_tenant_uq" ON "payouts" USING btree ("tenant_id") WHERE "payouts"."status" in ('requested','processing');
--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_reference_uq" ON "payouts" USING btree ("provider","provider_reference") WHERE "payouts"."provider_reference" is not null;
--> statement-breakpoint
CREATE INDEX "payouts_tenant_created_idx" ON "payouts" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX "payouts_status_created_idx" ON "payouts" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "payouts_requester_idx" ON "payouts" USING btree ("requested_by_user_id");
