-- NodeVault schema
-- Author: Charles Amulike
-- Money is stored as BIGINT minor units (1/100 of the major unit). No float columns.
-- Ledger rows, amount cells, and audit events are append-only.

CREATE TYPE nodevault_book_class AS ENUM (
  'KWACHA_TREASURY',
  'FOREIGN_CURRENCY',
  'BANCS_TREASURY'
);

CREATE TYPE nodevault_book_status AS ENUM (
  'OPEN',
  'BALANCED_CLOSED'
);

CREATE TABLE bank_tenants (
  tenant_id SERIAL PRIMARY KEY,
  bank_name VARCHAR(100) NOT NULL UNIQUE,
  corporate_domain VARCHAR(100) NOT NULL UNIQUE,
  logo_label VARCHAR(40) NOT NULL DEFAULT '',
  -- Print-only image. The desk never draws this file.
  logo_file VARCHAR(120) NOT NULL DEFAULT 'fnb-acacia.png',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  branch_id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_code VARCHAR(20) NOT NULL,
  branch_name VARCHAR(120) NOT NULL,
  province VARCHAR(80),
  location_name VARCHAR(120),
  is_active BOOLEAN NOT NULL DEFAULT true,
  permanently_closed BOOLEAN NOT NULL DEFAULT false,
  -- host, host:port (port 9100 when omitted), or an IPP URL. Null until an admin sets it.
  printer_target VARCHAR(200),
  CHECK (NOT permanently_closed OR NOT is_active),
  UNIQUE (tenant_id, branch_code),
  UNIQUE (tenant_id, branch_id)
);

CREATE TABLE nodevault_users (
  user_id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT,
  -- The one branch an auditor is working. Vault users leave this null.
  current_audit_branch_id INT,
  work_email VARCHAR(160) NOT NULL UNIQUE,
  full_legal_name VARCHAR(120) NOT NULL,
  employee_id VARCHAR(32) NOT NULL,
  two_letter_initials VARCHAR(8) NOT NULL,
  system_role VARCHAR(40) NOT NULL CHECK (system_role ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  -- Closing ceremony credential. Never the same secret as password_hash.
  closing_pin_hash TEXT,
  -- Directory password for optional local sign-in. Null when the user has no password.
  password_hash TEXT,
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  entra_object_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, current_audit_branch_id) REFERENCES branches (tenant_id, branch_id)
);

-- Extra roles the master admin adds. Built-in role codes stay in the application.
CREATE TABLE desk_roles (
  role_id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  role_code VARCHAR(40) NOT NULL CHECK (role_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  display_name VARCHAR(80) NOT NULL,
  power_tier VARCHAR(40) NOT NULL CHECK (power_tier IN ('READER', 'BRANCH_ADMINISTRATOR', 'BRANCH_MANAGER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, role_code)
);

CREATE TABLE system_control (
  tenant_id INT PRIMARY KEY REFERENCES bank_tenants (tenant_id),
  initialized_at TIMESTAMPTZ,
  it_admin_frozen BOOLEAN NOT NULL DEFAULT false,
  entra_enabled BOOLEAN NOT NULL DEFAULT true
);

-- The weekly head teller is an assignment, not "any teller".
CREATE TABLE weekly_coordinator_assignments (
  assignment_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  coordinator_user_id INT NOT NULL,
  iso_year INT NOT NULL,
  iso_week INT NOT NULL CHECK (iso_week BETWEEN 1 AND 53),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, iso_year, iso_week),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, coordinator_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

-- Who holds each vault post for a date range. The closing interlock reads this, not "any" person of that role.
CREATE TABLE rotation_schedules (
  schedule_id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  post_code VARCHAR(32) NOT NULL CHECK (post_code IN ('CUSTODIAN_ONE', 'CUSTODIAN_TWO', 'HEAD_TELLER')),
  cadence VARCHAR(16) NOT NULL CHECK (cadence IN ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'CUSTOM')),
  custom_days INT,
  anchor_date DATE NOT NULL,
  CHECK (
    (cadence = 'CUSTOM' AND custom_days BETWEEN 1 AND 366)
    OR (cadence <> 'CUSTOM' AND custom_days IS NULL)
  ),
  UNIQUE (tenant_id, branch_id, post_code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE handover_logs (
  handover_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  effective_date DATE NOT NULL,
  balances JSONB NOT NULL,
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, effective_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

-- In or Out choices. A new bank starts with In, Out, CIT In, and CIT Out.
-- Bal c/d can be written on an open book without an In line first.
CREATE TABLE movement_options (
  option_id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  label VARCHAR(32) NOT NULL,
  flow_direction VARCHAR(3) NOT NULL CHECK (flow_direction IN ('IN', 'OUT')),
  carries_down BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tenant_id, label)
);

CREATE UNIQUE INDEX movement_options_one_carry
  ON movement_options (tenant_id)
  WHERE carries_down;

-- Takeover narration is not a ledger line. It does not hold denomination cells.
CREATE TABLE book_narrations (
  narration_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  handover_id BIGINT NOT NULL REFERENCES handover_logs (handover_id),
  book_class nodevault_book_class NOT NULL,
  business_date DATE NOT NULL,
  narration_text TEXT NOT NULL,
  totals JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (handover_id, book_class),
  UNIQUE (tenant_id, branch_id, book_class, business_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

-- A surprise cash check is not a ledger movement and does not change Bal b/f, b/d, or c/d.
CREATE TABLE surprise_checks (
  check_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  business_date DATE NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  checker_user_id INT NOT NULL,
  checker_name VARCHAR(120) NOT NULL,
  checker_employee_id VARCHAR(32) NOT NULL,
  checker_role VARCHAR(40) NOT NULL,
  custodians_present JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, checker_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

-- Who counts the vault on one open date. Not a ledger line.
CREATE TABLE surprise_assignments (
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

CREATE TABLE post_assignments (
  assignment_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  post_code VARCHAR(32) NOT NULL CHECK (post_code IN ('CUSTODIAN_ONE', 'CUSTODIAN_TWO', 'HEAD_TELLER')),
  user_id INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  handover_id BIGINT REFERENCES handover_logs (handover_id),
  CHECK (period_end >= period_start),
  UNIQUE (tenant_id, branch_id, post_code, period_start),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

-- Bank-decided non-working days. Rows are insert-only. Cancellation is a second row.
CREATE TYPE nodevault_closure_scope AS ENUM ('TENANT', 'PROVINCE', 'LOCATION', 'BRANCH');

CREATE TABLE non_working_closures (
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

CREATE TABLE non_working_closure_branches (
  closure_id BIGINT NOT NULL REFERENCES non_working_closures (closure_id),
  tenant_id INT NOT NULL,
  branch_id INT NOT NULL,
  PRIMARY KEY (closure_id, branch_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE non_working_closure_cancellations (
  cancellation_id BIGSERIAL PRIMARY KEY,
  closure_id BIGINT NOT NULL UNIQUE REFERENCES non_working_closures (closure_id),
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  cancelled_by_user_id INT NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cancelled_by_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

-- One-off holidays declared nationally (Public Holidays Act s.3). Exact gazette date.
CREATE TABLE gazetted_holidays (
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

CREATE TABLE gazetted_holiday_cancellations (
  cancellation_id BIGSERIAL PRIMARY KEY,
  holiday_id BIGINT NOT NULL UNIQUE REFERENCES gazetted_holidays (holiday_id),
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  cancelled_by_user_id INT NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cancelled_by_user_id) REFERENCES nodevault_users (tenant_id, user_id)
);

-- A morning that could not roll a locked Bal c/d forward. Not a ledger row.
CREATE TABLE carry_forward_flags (
  flag_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  book_class nodevault_book_class NOT NULL,
  business_date DATE NOT NULL,
  prior_business_date DATE NOT NULL,
  reason VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, book_class, business_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE branch_vault_books (
  book_id BIGSERIAL PRIMARY KEY,
  branch_id INT NOT NULL,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  book_class nodevault_book_class NOT NULL,
  business_date DATE NOT NULL,
  status nodevault_book_status NOT NULL DEFAULT 'OPEN',
  closed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, branch_id, book_class, business_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE surprise_check_books (
  check_book_id BIGSERIAL PRIMARY KEY,
  check_id BIGINT NOT NULL REFERENCES surprise_checks (check_id),
  book_id BIGINT NOT NULL REFERENCES branch_vault_books (book_id),
  book_class nodevault_book_class NOT NULL,
  system_totals JSONB NOT NULL,
  counted_totals JSONB NOT NULL,
  matched BOOLEAN NOT NULL,
  narration_text TEXT NOT NULL,
  UNIQUE (check_id, book_class)
);

-- Identity columns sit at the front of the row: line, date, then the three initials.
CREATE TABLE vault_denomination_matrix_ledger (
  matrix_tx_id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES branch_vault_books (book_id) ON DELETE RESTRICT,
  line_number INT NOT NULL CHECK (line_number > 0),
  transaction_date DATE NOT NULL,
  custodian_one_initials VARCHAR(8) NOT NULL,
  custodian_two_initials VARCHAR(8) NOT NULL,
  teller_coord_initials VARCHAR(8) NOT NULL,
  accounting_label VARCHAR(32) NOT NULL,
  line_reference VARCHAR(32),
  flow_direction VARCHAR(3) NOT NULL CHECK (flow_direction IN ('IN', 'OUT', 'BAL')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (book_id, line_number)
);

CREATE TABLE ledger_amount_cells (
  cell_id BIGSERIAL PRIMARY KEY,
  matrix_tx_id BIGINT NOT NULL REFERENCES vault_denomination_matrix_ledger (matrix_tx_id) ON DELETE RESTRICT,
  channel_code VARCHAR(16) NOT NULL,
  denomination_code VARCHAR(24) NOT NULL,
  cell_kind VARCHAR(16) NOT NULL CHECK (cell_kind IN ('DENOMINATION', 'SUBTOTAL', 'GRAND')),
  -- Minor units. A kwacha ngwee, a cent, a euro cent. Never a float.
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (matrix_tx_id, channel_code, denomination_code, cell_kind)
);

CREATE TABLE break_glass_sessions (
  session_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  admin_user_id INT NOT NULL,
  custodian_one_id INT NOT NULL,
  custodian_two_id INT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (custodian_one_id <> custodian_two_id),
  CHECK (expires_at > opened_at),
  FOREIGN KEY (tenant_id, admin_user_id) REFERENCES nodevault_users (tenant_id, user_id),
  FOREIGN KEY (tenant_id, custodian_one_id) REFERENCES nodevault_users (tenant_id, user_id),
  FOREIGN KEY (tenant_id, custodian_two_id) REFERENCES nodevault_users (tenant_id, user_id)
);

CREATE TABLE audit_events (
  audit_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  event_type VARCHAR(64) NOT NULL,
  book_id BIGINT REFERENCES branch_vault_books (book_id) ON DELETE RESTRICT,
  actor_user_ids INT[] NOT NULL DEFAULT '{}',
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Intent to print/email is durable inside the closing transaction.
-- The send itself happens only after COMMIT. Failures stay here for retry.
CREATE TABLE dispatch_outbox (
  dispatch_id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  book_id BIGINT NOT NULL REFERENCES branch_vault_books (book_id) ON DELETE RESTRICT,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('PRINT', 'EMAIL')),
  payload JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An auditor works many branches, one at a time.
CREATE TABLE auditor_branches (
  user_id INT NOT NULL,
  branch_id INT NOT NULL,
  tenant_id INT NOT NULL,
  pending_final_comment_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES nodevault_users (tenant_id, user_id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

-- One mark per ledger line. A later mark before sign-off replaces the comment.
CREATE TABLE audit_line_marks (
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

-- Append-only. A successful print is recorded on print_jobs, not by updating this row.
CREATE TABLE audit_signoffs (
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

-- From Vault / To Vault. line_ids lists the book lines this sheet already posted.
CREATE TABLE vault_sheets (
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

-- Slips and sheets that are not a single closing book. Reprint reads the source again.
CREATE TABLE print_jobs (
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

-- Core transactions for the auditor's unmatched list. Mock mode reads this table.
CREATE TABLE mock_core_transactions (
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

CREATE TRIGGER audit_line_marks_freeze
  BEFORE UPDATE ON audit_line_marks
  FOR EACH ROW
  EXECUTE FUNCTION nodevault_freeze_audit_mark();

-- Column catalogue for each paper book. Values are not stored here.
-- Kwacha Total Treasury is re-issuable (A) plus coins (C).
-- There is no Old Currency column and no non-re-issuable notes section.
CREATE TABLE denomination_catalogue (
  book_class nodevault_book_class NOT NULL,
  page_side VARCHAR(5) NOT NULL CHECK (page_side IN ('LEFT', 'RIGHT')),
  group_code VARCHAR(32) NOT NULL,
  group_label VARCHAR(80) NOT NULL,
  channel_code VARCHAR(24) NOT NULL,
  denomination_code VARCHAR(24) NOT NULL,
  header_label VARCHAR(48) NOT NULL,
  sort_order INT NOT NULL,
  currency_code CHAR(3) NOT NULL,
  symbol VARCHAR(4) NOT NULL,
  cell_kind VARCHAR(16) NOT NULL CHECK (cell_kind IN ('DENOMINATION', 'SUBTOTAL', 'GRAND')),
  in_grand BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (book_class, channel_code, denomination_code, cell_kind)
);

-- Local stand-in for the core banking position API. Not part of the ledger.
CREATE TABLE mock_core_positions (
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT NOT NULL,
  book_id BIGINT NOT NULL REFERENCES branch_vault_books (book_id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (tenant_id, branch_id, book_id, currency_code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE INDEX idx_ledger_book_line ON vault_denomination_matrix_ledger (book_id, line_number);
CREATE INDEX idx_cells_entry ON ledger_amount_cells (matrix_tx_id);
CREATE INDEX idx_users_tenant ON nodevault_users (tenant_id);
CREATE INDEX idx_audit_tenant_created ON audit_events (tenant_id, created_at);
CREATE INDEX idx_assignments_lookup ON weekly_coordinator_assignments (tenant_id, branch_id, iso_year, iso_week);
CREATE INDEX idx_post_assignments_cover ON post_assignments (tenant_id, branch_id, post_code, period_start, period_end);
CREATE INDEX idx_outbox_book ON dispatch_outbox (book_id, status);

CREATE OR REPLACE FUNCTION nodevault_user_email_domain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  domain TEXT;
BEGIN
  SELECT corporate_domain INTO domain FROM bank_tenants WHERE tenant_id = NEW.tenant_id;
  NEW.work_email := lower(btrim(NEW.work_email));
  IF lower(split_part(NEW.work_email, '@', 2)) IS DISTINCT FROM lower(domain) THEN
    RAISE EXCEPTION 'work email must belong to the tenant corporate domain';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nodevault_user_email_domain
BEFORE INSERT OR UPDATE ON nodevault_users
FOR EACH ROW
EXECUTE FUNCTION nodevault_user_email_domain();

CREATE OR REPLACE FUNCTION nodevault_reject_handover_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'handover log is append-only';
END;
$$;

CREATE TRIGGER handover_logs_append_only
BEFORE UPDATE OR DELETE ON handover_logs
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_handover_mutation();

CREATE OR REPLACE FUNCTION nodevault_reject_narration_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'narration records are append-only';
END;
$$;

CREATE TRIGGER book_narrations_append_only
BEFORE UPDATE OR DELETE ON book_narrations
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_narration_mutation();

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

CREATE TRIGGER surprise_check_books_no_rewrite
BEFORE UPDATE OR DELETE ON surprise_check_books
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_surprise_book_update();

CREATE OR REPLACE FUNCTION nodevault_reject_calendar_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'working calendar rows are append-only';
END;
$$;

CREATE TRIGGER non_working_closures_append_only
BEFORE UPDATE OR DELETE ON non_working_closures
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_calendar_mutation();

CREATE TRIGGER non_working_closure_branches_append_only
BEFORE UPDATE OR DELETE ON non_working_closure_branches
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_calendar_mutation();

CREATE TRIGGER non_working_closure_cancellations_append_only
BEFORE UPDATE OR DELETE ON non_working_closure_cancellations
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_calendar_mutation();

CREATE TRIGGER gazetted_holidays_append_only
BEFORE UPDATE OR DELETE ON gazetted_holidays
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_calendar_mutation();

CREATE TRIGGER gazetted_holiday_cancellations_append_only
BEFORE UPDATE OR DELETE ON gazetted_holiday_cancellations
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_calendar_mutation();

CREATE OR REPLACE FUNCTION nodevault_reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  book_status nodevault_book_status;
BEGIN
  -- Deletes, and the audit log, stay append-only. An open book can still
  -- be corrected in place. A closed book cannot.
  IF TG_OP = 'DELETE' OR TG_TABLE_NAME = 'audit_events' THEN
    RAISE EXCEPTION 'ledger is append-only';
  END IF;

  IF TG_TABLE_NAME = 'vault_denomination_matrix_ledger' THEN
    IF NEW.matrix_tx_id IS DISTINCT FROM OLD.matrix_tx_id
       OR NEW.book_id IS DISTINCT FROM OLD.book_id
       OR NEW.line_number IS DISTINCT FROM OLD.line_number
       OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'ledger line identity is immutable';
    END IF;
    SELECT status INTO book_status
    FROM branch_vault_books
    WHERE book_id = OLD.book_id
    FOR SHARE;
    IF book_status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'ledger is append-only';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'ledger_amount_cells' THEN
    IF NEW.cell_id IS DISTINCT FROM OLD.cell_id
       OR NEW.matrix_tx_id IS DISTINCT FROM OLD.matrix_tx_id
       OR NEW.channel_code IS DISTINCT FROM OLD.channel_code
       OR NEW.denomination_code IS DISTINCT FROM OLD.denomination_code
       OR NEW.cell_kind IS DISTINCT FROM OLD.cell_kind THEN
      RAISE EXCEPTION 'ledger cell identity is immutable';
    END IF;
    SELECT b.status INTO book_status
    FROM vault_denomination_matrix_ledger e
    JOIN branch_vault_books b ON b.book_id = e.book_id
    WHERE e.matrix_tx_id = OLD.matrix_tx_id
    FOR SHARE;
    IF book_status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'ledger is append-only';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ledger is append-only';
END;
$$;

CREATE TRIGGER vault_ledger_append_only
BEFORE UPDATE OR DELETE ON vault_denomination_matrix_ledger
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_ledger_mutation();

CREATE TRIGGER ledger_cells_append_only
BEFORE UPDATE OR DELETE ON ledger_amount_cells
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_ledger_mutation();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_ledger_mutation();

CREATE OR REPLACE FUNCTION nodevault_reject_closed_book_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  book_status nodevault_book_status;
BEGIN
  SELECT status INTO book_status
  FROM branch_vault_books
  WHERE book_id = NEW.book_id
  FOR SHARE;

  IF book_status IS NULL THEN
    RAISE EXCEPTION 'book not found';
  END IF;
  IF book_status <> 'OPEN' THEN
    RAISE EXCEPTION 'closed books reject new rows';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vault_ledger_closed_book
BEFORE INSERT ON vault_denomination_matrix_ledger
FOR EACH ROW
EXECUTE FUNCTION nodevault_reject_closed_book_insert();

CREATE OR REPLACE FUNCTION nodevault_guard_book()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vault books cannot be deleted';
  END IF;

  IF OLD.status = 'BALANCED_CLOSED' THEN
    RAISE EXCEPTION 'closed books are immutable';
  END IF;

  IF NEW.book_id IS DISTINCT FROM OLD.book_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.book_class IS DISTINCT FROM OLD.book_class
     OR NEW.business_date IS DISTINCT FROM OLD.business_date THEN
    RAISE EXCEPTION 'book identity is immutable';
  END IF;

  IF OLD.status = 'OPEN' AND NEW.status = 'OPEN' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'OPEN' AND NEW.status = 'BALANCED_CLOSED' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal book status transition';
END;
$$;

CREATE TRIGGER branch_vault_books_guard
BEFORE UPDATE OR DELETE ON branch_vault_books
FOR EACH ROW
EXECUTE FUNCTION nodevault_guard_book();

-- Horizontal arithmetic is checked at COMMIT, after every cell of the row exists.
-- Total Treasury includes only catalogue rows flagged in_grand (re-issuable A and coins C).
CREATE OR REPLACE FUNCTION nodevault_verify_entry_arithmetic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  entry_id BIGINT;
  entry_class nodevault_book_class;
  cat RECORD;
  denom_sum BIGINT;
  subtotal BIGINT;
  grand_sum BIGINT;
  subtotal_sum BIGINT;
  grand_count INT;
  actual_grand INT;
BEGIN
  entry_id := NEW.matrix_tx_id;

  SELECT b.book_class INTO entry_class
  FROM vault_denomination_matrix_ledger e
  JOIN branch_vault_books b ON b.book_id = e.book_id
  WHERE e.matrix_tx_id = entry_id;

  IF NOT EXISTS (
    SELECT 1 FROM denomination_catalogue AS catalogue
    WHERE catalogue.book_class = entry_class
  ) THEN
    RAISE EXCEPTION 'denomination catalogue is not loaded for %', entry_class;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ledger_amount_cells c
    WHERE c.matrix_tx_id = entry_id
      AND NOT EXISTS (
        SELECT 1 FROM denomination_catalogue d
        WHERE d.book_class = entry_class
          AND d.channel_code = c.channel_code
          AND d.denomination_code = c.denomination_code
          AND d.cell_kind = c.cell_kind
      )
  ) THEN
    RAISE EXCEPTION 'cell is not in the denomination catalogue';
  END IF;

  FOR cat IN
    SELECT * FROM denomination_catalogue AS catalogue WHERE catalogue.book_class = entry_class
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM ledger_amount_cells
      WHERE matrix_tx_id = entry_id
        AND channel_code = cat.channel_code
        AND denomination_code = cat.denomination_code
        AND cell_kind = cat.cell_kind
    ) THEN
      RAISE EXCEPTION 'missing catalogue cell %', cat.header_label;
    END IF;
  END LOOP;

  FOR cat IN
    SELECT * FROM denomination_catalogue AS catalogue
    WHERE catalogue.book_class = entry_class AND catalogue.cell_kind = 'SUBTOTAL'
  LOOP
    SELECT COALESCE(SUM(c.amount_minor), 0) INTO denom_sum
    FROM ledger_amount_cells c
    WHERE c.matrix_tx_id = entry_id
      AND c.channel_code = cat.channel_code
      AND c.cell_kind = 'DENOMINATION';

    SELECT amount_minor INTO subtotal
    FROM ledger_amount_cells
    WHERE matrix_tx_id = entry_id
      AND channel_code = cat.channel_code
      AND cell_kind = 'SUBTOTAL';

    IF denom_sum IS DISTINCT FROM subtotal THEN
      RAISE EXCEPTION 'subtotal mismatch for %', cat.header_label;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO grand_count
  FROM denomination_catalogue AS catalogue
  WHERE catalogue.book_class = entry_class AND catalogue.cell_kind = 'GRAND';

  SELECT COUNT(*) INTO actual_grand
  FROM ledger_amount_cells
  WHERE matrix_tx_id = entry_id AND cell_kind = 'GRAND';

  IF grand_count = 0 THEN
    IF actual_grand <> 0 THEN
      RAISE EXCEPTION 'foreign and bancs rows keep per-currency totals only';
    END IF;
  ELSE
    IF actual_grand <> 1 THEN
      RAISE EXCEPTION 'kwacha rows require a single total treasury';
    END IF;

    SELECT COALESCE(SUM(c.amount_minor), 0) INTO subtotal_sum
    FROM ledger_amount_cells c
    JOIN denomination_catalogue d
      ON d.book_class = entry_class
     AND d.channel_code = c.channel_code
     AND d.cell_kind = 'SUBTOTAL'
     AND d.in_grand
    WHERE c.matrix_tx_id = entry_id
      AND c.cell_kind = 'SUBTOTAL';

    SELECT amount_minor INTO grand_sum
    FROM ledger_amount_cells
    WHERE matrix_tx_id = entry_id AND cell_kind = 'GRAND';

    IF grand_sum IS DISTINCT FROM subtotal_sum THEN
      RAISE EXCEPTION 'total treasury must equal re-issuable plus coins';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER nodevault_entry_arithmetic_cells
AFTER INSERT ON ledger_amount_cells
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION nodevault_verify_entry_arithmetic();

CREATE CONSTRAINT TRIGGER nodevault_entry_arithmetic_row
AFTER INSERT ON vault_denomination_matrix_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION nodevault_verify_entry_arithmetic();

CREATE CONSTRAINT TRIGGER nodevault_entry_arithmetic_cell_update
AFTER UPDATE ON ledger_amount_cells
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION nodevault_verify_entry_arithmetic();

-- Least privilege for the API role. Triggers still reject mutations if a grant is widened later.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nodevault_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO nodevault_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nodevault_app;

GRANT SELECT, INSERT ON bank_tenants, branches, nodevault_users, desk_roles, system_control,
  weekly_coordinator_assignments, rotation_schedules, handover_logs, post_assignments,
  movement_options, book_narrations, surprise_checks, surprise_check_books, surprise_assignments,
  non_working_closures, non_working_closure_branches, non_working_closure_cancellations,
  gazetted_holidays, gazetted_holiday_cancellations,
  carry_forward_flags, branch_vault_books, vault_denomination_matrix_ledger,
  ledger_amount_cells, break_glass_sessions, audit_events, dispatch_outbox,
  mock_core_positions, mock_core_transactions,
  auditor_branches, audit_line_marks, audit_signoffs, vault_sheets, print_jobs
  TO nodevault_app;

GRANT UPDATE (failed_login_count, locked_until) ON nodevault_users TO nodevault_app;
GRANT UPDATE (
  full_legal_name, branch_id, system_role, employee_id, two_letter_initials,
  password_hash, closing_pin_hash, is_active, current_audit_branch_id
) ON nodevault_users TO nodevault_app;
GRANT UPDATE (display_name) ON desk_roles TO nodevault_app;
GRANT DELETE ON desk_roles TO nodevault_app;
GRANT UPDATE (period_end) ON post_assignments TO nodevault_app;
GRANT UPDATE (bank_name, logo_label, logo_file) ON bank_tenants TO nodevault_app;
GRANT UPDATE (label, flow_direction, sort_order, is_active) ON movement_options TO nodevault_app;
GRANT UPDATE (branch_code, branch_name, province, location_name, is_active, permanently_closed, printer_target) ON branches TO nodevault_app;
GRANT UPDATE (pending_final_comment_at) ON auditor_branches TO nodevault_app;
GRANT DELETE ON auditor_branches TO nodevault_app;
GRANT UPDATE (mark_status, comment, core_ref_kind, marked_by, marked_at) ON audit_line_marks TO nodevault_app;
GRANT UPDATE (printed_at, line_ids) ON vault_sheets TO nodevault_app;
GRANT UPDATE (status, attempts, last_error, sent_at, printer_target) ON print_jobs TO nodevault_app;
GRANT UPDATE (status, closed_at) ON branch_vault_books TO nodevault_app;
GRANT UPDATE (initialized_at, it_admin_frozen, entra_enabled) ON system_control TO nodevault_app;
GRANT UPDATE (status, attempts, last_error, updated_at) ON dispatch_outbox TO nodevault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_core_positions TO nodevault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_core_transactions TO nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_signoffs FROM nodevault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON denomination_catalogue TO nodevault_app;

REVOKE UPDATE, DELETE, TRUNCATE ON vault_denomination_matrix_ledger FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_amount_cells FROM nodevault_app;
GRANT UPDATE (
  accounting_label, line_reference, flow_direction,
  custodian_one_initials, custodian_two_initials, teller_coord_initials
) ON vault_denomination_matrix_ledger TO nodevault_app;
GRANT UPDATE (amount_minor) ON ledger_amount_cells TO nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM nodevault_app;
REVOKE DELETE, TRUNCATE ON branch_vault_books FROM nodevault_app;
REVOKE DELETE, TRUNCATE ON audit_events FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON handover_logs FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON book_narrations FROM nodevault_app;
GRANT UPDATE (archived_at) ON surprise_checks TO nodevault_app;
GRANT DELETE ON surprise_checks TO nodevault_app;
GRANT DELETE ON surprise_check_books TO nodevault_app;
GRANT UPDATE (assignee_user_id, assigned_by_user_id, created_at) ON surprise_assignments TO nodevault_app;
GRANT DELETE ON surprise_assignments TO nodevault_app;
REVOKE TRUNCATE ON surprise_checks FROM nodevault_app;
REVOKE UPDATE, TRUNCATE ON surprise_check_books FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON non_working_closures FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON non_working_closure_branches FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON non_working_closure_cancellations FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON gazetted_holidays FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON gazetted_holiday_cancellations FROM nodevault_app;
