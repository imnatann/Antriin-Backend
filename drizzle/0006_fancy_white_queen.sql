CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_categories_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_categories_status_check" CHECK ("menu_categories"."status" in ('active', 'archived')),
	CONSTRAINT "menu_categories_sort_order_check" CHECK ("menu_categories"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" varchar(2000) DEFAULT '' NOT NULL,
	"price_minor" numeric NOT NULL,
	"currency" varchar(3) DEFAULT 'IDR' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_items_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_items_price_check" CHECK ("menu_items"."price_minor" = trunc("menu_items"."price_minor") and "menu_items"."price_minor" >= 0 and "menu_items"."price_minor" < 1e38),
	CONSTRAINT "menu_items_currency_check" CHECK ("menu_items"."currency" = 'IDR'),
	CONSTRAINT "menu_items_status_check" CHECK ("menu_items"."status" in ('active', 'sold_out', 'archived')),
	CONSTRAINT "menu_items_version_check" CHECK ("menu_items"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "menu_option_choices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"price_delta_minor" numeric DEFAULT '0' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_option_choices_price_delta_check" CHECK ("menu_option_choices"."price_delta_minor" = trunc("menu_option_choices"."price_delta_minor") and "menu_option_choices"."price_delta_minor" >= 0 and "menu_option_choices"."price_delta_minor" < 1e38),
	CONSTRAINT "menu_option_choices_status_check" CHECK ("menu_option_choices"."status" in ('active', 'archived')),
	CONSTRAINT "menu_option_choices_version_check" CHECK ("menu_option_choices"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "menu_option_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"min_selections" integer DEFAULT 0 NOT NULL,
	"max_selections" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_option_groups_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_option_groups_selection_bounds_check" CHECK ("menu_option_groups"."min_selections" >= 0 and "menu_option_groups"."max_selections" >= 1 and "menu_option_groups"."min_selections" <= "menu_option_groups"."max_selections"),
	CONSTRAINT "menu_option_groups_sort_order_check" CHECK ("menu_option_groups"."sort_order" >= 0),
	CONSTRAINT "menu_option_groups_status_check" CHECK ("menu_option_groups"."status" in ('active', 'archived')),
	CONSTRAINT "menu_option_groups_version_check" CHECK ("menu_option_groups"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "pickup_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"reserved_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_slots_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pickup_slots_window_check" CHECK ("pickup_slots"."ends_at" > "pickup_slots"."starts_at"),
	CONSTRAINT "pickup_slots_capacity_check" CHECK ("pickup_slots"."capacity" >= 1 and "pickup_slots"."reserved_count" >= 0 and "pickup_slots"."reserved_count" <= "pickup_slots"."capacity"),
	CONSTRAINT "pickup_slots_status_check" CHECK ("pickup_slots"."status" in ('open', 'closed')),
	CONSTRAINT "pickup_slots_version_check" CHECK ("pickup_slots"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "slot_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "slot_reservations_status_check" CHECK ("slot_reservations"."status" in ('reserved', 'released', 'consumed')),
	CONSTRAINT "slot_reservations_released_at_check" CHECK (("slot_reservations"."status" = 'released' and "slot_reservations"."released_at" is not null) or ("slot_reservations"."status" <> 'released' and "slot_reservations"."released_at" is null))
);
--> statement-breakpoint
CREATE TABLE "tenant_operating_hour_overrides" (
	"tenant_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"reason" varchar(300) DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_operating_overrides_window_check" CHECK (("tenant_operating_hour_overrides"."is_closed" = true and "tenant_operating_hour_overrides"."opens_at" is null and "tenant_operating_hour_overrides"."closes_at" is null) or ("tenant_operating_hour_overrides"."is_closed" = false and "tenant_operating_hour_overrides"."opens_at" is not null and "tenant_operating_hour_overrides"."closes_at" is not null and "tenant_operating_hour_overrides"."opens_at" < "tenant_operating_hour_overrides"."closes_at"))
);
--> statement-breakpoint
CREATE TABLE "tenant_operating_hours" (
	"tenant_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"is_open" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_operating_hours_weekday_check" CHECK ("tenant_operating_hours"."weekday" between 0 and 6),
	CONSTRAINT "tenant_operating_hours_time_check" CHECK (("tenant_operating_hours"."is_open" = true and "tenant_operating_hours"."opens_at" is not null and "tenant_operating_hours"."closes_at" is not null and "tenant_operating_hours"."opens_at" < "tenant_operating_hours"."closes_at") or ("tenant_operating_hours"."is_open" = false and "tenant_operating_hours"."opens_at" is null and "tenant_operating_hours"."closes_at" is null))
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"from_status" varchar(32),
	"to_status" varchar(32),
	"actor_user_id" uuid,
	"actor_service" varchar(80),
	"reason" varchar(500) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_version_check" CHECK ("order_events"."version" > 0),
	CONSTRAINT "order_events_type_check" CHECK ("order_events"."event_type" in ('order.created', 'order.status_changed', 'schedule_proposal.created', 'schedule_proposal.decided')),
	CONSTRAINT "order_events_actor_check" CHECK (("order_events"."actor_user_id" is not null and "order_events"."actor_service" is null) or ("order_events"."actor_user_id" is null and "order_events"."actor_service" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"handed_over_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_item_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"source_group_id" uuid NOT NULL,
	"source_choice_id" uuid NOT NULL,
	"group_name_snapshot" varchar(100) NOT NULL,
	"name_snapshot" varchar(100) NOT NULL,
	"price_delta_minor" numeric NOT NULL,
	"group_version" integer NOT NULL,
	"choice_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_options_price_delta_check" CHECK ("order_item_options"."price_delta_minor" >= 0 and "order_item_options"."price_delta_minor" = trunc("order_item_options"."price_delta_minor") and "order_item_options"."price_delta_minor" < 1e38),
	CONSTRAINT "order_item_options_versions_check" CHECK ("order_item_options"."group_version" > 0 and "order_item_options"."choice_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"source_menu_item_id" uuid NOT NULL,
	"source_category_id" uuid NOT NULL,
	"name_snapshot" varchar(160) NOT NULL,
	"description_snapshot" text NOT NULL,
	"menu_version" integer NOT NULL,
	"quantity" integer NOT NULL,
	"base_unit_price_minor" numeric NOT NULL,
	"unit_price_minor" numeric NOT NULL,
	"line_total_minor" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" between 1 and 99),
	CONSTRAINT "order_items_menu_version_check" CHECK ("order_items"."menu_version" > 0),
	CONSTRAINT "order_items_prices_check" CHECK ("order_items"."base_unit_price_minor" >= 0 and "order_items"."unit_price_minor" >= 0 and "order_items"."line_total_minor" >= 0 and "order_items"."base_unit_price_minor" = trunc("order_items"."base_unit_price_minor") and "order_items"."unit_price_minor" = trunc("order_items"."unit_price_minor") and "order_items"."line_total_minor" = trunc("order_items"."line_total_minor") and "order_items"."base_unit_price_minor" < 1e38 and "order_items"."unit_price_minor" < 1e38 and "order_items"."line_total_minor" < 1e38)
);
--> statement-breakpoint
CREATE TABLE "order_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"amount_minor" numeric NOT NULL,
	"currency" varchar(3) NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_payments_method_check" CHECK ("order_payments"."method" = 'wallet'),
	CONSTRAINT "order_payments_status_check" CHECK ("order_payments"."status" in ('succeeded')),
	CONSTRAINT "order_payments_amount_check" CHECK ("order_payments"."amount_minor" > 0 and "order_payments"."amount_minor" = trunc("order_payments"."amount_minor") and "order_payments"."amount_minor" < 1e38),
	CONSTRAINT "order_payments_currency_check" CHECK ("order_payments"."currency" = 'IDR')
);
--> statement-breakpoint
CREATE TABLE "order_request_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"route_name" varchar(180) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"order_id" uuid NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_request_idempotency_hashes_check" CHECK ("order_request_idempotency"."key_hash" ~ '^[a-f0-9]{64}$' and "order_request_idempotency"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pickup_slot_id" uuid NOT NULL,
	"tenant_name_snapshot" varchar(200) NOT NULL,
	"tenant_timezone_snapshot" varchar(100) NOT NULL,
	"pickup_starts_at" timestamp with time zone NOT NULL,
	"pickup_ends_at" timestamp with time zone NOT NULL,
	"status" varchar(32) DEFAULT 'paid_awaiting_tenant' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"subtotal_minor" numeric NOT NULL,
	"total_minor" numeric NOT NULL,
	"special_request" varchar(500) DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"preparing_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('paid_awaiting_tenant', 'confirmed', 'preparing', 'ready_for_pickup', 'completed', 'declined', 'cancelled')),
	CONSTRAINT "orders_currency_check" CHECK ("orders"."currency" = 'IDR'),
	CONSTRAINT "orders_amounts_check" CHECK ("orders"."subtotal_minor" >= 0 and "orders"."total_minor" >= 0 and "orders"."subtotal_minor" = trunc("orders"."subtotal_minor") and "orders"."total_minor" = trunc("orders"."total_minor") and "orders"."subtotal_minor" < 1e38 and "orders"."total_minor" < 1e38),
	CONSTRAINT "orders_version_check" CHECK ("orders"."version" > 0),
	CONSTRAINT "orders_pickup_window_check" CHECK ("orders"."pickup_ends_at" > "orders"."pickup_starts_at")
);
--> statement-breakpoint
CREATE TABLE "pickup_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"code_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_credentials_hash_check" CHECK ("pickup_credentials"."code_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "schedule_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"old_slot_id" uuid NOT NULL,
	"proposed_slot_id" uuid NOT NULL,
	"old_starts_at" timestamp with time zone NOT NULL,
	"old_ends_at" timestamp with time zone NOT NULL,
	"proposed_starts_at" timestamp with time zone NOT NULL,
	"proposed_ends_at" timestamp with time zone NOT NULL,
	"expected_slot_version" integer NOT NULL,
	"expected_order_version" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending_buyer' NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_proposals_status_check" CHECK ("schedule_proposals"."status" in ('pending_buyer', 'accepted', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "schedule_proposals_slot_diff_check" CHECK ("schedule_proposals"."old_slot_id" <> "schedule_proposals"."proposed_slot_id"),
	CONSTRAINT "schedule_proposals_windows_check" CHECK ("schedule_proposals"."old_ends_at" > "schedule_proposals"."old_starts_at" and "schedule_proposals"."proposed_ends_at" > "schedule_proposals"."proposed_starts_at"),
	CONSTRAINT "schedule_proposals_versions_check" CHECK ("schedule_proposals"."expected_slot_version" > 0 and "schedule_proposals"."expected_order_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"event_id" varchar(200) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"topup_id" uuid,
	"provider_status" varchar(16) NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_events_provider_check" CHECK ("payment_provider_events"."provider" = 'sandbox'),
	CONSTRAINT "payment_provider_events_hash_check" CHECK ("payment_provider_events"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payment_provider_events_status_check" CHECK ("payment_provider_events"."provider_status" in ('pending', 'succeeded', 'failed', 'expired')),
	CONSTRAINT "payment_provider_events_outcome_check" CHECK ("payment_provider_events"."outcome" in ('applied', 'unmatched', 'mismatch', 'duplicate', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "payment_request_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topup_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_request_outbox_provider_check" CHECK ("payment_request_outbox"."provider" = 'sandbox'),
	CONSTRAINT "payment_request_outbox_status_check" CHECK ("payment_request_outbox"."status" in ('pending', 'processing', 'complete', 'dead')),
	CONSTRAINT "payment_request_outbox_attempts_check" CHECK ("payment_request_outbox"."attempts" >= 0),
	CONSTRAINT "payment_request_outbox_lease_check" CHECK (("payment_request_outbox"."status" = 'processing' and "payment_request_outbox"."lease_token" is not null and "payment_request_outbox"."lease_until" is not null) or ("payment_request_outbox"."status" <> 'processing' and "payment_request_outbox"."lease_token" is null and "payment_request_outbox"."lease_until" is null))
);
--> statement-breakpoint
CREATE TABLE "topup_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_reference" varchar(160) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"amount_minor" numeric NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"status_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topup_intents_provider_check" CHECK ("topup_intents"."provider" = 'sandbox'),
	CONSTRAINT "topup_intents_currency_check" CHECK ("topup_intents"."currency" = 'IDR'),
	CONSTRAINT "topup_intents_amount_check" CHECK ("topup_intents"."amount_minor" > 0 and "topup_intents"."amount_minor" = trunc("topup_intents"."amount_minor") and "topup_intents"."amount_minor" < 1e38),
	CONSTRAINT "topup_intents_hash_check" CHECK ("topup_intents"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "topup_intents_status_check" CHECK ("topup_intents"."status" in ('pending', 'succeeded', 'failed', 'expired', 'needs_assistance')),
	CONSTRAINT "topup_intents_version_check" CHECK ("topup_intents"."status_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."menu_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_option_choices" ADD CONSTRAINT "menu_option_choices_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."menu_option_groups"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_tenant_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_slots" ADD CONSTRAINT "pickup_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_tenant_slot_fk" FOREIGN KEY ("tenant_id","slot_id") REFERENCES "public"."pickup_slots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_operating_hour_overrides" ADD CONSTRAINT "tenant_operating_hour_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_operating_hours" ADD CONSTRAINT "tenant_operating_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_handovers" ADD CONSTRAINT "order_handovers_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_handovers" ADD CONSTRAINT "order_handovers_credential_id_pickup_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."pickup_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_handovers" ADD CONSTRAINT "order_handovers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_handovers" ADD CONSTRAINT "order_handovers_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_request_idempotency" ADD CONSTRAINT "order_request_idempotency_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_request_idempotency" ADD CONSTRAINT "order_request_idempotency_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_credentials" ADD CONSTRAINT "pickup_credentials_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_topup_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."topup_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_request_outbox" ADD CONSTRAINT "payment_request_outbox_topup_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."topup_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_intents" ADD CONSTRAINT "topup_intents_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_intents" ADD CONSTRAINT "topup_intents_wallet_account_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_categories_tenant_name_uq" ON "menu_categories" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "menu_categories_tenant_status_idx" ON "menu_categories" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "menu_items_tenant_status_idx" ON "menu_items" USING btree ("tenant_id","status","name");--> statement-breakpoint
CREATE INDEX "menu_items_category_status_idx" ON "menu_items" USING btree ("category_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_option_choices_group_name_uq" ON "menu_option_choices" USING btree ("group_id","name");--> statement-breakpoint
CREATE INDEX "menu_option_choices_group_status_idx" ON "menu_option_choices" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "menu_option_groups_item_status_idx" ON "menu_option_groups" USING btree ("menu_item_id","status","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_slots_tenant_window_uq" ON "pickup_slots" USING btree ("tenant_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "pickup_slots_tenant_window_status_idx" ON "pickup_slots" USING btree ("tenant_id","starts_at","status");--> statement-breakpoint
CREATE UNIQUE INDEX "slot_reservations_order_unique" ON "slot_reservations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "slot_reservations_tenant_slot_status_idx" ON "slot_reservations" USING btree ("tenant_id","slot_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_operating_overrides_tenant_date_uq" ON "tenant_operating_hour_overrides" USING btree ("tenant_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_operating_hours_tenant_weekday_uq" ON "tenant_operating_hours" USING btree ("tenant_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_version_unique" ON "order_events" USING btree ("order_id","version");--> statement-breakpoint
CREATE INDEX "order_events_order_time_idx" ON "order_events" USING btree ("order_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_handovers_order_unique" ON "order_handovers" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_handovers_credential_unique" ON "order_handovers" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "order_handovers_tenant_time_idx" ON "order_handovers" USING btree ("tenant_id","handed_over_at");--> statement-breakpoint
CREATE INDEX "order_item_options_order_item_idx" ON "order_item_options" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_payments_order_unique" ON "order_payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_payments_ledger_transaction_unique" ON "order_payments" USING btree ("ledger_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_request_idempotency_actor_route_key_unique" ON "order_request_idempotency" USING btree ("actor_user_id","route_name","key_hash");--> statement-breakpoint
CREATE INDEX "order_request_idempotency_order_idx" ON "order_request_idempotency" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_buyer_created_idx" ON "orders" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_tenant_status_pickup_idx" ON "orders" USING btree ("tenant_id","status","pickup_starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_credentials_one_current_order_unique" ON "pickup_credentials" USING btree ("order_id") WHERE "pickup_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_credentials_code_hash_unique" ON "pickup_credentials" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_proposals_one_pending_per_order" ON "schedule_proposals" USING btree ("order_id") WHERE "schedule_proposals"."status" = 'pending_buyer';--> statement-breakpoint
CREATE INDEX "schedule_proposals_buyer_status_expiry_idx" ON "schedule_proposals" USING btree ("buyer_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_events_provider_event_uq" ON "payment_provider_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "payment_provider_events_topup_received_idx" ON "payment_provider_events" USING btree ("topup_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_request_outbox_topup_uq" ON "payment_request_outbox" USING btree ("topup_id");--> statement-breakpoint
CREATE INDEX "payment_request_outbox_pending_idx" ON "payment_request_outbox" USING btree ("status","available_at","lease_until","id");--> statement-breakpoint
CREATE UNIQUE INDEX "topup_intents_user_idempotency_uq" ON "topup_intents" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "topup_intents_provider_reference_uq" ON "topup_intents" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "topup_intents_user_created_idx" ON "topup_intents" USING btree ("user_id","created_at","id");