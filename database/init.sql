-- NodeVault schema
-- Author: Charles Amulike, NodeLink Systems Limited
-- Money is stored as BIGINT minor units (1/100 of the major unit). No float columns.
-- Ledger rows, amount cells, and audit events are append-only.

CREATE TYPE nodevault_user_role AS ENUM (
  'VAULT_CUSTODIAN',
  'ATM_CUSTODIAN',
  'TELLER',
  'HEAD_TELLER_COORDINATOR',
  'AUDITOR',
  'IT_SUPER_ADMIN',
  'REGIONAL_OPS_MANAGER'
);

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  branch_id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_code VARCHAR(20) NOT NULL,
  branch_name VARCHAR(120) NOT NULL,
  UNIQUE (tenant_id, branch_code),
  UNIQUE (tenant_id, branch_id)
);

CREATE TABLE nodevault_users (
  user_id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES bank_tenants (tenant_id),
  branch_id INT,
  work_email VARCHAR(160) NOT NULL UNIQUE,
  full_legal_name VARCHAR(120) NOT NULL,
  employee_id VARCHAR(32) NOT NULL,
  two_letter_initials VARCHAR(8) NOT NULL,
  system_role nodevault_user_role NOT NULL,
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
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, branch_id)
);

CREATE TABLE system_control (
  tenant_id INT PRIMARY KEY REFERENCES bank_tenants (tenant_id),
  initialized_at TIMESTAMPTZ,
  it_admin_frozen BOOLEAN NOT NULL DEFAULT false
);

-- The weekly head-teller coordinator is an assignment, not "any teller".
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

-- Column catalogue for each paper book. Values are not stored here.
-- Kwacha Total Treasury is re-issuable (A) plus coins (C). There is no Old Currency column B.
-- Non-re-issuable note denominations are listed, and in_grand is false for them.
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

CREATE OR REPLACE FUNCTION nodevault_reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
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

-- Least privilege for the API role. Triggers still reject mutations if a grant is widened later.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nodevault_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO nodevault_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nodevault_app;

GRANT SELECT, INSERT ON bank_tenants, branches, nodevault_users, system_control,
  weekly_coordinator_assignments, rotation_schedules, handover_logs, post_assignments,
  carry_forward_flags, branch_vault_books, vault_denomination_matrix_ledger,
  ledger_amount_cells, break_glass_sessions, audit_events, dispatch_outbox,
  mock_core_positions TO nodevault_app;

GRANT UPDATE (failed_login_count, locked_until) ON nodevault_users TO nodevault_app;
GRANT UPDATE (status, closed_at) ON branch_vault_books TO nodevault_app;
GRANT UPDATE (initialized_at, it_admin_frozen) ON system_control TO nodevault_app;
GRANT UPDATE (status, attempts, last_error, updated_at) ON dispatch_outbox TO nodevault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_core_positions TO nodevault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON denomination_catalogue TO nodevault_app;

REVOKE UPDATE, DELETE, TRUNCATE ON vault_denomination_matrix_ledger FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_amount_cells FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM nodevault_app;
REVOKE DELETE, TRUNCATE ON branch_vault_books FROM nodevault_app;
REVOKE DELETE, TRUNCATE ON audit_events FROM nodevault_app;
REVOKE UPDATE, DELETE, TRUNCATE ON handover_logs FROM nodevault_app;
