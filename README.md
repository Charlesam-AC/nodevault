# NodeVault

Paperless treasury and vault balance engine for commercial banks. One deployment can be white-labelled per bank. Each branch keeps exactly three books: the Kwacha Treasury Book, the Foreign Currency Treasury Book, and the Bancs Treasury Book.

Charles Amulike, NodeLink Systems Limited. Specification v1.0.4. Column layouts follow the photographed paper books (v1.0.9 was the starting draft, not the finished behaviour).

## Books

| Book | Layout |
| --- | --- |
| Kwacha Treasury Book | Re-issuable notes K500–K10, Total Re-Issuable, non-re-issuable notes, coins K5–5n, Total Coins, Grand Total |
| Foreign Currency Treasury Book | EURO NOTES, GBP NOTES, USD NOTES, ZAR NOTES, each with its own total |
| Bancs Treasury Book | Same foreign-notes layout, separate book and balances |

Foreign Currency and Bancs are built by one layout function (`foreignLayout` in `backend/services/layout.js`). Kwacha has its own. The row number is repeated on the right edge of the spread. `In or Out` is the flow. One Initials column shows custodian 1, custodian 2, and the coordinator; those three are stored separately.

Grand Total = Total Re-Issuable + Total Coins. There is no Old Currency Notes column. Non-re-issuable notes (the second notes group on the Kwacha photograph: K100, K50, K20, K10, K5, K2) are stored and shown, and they are not added into the Grand Total. Foreign currencies are never summed into one figure.

Money is integer minor units (1/100) from the page through PostgreSQL `BIGINT`. Core-bank amounts are decimal strings. Nothing in the close path uses floating point.

## Run locally

```bash
cp .env.example .env
# Replace the placeholder secrets before any real bank uses this.
docker compose up --build
```

The API and the desk are at [http://127.0.0.1:8080](http://127.0.0.1:8080). Postgres is published on port 54329 for the test suite. `docker compose up` is healthy when both `nodevault-api` and `nodevault-db` report healthy.

A volume created before directory passwords existed does not have `password_hash`. Recreate it with `docker compose down -v && docker compose up --build`.

Demo sign-in (only when `SEED_DEMO_DATA=true`):

Password sign-in is on in the sample `.env` (`ENABLE_LOCAL_LOGIN=true` and `AUTH_MODE=both`). Every seeded account uses the same directory password, `Vault-demo-2026` (`DEMO_PASSWORD`). That password is not the closing PIN.

| Role | Email |
| --- | --- |
| Vault custodian | `charles.amulike@demo-bank.example` |
| Vault custodian | `custodian.two@demo-bank.example` |
| Head teller coordinator | `coordinator.mk@demo-bank.example` |
| Branch teller | `teller.desk@demo-bank.example` |
| Auditor | `auditor.desk@demo-bank.example` |
| IT super admin | `it.admin@demo-bank.example` |
| Regional operations manager | `rom@demo-bank.example` |

The IT super admin is frozen after setup. Password sign-in and Entra sign-in both refuse that account until both vault custodians open a break-glass window. Break-glass still uses the Entra assertion.

Entra mock sign-in (when `ENTRA_MODE=mock`):

- Assertion: the value of `MOCK_ENTRA_ASSERTION` (`change-me-entra-assertion` in the sample file)
- Closing PIN: the value of `DEMO_CLOSING_PIN` (`135790` in the sample file)

Turn password sign-in off for a live Entra deployment by setting both of these, then restarting the API:

```bash
AUTH_MODE=entra
ENABLE_LOCAL_LOGIN=false
```

Either one is enough to refuse `POST /api/auth/login/password`. The desk hides the password form when the flag is off.

The seeded business date is 3 October 2026. The three books for Main Branch are already on the desk.

Tests, from the host, against the published database:

```bash
cd backend
npm install
npm test
```

## Configuration

Copy `.env.example`. Do not commit `.env`.

| Variable | Purpose |
| --- | --- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Superuser used only to initialise the cluster |
| `APP_DB_PASSWORD` | Password for `nodevault_app`, the role the API uses |
| `JWT_SECRET` | Desk session signing key (32+ characters) |
| `ENFORCED_CORPORATE_DOMAIN` | Sign-in emails must use this domain. Empty allows each tenant's own domain |
| `ENTRA_MODE` | `mock` for local. `entra` refuses sessions rather than trusting unsigned tokens |
| `AUTH_MODE` | `both` (demo), `local`, or `entra`. `entra` refuses password sign-in |
| `ENABLE_LOCAL_LOGIN` | `true` shows the email and password form. `false` refuses it |
| `DEMO_PASSWORD` | Shared demo directory password, hashed into `password_hash`. Not the closing PIN |
| `LOCAL_LOGIN_MAX_FAILURES` / `LOCAL_LOGIN_LOCKOUT_MINUTES` | Lock an account after repeated wrong passwords |
| `MOCK_ENTRA_ASSERTION` | Shared local stand-in for an Entra sign-in |
| `CORE_BANK_MODE` | `mock` reads `mock_core_positions`. `http` GETs `${CORE_BANK_API_URL}/v1/position/:branchId` |
| `CORE_BANK_API_URL` | Core banking base URL. Amounts must be decimal strings, not JSON numbers |
| `PRINTER_MODE` / `PRINTER_TARGET` / `PRINTER_URL` | `stub` logs the job. `network` POSTs the raw sheet |
| `MAIL_MODE` / `SMTP_*` / `ROM_EMAIL` | `stub` logs the closing email. `smtp` sends it |
| `SEED_DEMO_DATA` / `DEMO_CLOSING_PIN` | Load the sample branch. The PIN is dev-only |

`DB_HOST` inside Compose is `nodevault-db`, the service name.

## Security model

- Microsoft Entra ID remains the corporate login. This build ships a mock verifier and a live mode that fails closed. Password sign-in is a second door, hashed in `password_hash`, and it is off unless `ENABLE_LOCAL_LOGIN=true` and `AUTH_MODE` is not `entra`.
- A deactivated user (`is_active = false`) is rejected on the next request. Repeated wrong passwords lock that account (`failed_login_count`, `locked_until`).
- The enforced corporate domain is checked against the tenant domain for both sign-in methods.
- Closing PINs live in `closing_pin_hash`. Directory passwords live in `password_hash`. The two hashes are produced separately and the demo values are different secrets.
- Nightly close needs two distinct active `VAULT_CUSTODIAN` users and the `HEAD_TELLER_COORDINATOR` assigned for that ISO week, all in the same tenant. The certified total must match the book and the core position exactly, per currency.
- The book row is locked, the closure is audited, and the print/email intent is written in the same transaction. The printer and the mailer run only after `COMMIT`. If either fails, the book stays `BALANCED_CLOSED` and the outbox records a retry.
- Ledger lines, amount cells, and audit events are append-only (triggers, plus no update/delete/truncate for the API role). Closed books reject new lines. Books cannot be deleted. `ON DELETE RESTRICT` keeps history attached.
- After initialisation the IT super admin cannot sign in alone. Break-glass requires both active vault custodians at once and expires after 60 minutes. The session is audited.
- The API does not connect as the database superuser.

## What was interpreted

- The PDF table image omitted middle denomination columns. The sample still totals K1,656,515.00, R25,000.00, and $8,000.00. Unpublished Kwacha cells that make those totals true are listed in `backend/fixtures/sampleLedger.js`.
- `Bal b/d` in the sample is a cash-in movement. `Bal b/f` and `Bal c/d` are position rows.
- The second Kwacha notes group is the photographed non-re-issuable series. It is not part of Grand Total, and Old Currency Notes (B) is omitted.
- USD 2 is a real column on the foreign book. EUR and GBP columns are zero in the specification sample and carry their own figures on the Bancs sample.
- Silent printing is a server-side dispatch after commit (`PRINTER_MODE=stub` or `network`). It does not run inside the browser.
- Bancs has no separate photographed sheet, so it reuses the foreign-notes layout on its own book.
- A branch holds one book of each of the three classes per business date.

## Layout

```
docker-compose.yml
.env.example
database/init.sql
backend/package.json
backend/server.js
backend/middleware/auth.js
backend/services/ledger.js
backend/services/print.js
backend/public/          ledger desk, including the font-scaling rule
```
