BEGIN;

-- Apply after 20260924_sessions_prescriptions.sql. Unknown legacy roles must be reviewed, not guessed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_allowlist' AND conrelid = 'users'::regclass) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_allowlist CHECK (role IN ('patient', 'doctor', 'admin'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS security_audit (
    id BIGSERIAL PRIMARY KEY,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action VARCHAR(80) NOT NULL,
    resource_type VARCHAR(40) NOT NULL,
    resource_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_audit_time ON security_audit(created_at DESC, id DESC);

-- Never infer historical authorship from an email that could already have been reassigned.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES users(id);

-- Invalidate sessions even if an operator changes a role/password directly through SQL.
CREATE OR REPLACE FUNCTION qamqor_revoke_changed_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.password IS DISTINCT FROM OLD.password
        OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        NEW.session_version := GREATEST(NEW.session_version, OLD.session_version + 1);
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS qamqor_identity_change ON users;
CREATE TRIGGER qamqor_identity_change BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION qamqor_revoke_changed_identity();

CREATE OR REPLACE FUNCTION qamqor_protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Audit entries are append-only';
END $$;
DROP TRIGGER IF EXISTS qamqor_audit_immutable ON security_audit;
CREATE TRIGGER qamqor_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON security_audit
    FOR EACH STATEMENT EXECUTE FUNCTION qamqor_protect_audit();

CREATE INDEX IF NOT EXISTS appointments_patient_history ON appointments(patient_iin, date DESC, id DESC);
-- Conflicts abort the migration; existing patient bookings must never be silently cancelled.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_unique_patient_slot
    ON appointments(patient_iin, date, time) WHERE status = 'upcoming';
CREATE INDEX IF NOT EXISTS appointments_doctor_history ON appointments(doctor_iin, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS analyses_patient_history ON analyses(patient_iin, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS chat_messages_reverse_participants ON chat_messages(receiver, sender, created_at DESC, id DESC);

-- Serialize scheduling with revocation so concurrent requests cannot reactivate a revoked prescription.
CREATE OR REPLACE FUNCTION qamqor_check_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prescription_status TEXT;
BEGIN
    SELECT status INTO prescription_status FROM prescriptions WHERE id = NEW.prescription_id FOR UPDATE;
    IF NEW.reminders_enabled AND prescription_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'Prescription is not active' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.start_at <= now() AND NEW.start_at IS DISTINCT FROM OLD.start_at THEN
        RAISE EXCEPTION 'A started course cannot be restarted' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS qamqor_schedule_active ON prescription_schedules;
CREATE TRIGGER qamqor_schedule_active BEFORE INSERT OR UPDATE ON prescription_schedules
    FOR EACH ROW EXECUTE FUNCTION qamqor_check_schedule();
CREATE OR REPLACE FUNCTION qamqor_disable_revoked_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE prescription_schedules SET reminders_enabled = false, updated_at = now() WHERE prescription_id = NEW.id;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS qamqor_prescription_revoked ON prescriptions;
CREATE TRIGGER qamqor_prescription_revoked AFTER UPDATE OF status ON prescriptions
    FOR EACH ROW WHEN (NEW.status = 'revoked') EXECUTE FUNCTION qamqor_disable_revoked_schedule();

CREATE OR REPLACE FUNCTION qamqor_preserve_completed_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'completed' AND (NEW.status IS DISTINCT FROM OLD.status
        OR NEW.treatment IS DISTINCT FROM OLD.treatment OR NEW.diagnosis IS DISTINCT FROM OLD.diagnosis
        OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.doctor_iin IS DISTINCT FROM OLD.doctor_iin
        OR NEW.patient_iin IS DISTINCT FROM OLD.patient_iin OR NEW.date IS DISTINCT FROM OLD.date
        OR NEW.time IS DISTINCT FROM OLD.time OR NEW.type IS DISTINCT FROM OLD.type
        OR NEW.message IS DISTINCT FROM OLD.message) THEN
        RAISE EXCEPTION 'Completed clinical record requires a versioned amendment' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS qamqor_completed_record ON appointments;
CREATE TRIGGER qamqor_completed_record BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION qamqor_preserve_completed_appointment();

INSERT INTO qamqormed_schema_migrations(version) VALUES ('20260924_roles_audit') ON CONFLICT (version) DO NOTHING;
COMMIT;
