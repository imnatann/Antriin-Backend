CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_service" varchar(80),
	"scope_type" varchar(16) NOT NULL,
	"scope_id" uuid NOT NULL,
	"action" varchar(100) NOT NULL,
	"target_type" varchar(40) NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_check" CHECK (("audit_events"."actor_user_id" is not null and "audit_events"."actor_service" is null) or ("audit_events"."actor_user_id" is null and "audit_events"."actor_service" is not null)),
	CONSTRAINT "audit_events_scope_check" CHECK ("audit_events"."scope_type" in ('user','tenant','campus'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_scope_cursor_idx" ON "audit_events" USING btree ("scope_type","scope_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id","occurred_at");
--> statement-breakpoint
CREATE FUNCTION antriin_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION antriin_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION antriin_audit_immutable();
