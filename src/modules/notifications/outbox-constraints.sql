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
