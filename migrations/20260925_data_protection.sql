BEGIN;
-- Schema only. Key material must never be placed in SQL or stored in this database.
-- Applying this file does NOT encrypt existing rows. See DATA-PROTECTION-RU.md.
ALTER TABLE analyses ALTER COLUMN type TYPE TEXT;
ALTER TABLE prescriptions ALTER COLUMN medicine TYPE TEXT;
ALTER TABLE prescriptions ALTER COLUMN dosage TYPE TEXT;

CREATE TABLE IF NOT EXISTS password_recovery_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash CHAR(64) NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    session_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS password_recovery_pending ON password_recovery_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS password_recovery_user ON password_recovery_requests(user_id);
INSERT INTO qamqormed_schema_migrations(version) VALUES ('20260925_data_protection') ON CONFLICT (version) DO NOTHING;
COMMIT;
