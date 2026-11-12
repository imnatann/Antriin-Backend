ALTER TABLE "order_events" DROP CONSTRAINT "order_events_type_check";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_quantity_check";--> statement-breakpoint
ALTER TABLE "tenant_operating_hour_overrides" ADD CONSTRAINT "tenant_operating_hour_overrides_pk" PRIMARY KEY("tenant_id","local_date");--> statement-breakpoint
ALTER TABLE "tenant_operating_hours" ADD CONSTRAINT "tenant_operating_hours_pk" PRIMARY KEY("tenant_id","weekday");--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_owner_id_uq" UNIQUE("owner_user_id","id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_id_uq" UNIQUE("buyer_id","id");--> statement-breakpoint
ALTER TABLE "pickup_credentials" ADD CONSTRAINT "pickup_credentials_order_id_id_uq" UNIQUE("order_id","id");--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "image_ref" varchar(500);--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_operating_hour_overrides" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_operating_hours" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "notes" varchar(500) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_request_idempotency" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_number" varchar(32);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topup_intents" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topup_intents" ADD COLUMN "succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_request_fk" FOREIGN KEY ("request_id") REFERENCES "public"."order_request_idempotency"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_handovers" ADD CONSTRAINT "order_handovers_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_handovers" ADD CONSTRAINT "order_handovers_order_credential_fk" FOREIGN KEY ("order_id","credential_id") REFERENCES "public"."pickup_credentials"("order_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_slot_fk" FOREIGN KEY ("tenant_id","pickup_slot_id") REFERENCES "public"."pickup_slots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_tenant_proposed_slot_fk" FOREIGN KEY ("tenant_id","proposed_slot_id") REFERENCES "public"."pickup_slots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_tenant_old_slot_fk" FOREIGN KEY ("tenant_id","old_slot_id") REFERENCES "public"."pickup_slots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_intents" ADD CONSTRAINT "topup_intents_user_wallet_fk" FOREIGN KEY ("user_id","wallet_account_id") REFERENCES "public"."wallet_accounts"("owner_user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_events_order_request_idx" ON "order_events" USING btree ("order_id","request_id");--> statement-breakpoint
CREATE INDEX "order_request_idempotency_expires_idx" ON "order_request_idempotency" USING btree ("expires_at") WHERE "order_request_idempotency"."expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_uq" ON "orders" USING btree ("order_number");--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_archived_at_check" CHECK (("menu_items"."status" = 'archived' and "menu_items"."archived_at" is not null) or ("menu_items"."status" <> 'archived' and "menu_items"."archived_at" is null));--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_consumed_at_check" CHECK (("slot_reservations"."status" = 'consumed' and "slot_reservations"."consumed_at" is not null) or ("slot_reservations"."status" <> 'consumed' and "slot_reservations"."consumed_at" is null));--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_check" CHECK ("order_events"."event_type" in ('order.created', 'order.status_changed', 'order.cancelled', 'order.declined', 'schedule_proposal.created', 'schedule_proposal.decided', 'pickup_credential.issued', 'pickup_credential.revoked'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_line_total_check" CHECK ("order_items"."line_total_minor" = "order_items"."unit_price_minor" * "order_items"."quantity");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" between 1 and 999);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_timestamps_check" CHECK (("orders"."status" = 'paid_awaiting_tenant' and "orders"."confirmed_at" is null and "orders"."preparing_at" is null and "orders"."ready_at" is null and "orders"."completed_at" is null) or ("orders"."status" in ('confirmed', 'preparing', 'ready_for_pickup') and "orders"."confirmed_at" is not null and "orders"."paid_at" is not null) or ("orders"."status" = 'completed' and "orders"."confirmed_at" is not null and "orders"."paid_at" is not null and "orders"."ready_at" is not null and "orders"."completed_at" is not null) or ("orders"."status" = 'cancelled' and "orders"."cancelled_at" is not null) or ("orders"."status" = 'declined' and "orders"."declined_at" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_timestamps_monotonic_check" CHECK ("orders"."created_at" <= "orders"."confirmed_at" and "orders"."confirmed_at" <= "orders"."preparing_at" and "orders"."preparing_at" <= "orders"."ready_at" and "orders"."ready_at" <= "orders"."completed_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_equals_subtotal_check" CHECK ("orders"."total_minor" = "orders"."subtotal_minor");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_positive_totals_check" CHECK ("orders"."subtotal_minor" > 0 and "orders"."total_minor" > 0);--> statement-breakpoint
ALTER TABLE "pickup_credentials" ADD CONSTRAINT "pickup_credentials_expires_at_check" CHECK ("pickup_credentials"."expires_at" > "pickup_credentials"."created_at");--> statement-breakpoint
ALTER TABLE "pickup_credentials" ADD CONSTRAINT "pickup_credentials_consume_revoke_check" CHECK ("pickup_credentials"."consumed_at" is null or "pickup_credentials"."revoked_at" is null);--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_expires_at_check" CHECK ("schedule_proposals"."expires_at" > "schedule_proposals"."created_at");--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_decided_at_check" CHECK (("schedule_proposals"."status" = 'pending_buyer' and "schedule_proposals"."decided_at" is null) or ("schedule_proposals"."status" <> 'pending_buyer' and "schedule_proposals"."decided_at" is not null));--> statement-breakpoint
ALTER TABLE "topup_intents" ADD CONSTRAINT "topup_intents_expires_at_check" CHECK ("topup_intents"."expires_at" is null or "topup_intents"."expires_at" > "topup_intents"."created_at");--> statement-breakpoint
ALTER TABLE "topup_intents" ADD CONSTRAINT "topup_intents_succeeded_at_check" CHECK ("topup_intents"."succeeded_at" is null or "topup_intents"."status" = 'succeeded');;
