CREATE FUNCTION access_audit_events_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access_audit_events is append-only';
END;
$$;

CREATE TRIGGER access_audit_events_immutable
BEFORE UPDATE OR DELETE ON access_audit_events
FOR EACH ROW EXECUTE FUNCTION access_audit_events_prevent_mutation();
