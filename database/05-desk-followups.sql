-- Surprise-check archive and assignment for a database created before those columns.
-- Tests rebuild from database/init.sql. Apply this file once to a live database.

ALTER TABLE surprise_checks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS surprise_assignments (
  assignment_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  business_date DATE NOT NULL,
  assignee_user_id INT NOT NULL,
  assigned_by_user_id INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, business_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES nodevault_users (tenant_id, user_id),
  FOREIGN KEY (tenant_id, assigned_by_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

DROP TRIGGER IF EXISTS surprise_checks_append_only ON surprise_checks;
DROP TRIGGER IF EXISTS surprise_check_books_append_only ON surprise_check_books;

CREATE OR REPLACE FUNCTION nodevault_guard_surprise_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.check_id IS DISTINCT FROM OLD.check_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
    OR NEW.business_date IS DISTINCT FROM OLD.business_date
    OR NEW.checked_at IS DISTINCT FROM OLD.checked_at
    OR NEW.checker_user_id IS DISTINCT FROM OLD.checker_user_id
    OR NEW.checker_name IS DISTINCT FROM OLD.checker_name
    OR NEW.checker_employee_id IS DISTINCT FROM OLD.checker_employee_id
    OR NEW.checker_role IS DISTINCT FROM OLD.checker_role
    OR NEW.custodians_present IS DISTINCT FROM OLD.custodians_present
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'a surprise check can only be archived or deleted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS surprise_checks_archive_only ON surprise_checks;
CREATE TRIGGER surprise_checks_archive_only
BEFORE UPDATE OR DELETE ON surprise_checks
FOR EACH ROW
EXECUTE FUNCTION nodevault_guard_surprise_check();

CREATE OR REPLACE FUNCTION nodevault_reject_surprise_book_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'surprise check book rows are not rewritten';
END;
$$;

DROP TRIGGER IF EXISTS surprise_check_books_no_rewrite ON surprise_check_books;
CREATE TRIGGER surprise_check_books_no_rewrite
BEFORE UPDATE OR DELETE ON surprise_check_books
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_surprise_book_update();

GRANT UPDATE (archived_at) ON surprise_checks TO nodevault_app;
GRANT DELETE ON surprise_checks TO nodevault_app;
GRANT DELETE ON surprise_check_books TO nodevault_app;
GRANT SELECT, INSERT ON surprise_assignments TO nodevault_app;
GRANT UPDATE (assignee_user_id, assigned_by_user_id, created_at) ON surprise_assignments TO nodevault_app;
GRANT DELETE ON surprise_assignments TO nodevault_app;

ALTER TABLE bank_tenants ALTER COLUMN logo_file SET DEFAULT 'fnb-acacia.png';
UPDATE bank_tenants
SET logo_file = 'fnb-acacia.png'
WHERE logo_file = 'fnb-logo-placeholder.png';
