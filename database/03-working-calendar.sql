-- Incremental calendar tables for a volume created before non-working days.
-- Fresh installs already have this in init.sql. Safe to run more than once.

ALTER TABLE branches ADD COLUMN IF NOT EXISTS province VARCHAR(80);
ALTER TABLE branches ADD COLUMN IF NOT EXISTS location_name VARCHAR(120);

DO $$ BEGIN
  CREATE TYPE nodevault_closure_scope AS ENUM ('TENANT', 'PROVINCE', 'LOCATION', 'BRANCH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS non_working_closures (
  closure_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  scope nodevault_closure_scope NOT NULL,
  province VARCHAR(80),
  location_name VARCHAR(120),
  reason TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  set_by_user_id INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(reason) BETWEEN 3 AND 400),
  CHECK (end_date >= start_date),
  CHECK (end_date - start_date <= 62),
  CHECK (
    (scope = 'TENANT' AND province IS NULL AND location_name IS NULL)
    OR (scope = 'PROVINCE' AND province IS NOT NULL AND location_name IS NULL)
    OR (scope = 'LOCATION' AND location_name IS NOT NULL AND province IS NULL)
    OR (scope = 'BRANCH' AND province IS NULL AND location_name IS NULL)
  ),
  FOREIGN KEY (tenant_id, set_by_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS non_working_closure_branches (
  closure_id BIGINT NOT NULL REFERENCES non_working_closures (closure_id),
  tenant_id INT NOT NULL,
  branch_id INT NOT NULL,
  PRIMARY KEY (closure_id, branch_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE IF NOT EXISTS non_working_closure_cancellations (
  cancellation_id BIGSERIAL PRIMARY KEY,
  closure_id BIGINT NOT NULL UNIQUE REFERENCES non_working_closures (closure_id),
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  cancelled_by_user_id INT NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cancelled_by_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS gazetted_holidays (
  holiday_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  holiday_date DATE NOT NULL,
  name VARCHAR(160) NOT NULL,
  gazette_reference VARCHAR(80),
  set_by_user_id INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 3 AND 160),
  UNIQUE (tenant_id, holiday_date, name),
  FOREIGN KEY (tenant_id, set_by_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS gazetted_holiday_cancellations (
  cancellation_id BIGSERIAL PRIMARY KEY,
  holiday_id BIGINT NOT NULL UNIQUE REFERENCES gazetted_holidays (holiday_id),
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  cancelled_by_user_id INT NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cancelled_by_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE OR REPLACE FUNCTION nodevault_reject_calendar_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'working calendar rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS non_working_closures_append_only ON non_working_closures;
CREATE TRIGGER non_working_closures_append_only
BEFORE UPDATE OR DELETE ON non_working_closures
FOR EACH ROW EXECUTE FUNCTION nodevault_reject_calendar_mutation();

DROP TRIGGER IF EXISTS non_working_closure_branches_append_only ON non_working_closure_branches;
CREATE TRIGGER non_working_closure_branches_append_only
BEFORE UPDATE OR DELETE ON non_working_closure_branches
FOR EACH ROW EXECUTE FUNCTION nodevault_reject_calendar_mutation();

DROP TRIGGER IF EXISTS non_working_closure_cancellations_append_only ON non_working_closure_cancellations;
CREATE TRIGGER non_working_closure_cancellations_append_only
BEFORE UPDATE OR DELETE ON non_working_closure_cancellations
FOR EACH ROW EXECUTE FUNCTION nodevault_reject_calendar_mutation();

DROP TRIGGER IF EXISTS gazetted_holidays_append_only ON gazetted_holidays;
CREATE TRIGGER gazetted_holidays_append_only
BEFORE UPDATE OR DELETE ON gazetted_holidays
FOR EACH ROW EXECUTE FUNCTION nodevault_reject_calendar_mutation();

DROP TRIGGER IF EXISTS gazetted_holiday_cancellations_append_only ON gazetted_holiday_cancellations;
CREATE TRIGGER gazetted_holiday_cancellations_append_only
BEFORE UPDATE OR DELETE ON gazetted_holiday_cancellations
FOR EACH ROW EXECUTE FUNCTION nodevault_reject_calendar_mutation();

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nodevault_app;
GRANT SELECT, INSERT ON non_working_closures, non_working_closure_branches,
  non_working_closure_cancellations, gazetted_holidays, gazetted_holiday_cancellations
  TO nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON non_working_closures FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON non_working_closure_branches FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON non_working_closure_cancellations FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON gazetted_holidays FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON gazetted_holiday_cancellations FROM nodevault_app;
