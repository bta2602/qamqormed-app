BEGIN;

ALTER TABLE users ALTER COLUMN password TYPE TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS users_public_id ON users(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_case_insensitive ON users(lower(email));
ALTER TABLE users ADD COLUMN IF NOT EXISTS blood_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS spec VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS exp VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS img TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating NUMERIC(3,1);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS auth_throttle (
    bucket CHAR(64) PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS doctor_iin VARCHAR(12);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS diagnosis TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS treatment TEXT;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'appointments' AND column_name = 'doctor_id') THEN
        -- Only accept unambiguous legacy references; never guess a doctor for a clinical record.
        IF EXISTS (SELECT 1 FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
            WHERE a.doctor_id IS NOT NULL AND (u.id IS NULL OR u.iin IS NULL OR
                (a.doctor_iin IS NOT NULL AND a.doctor_iin <> u.iin))) THEN
            RAISE EXCEPTION 'Conflicting or orphaned appointment doctor_id; reconcile before migration';
        END IF;
        UPDATE appointments a SET doctor_iin = u.iin FROM users u
            WHERE a.doctor_iin IS NULL AND a.doctor_id = u.id;
        ALTER TABLE appointments ALTER COLUMN doctor_id DROP NOT NULL;
    END IF;
END $$;
-- Resolve existing duplicate upcoming slots before running this migration. No appointments are deleted here.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_unique_upcoming_slot
    ON appointments(doctor_iin, date, time) WHERE status = 'upcoming';
CREATE INDEX IF NOT EXISTS appointments_care_relationship ON appointments(doctor_iin, patient_iin);

CREATE TABLE IF NOT EXISTS prescriptions (
    id BIGSERIAL PRIMARY KEY,
    doctor_id INTEGER NOT NULL REFERENCES users(id),
    patient_id INTEGER NOT NULL REFERENCES users(id),
    medicine VARCHAR(160) NOT NULL CHECK (length(trim(medicine)) > 0),
    dosage VARCHAR(160) NOT NULL CHECK (length(trim(dosage)) > 0),
    instructions TEXT NOT NULL DEFAULT '',
    interval_hours INTEGER NOT NULL CHECK (interval_hours IN (4, 6, 8, 12, 24)),
    duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
    status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    CHECK (doctor_id <> patient_id)
);
CREATE INDEX IF NOT EXISTS prescriptions_patient ON prescriptions(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prescriptions_doctor ON prescriptions(doctor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS prescription_schedules (
    prescription_id BIGINT PRIMARY KEY REFERENCES prescriptions(id) ON DELETE CASCADE,
    start_at TIMESTAMPTZ NOT NULL,
    timezone VARCHAR(80) NOT NULL,
    reminders_enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    sender VARCHAR(50) NOT NULL,
    receiver VARCHAR(50) NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_participants ON chat_messages(sender, receiver, created_at);

-- Written only if the entire migration commits; the deployment gate reads this receipt.
CREATE TABLE IF NOT EXISTS qamqormed_schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO qamqormed_schema_migrations(version)
    VALUES ('20260924_sessions_prescriptions') ON CONFLICT (version) DO NOTHING;
COMMIT;
