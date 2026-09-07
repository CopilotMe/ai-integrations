-- The audit log is the product. An audit trail the application can rewrite is
-- not an audit trail, so append-only is enforced by the database rather than by
-- the discipline of whoever writes the next feature.
--
-- A trigger rather than a REVOKE because it survives the application connecting
-- as the table owner — which is exactly what happens on Supabase and Neon,
-- where the app role frequently owns its own schema.

CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct the record by appending a new event, never by editing history.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- Messages are equally immutable: everything downstream cites them, so an edit
-- would silently invalidate every classification, decision and approval made
-- against the original text.
CREATE OR REPLACE FUNCTION messages_are_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'messages are immutable: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Re-ingest as a new message rather than editing the received one.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_no_update
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_are_immutable();

-- `cases.version` backs optimistic concurrency: two operators opening the same
-- pending case must not both be able to approve it. Bump it on every write so
-- the application never has to remember to.
CREATE OR REPLACE FUNCTION cases_bump_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cases_version_bump
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_bump_version();
