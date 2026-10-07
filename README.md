# NodeVault

Paperless treasury and vault balance engine for commercial banks. One deployment can be white-labelled per bank. Each branch keeps exactly three books: the Kwacha Treasury Book, the Foreign Currency Treasury Book, and the Bancs Treasury Book.

Charles Amulike. Specification v1.0.4. Column layouts follow the photographed paper books (v1.0.9 was the starting draft, not the finished behaviour).

## Books

| Book | Layout |
| --- | --- |
| Kwacha Treasury Book | Re-issuable notes K500–K10, Total Re-Issuable, non-re-issuable notes, coins K5–5n, Total Coins, Grand Total |
| Foreign Currency Treasury Book | EURO NOTES, GBP NOTES, USD NOTES, ZAR NOTES, each with its own total |
| Bancs Treasury Book | Same foreign-notes layout, separate book and balances |

Foreign Currency and Bancs are built by one layout function (`foreignLayout` in `backend/services/layout.js`). Kwacha has its own. The row number is repeated on the right edge of the spread. `In or Out` is the flow. One Initials column shows custodian 1, custodian 2, and the coordinator; those three are stored separately.

Grand Total = Total Re-Issuable + Total Coins. There is no Old Currency Notes column. Non-re-issuable notes (the second notes group on the Kwacha photograph: K100, K50, K20, K10, K5, K2) are stored and shown, and they are not added into the Grand Total. Foreign currencies are never summed into one figure.

## Business morning and carry-forward

At `BUSINESS_DAY_START` in `BUSINESS_TIMEZONE` (default 08:00 Africa/Lusaka) the desk opens that trading date. Trading days default to Monday through Saturday (`TRADING_WEEKDAYS`). Sundays, Zambian public holidays, dates listed in `BANK_HOLIDAYS`, and bank closures are skipped. For each of the three books, that morning copies the previous trading day's locked Bal c/d into a new book's first line, labelled Bal b/f, denomination by denomination. Friday rolls to Saturday. A holiday or closure in between is stepped over. The copy runs only after the prior book is `BALANCED_CLOSED`. An open or missing prior book is flagged (`carry_forward_flags` and a `CARRY_FORWARD_BLOCKED` audit) and is not posted. Running the job again does not add a second line.

## Non-working days

The regional operations manager sets closures. The IT super admin stays frozen after setup and cannot do this, including during break-glass. A closure has a start and end date, a reason, the person who set it, and the time it was set. Scope is the whole bank, one province, one location, or selected branches. Main Branch is Lusaka; Kitwe Branch is Copperbelt, so a province closure can be tried against either.

A closure has to start on a future date. It is refused when any covered branch already has a book that day, open or closed. Cancellation is allowed only before the start date. The original row stays. A cancellation row and a `CLOSURE_CANCELLED` audit event are appended. Nothing in this calendar is deleted.

Public holidays come from the Public Holidays Act, Cap. 272, plus the annual days declared under section 3. When a holiday falls on a Sunday, the following Monday is closed (section 2(2)). A Saturday holiday stays on Saturday. Kenneth Kaunda Day is 28 April (Statutory Instrument No. 72 of 2021), not the last Monday of April. The 2026 bill that would have dropped the Monday observance was not enacted. The regional operations manager can also record a one-off gazetted holiday for the whole bank. `BANK_HOLIDAYS` still adds extra dates on top.

The desk lists the next four months of holidays and the closures that apply to the branch.

Bal c/d itself is still the certified last line the three-person close checks. It is not rewritten during the day. The automatic roll is the next morning's Bal b/f.

## Rotation and handover

Head teller coordinators and the two vault-custodian seats each have a schedule: weekly, fortnightly, monthly, or a custom number of days. The demo coordinator rotates weekly from 28 September 2026. The two custodian seats rotate every two weeks from the same anchor. The closing interlock accepts only the people assigned to those seats on the operating date.

The opening roster is seeded and does not need a prior handover. The next period stays unassigned until outgoing and incoming holders acknowledge it with their closing PINs. The form records who is taking over, employee ID, initials, and the effective date. The handover log and a `HANDOVER_CAPTURED` audit row store the three books' locked Bal c/d balances. Once a business morning falls inside a period with no assignment, the ledger stays hidden until that handover is captured. A handover can be acknowledged before that morning.

Saturday 3 October 2026 is a trading day. The photographed sample is locked on that date and is the Bal c/d Monday 5 October brings forward. Friday 2 October 2026 is also locked, which is what a Saturday morning would roll forward. The Saturday book is the sample itself, so the morning job does not insert a second Bal b/f on top of it. The desk shows that Saturday book while Saturday is the business morning.

Relief holders in the demo directory, same password and closing PIN as the other demo accounts:

| Role | Email |
| --- | --- |
| Vault custodian | `custodian.relief@demo-bank.example` |
| Vault custodian | `custodian.relief.two@demo-bank.example` |
| Head teller coordinator | `coordinator.relief@demo-bank.example` |

Money is integer minor units (1/100) from the page through PostgreSQL `BIGINT`. Core-bank amounts are decimal strings. Nothing in the close path uses floating point.

## Run locally

```bash
cp .env.example .env
# Replace the placeholder secrets before any real bank uses this.
docker compose up --build
```

The API and the desk are at [http://127.0.0.1:8080](http://127.0.0.1:8080). Postgres is published on port 54329 for the test suite. `docker compose up` is healthy when both `nodevault-api` and `nodevault-db` report healthy.

A volume created before directory passwords existed does not have `password_hash`. A volume created before non-working days does not have the closure tables. Recreate it with `docker compose down -v && docker compose up --build`, or apply `database/03-working-calendar.sql` on the existing database.

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

Master admin (created on startup when `SEED_DEMO_DATA=true`):

| | |
| --- | --- |
| Email | `admin@demo-bank.example` (`MASTER_ADMIN_EMAIL`) |
| Password | `NodeVault-admin-2026` (`MASTER_ADMIN_PASSWORD`) |
| Role | IT super admin |

This password is not the shared demo password and not the closing PIN. It opens a normal desk session, including the Entra switch. `it.admin@demo-bank.example` stays frozen.

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
| `BUSINESS_TIMEZONE` / `BUSINESS_DAY_START` | When the next business morning begins. Default Africa/Lusaka 08:00 |
| `TRADING_WEEKDAYS` | Days the desk opens. Default `Mon,Tue,Wed,Thu,Fri,Sat`. Sunday is closed unless named here |
| `BANK_HOLIDAYS` | Extra comma-separated dates, added on top of the Zambian public-holiday calendar |
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
- Nightly close needs two distinct active `VAULT_CUSTODIAN` users and the `HEAD_TELLER_COORDINATOR` assigned on the rotation calendar for that operating date, all in the same tenant. The certified total must match the book and the core position exactly, per currency.
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
- Carry-forward treats Saturday as a trading day. Sunday, any weekday omitted from `TRADING_WEEKDAYS`, the Zambian public-holiday calendar, `BANK_HOLIDAYS`, and closures for that branch are skipped. The seeded 3 October 2026 sample is Saturday's locked Bal c/d and the source of Monday 5 October's Bal b/f. Friday's locked Bal c/d is the source of Saturday's Bal b/f. Monday 5 October 2026 is not a public holiday.
- Kenneth Kaunda Day is 28 April. Heroes Day stays the first Monday in July and Unity Day the Tuesday after it, unless a later gazette moves them. A moved day is entered as a gazetted holiday; this build does not delete the statutory Monday on its own.
- Zambia does not observe Boxing Day. Easter Monday is included because the annual gazette lists it; the Schedule consolidated to 1996 stops at Holy Saturday.
- Incoming holders must already be active directory users of the right role. The handover checks the employee ID and initials the desk submits against that directory row.
- Custodian seats in the demo are fortnightly, so they do not change on the same Monday as the weekly coordinator. The desk blocks only the posts whose new period has started without an assignment.
- The first seeded period is the opening roster. Later periods are created by handover, not by editing old ledger lines.

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
