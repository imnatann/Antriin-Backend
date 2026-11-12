CREATE TRIGGER access_audit_events_no_truncate BEFORE TRUNCATE ON access_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION access_audit_events_prevent_mutation();
--> statement-breakpoint
CREATE TRIGGER outbox_events_no_truncate BEFORE TRUNCATE ON outbox_events
FOR EACH STATEMENT EXECUTE FUNCTION antriin_audit_immutable();
