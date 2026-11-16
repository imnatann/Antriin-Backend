ALTER TABLE "payment_provider_events" DROP CONSTRAINT "payment_provider_events_provider_check";--> statement-breakpoint
ALTER TABLE "payment_request_outbox" DROP CONSTRAINT "payment_request_outbox_provider_check";--> statement-breakpoint
ALTER TABLE "topup_intents" DROP CONSTRAINT "topup_intents_provider_check";--> statement-breakpoint
ALTER TABLE "topup_intents" ADD COLUMN "qr_string" varchar(4096);--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_provider_check" CHECK ("payment_provider_events"."provider" in ('sandbox', 'xendit'));--> statement-breakpoint
ALTER TABLE "payment_request_outbox" ADD CONSTRAINT "payment_request_outbox_provider_check" CHECK ("payment_request_outbox"."provider" in ('sandbox', 'xendit'));--> statement-breakpoint
ALTER TABLE "topup_intents" ADD CONSTRAINT "topup_intents_provider_check" CHECK ("topup_intents"."provider" in ('sandbox', 'xendit'));