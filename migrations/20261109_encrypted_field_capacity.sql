BEGIN;
SET LOCAL lock_timeout = '5s';

-- Older installations already have VARCHAR(255); ADD COLUMN IF NOT EXISTS cannot widen it.
ALTER TABLE appointments ALTER COLUMN diagnosis TYPE TEXT;

INSERT INTO qamqormed_schema_migrations(version)
VALUES ('20261109_encrypted_field_capacity') ON CONFLICT (version) DO NOTHING;
COMMIT;
