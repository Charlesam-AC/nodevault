-- Printing and auditor review for an existing NodeVault database.
-- Tests rebuild from database/init.sql. Apply this file once to a live database.

ALTER TABLE bank_tenants
  ADD COLUMN IF NOT EXISTS logo_file VARCHAR(120) NOT NULL DEFAULT 'fnb-logo-placeholder.png';

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS printer_target VARCHAR(200);

ALTER TABLE nodevault_users
  ADD COLUMN IF NOT EXISTS current_audit_branch_id INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'nodevault_users'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%current_audit_branch_id%'
  ) THEN
    ALTER TABLE nodevault_users
      ADD CONSTRAINT nodevault_users_current_audit_branch_fkey
      FOREIGN KEY (tenant_id, current_audit_branch_id) REFERENCES branches (tenant_id, branch_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS auditor_branches (
  user_id INT NOT NULL,
  branch_id INT NOT NULL,
  tenant_id INT NOT NULL,
  pending_final_comment_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES nodevault_users (tenant_id, user_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE IF NOT EXISTS audit_line_marks (
  mark_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  matrix_tx_id BIGINT NOT NULL UNIQUE REFERENCES vault_denomination_matrix_ledger (matrix_tx_id),
  mark_status VARCHAR(32) NOT NULL CHECK (mark_status IN (
    'REVIEWED', 'MATCHED', 'UNMATCHED', 'MATCHED_WITH_DIFFERENCE'
  )),
  comment TEXT NOT NULL DEFAULT '',
  core_ref_kind VARCHAR(16) CHECK (core_ref_kind IS NULL OR core_ref_kind IN ('CIT_SLIP', 'ATM', 'TELLER')),
  marked_by INT NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, marked_by) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_signoffs (
  signoff_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  auditor_user_id INT NOT NULL,
  range_from DATE NOT NULL,
  range_to DATE NOT NULL,
  end_comment TEXT NOT NULL,
  full_legal_name VARCHAR(120) NOT NULL,
  employee_id VARCHAR(32) NOT NULL,
  work_email VARCHAR(160) NOT NULL,
  system_role VARCHAR(40) NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (range_to >= range_from),
  CHECK (length(btrim(end_comment)) > 0),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, auditor_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS vault_sheets (
  sheet_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  direction VARCHAR(16) NOT NULL CHECK (direction IN ('FROM_VAULT', 'TO_VAULT')),
  business_date DATE NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amounts JSONB NOT NULL,
  signatories JSONB NOT NULL,
  line_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  printed_at TIMESTAMPTZ,
  created_by INT NOT NULL,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS print_jobs (
  job_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  document_kind VARCHAR(32) NOT NULL CHECK (document_kind IN (
    'CLOSING_SHEET', 'TAKEOVER_SLIP', 'SURPRISE_SLIP', 'AUDIT_SHEET', 'VAULT_SHEET'
  )),
  source_ref VARCHAR(64) NOT NULL,
  printer_target VARCHAR(200),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE IF NOT EXISTS mock_core_transactions (
  core_tx_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  book_class nodevault_book_class NOT NULL,
  business_date DATE NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference VARCHAR(64) NOT NULL,
  description TEXT NOT NULL,
  currency_code CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (tenant_id, branch_id, book_class, reference),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE OR REPLACE FUNCTION nodevault_reject_signoff_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'audit sign-offs are append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_signoffs_append_only ON audit_signoffs;
CREATE TRIGGER audit_signoffs_append_only
  BEFORE UPDATE OR DELETE ON audit_signoffs
  FOR EACH ROW
  EXECUTE FUNCTION nodevault_reject_signoff_mutation();

CREATE OR REPLACE FUNCTION nodevault_freeze_audit_mark()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM audit_signoffs s
    JOIN vault_denomination_matrix_ledger l ON l.matrix_tx_id = OLD.matrix_tx_id
    JOIN branch_vault_books b ON b.book_id = l.book_id
    WHERE s.tenant_id = OLD.tenant_id
      AND s.branch_id = b.branch_id
      AND b.business_date BETWEEN s.range_from AND s.range_to
  ) THEN
    RAISE EXCEPTION 'audit marks are frozen after sign-off';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_line_marks_freeze ON audit_line_marks;
CREATE TRIGGER audit_line_marks_freeze
  BEFORE UPDATE ON audit_line_marks
  FOR EACH ROW
  EXECUTE FUNCTION nodevault_freeze_audit_mark();

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nodevault_app;
GRANT SELECT, INSERT ON mock_core_transactions, auditor_branches, audit_line_marks,
  audit_signoffs, vault_sheets, print_jobs TO nodevault_app;
GRANT UPDATE (current_audit_branch_id) ON nodevault_users TO nodevault_app;
GRANT UPDATE (logo_label, logo_file) ON bank_tenants TO nodevault_app;
GRANT UPDATE (printer_target) ON branches TO nodevault_app;
GRANT UPDATE (pending_final_comment_at) ON auditor_branches TO nodevault_app;
GRANT DELETE ON auditor_branches TO nodevault_app;
GRANT UPDATE (mark_status, comment, core_ref_kind, marked_by, marked_at) ON audit_line_marks TO nodevault_app;
GRANT UPDATE (printed_at, line_ids) ON vault_sheets TO nodevault_app;
GRANT UPDATE (status, attempts, last_error, sent_at, printer_target) ON print_jobs TO nodevault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_core_transactions TO nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_signoffs FROM nodevault_app;
