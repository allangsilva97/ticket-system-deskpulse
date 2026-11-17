# 🎫 Ticket System

A small help-desk app: FastAPI + SQLAlchemy backend, plain HTML/CSS/JS frontend, SQLite by default.

## Run it

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000. The first visit asks you to create the **admin** account.
API docs: http://127.0.0.1:8000/docs

Run the tests:

```bash
pytest
```

## Features

- **Sign-in & roles**: first-run admin setup, bearer-token sessions (7 days), PBKDF2 password hashing.
  - **Admins** manage users and can delete companies, tickets and assets.
  - **Technicians** work tickets, manage companies and the asset inventory.
  - **End users** open tickets and follow their own. They never see other people's tickets, internal notes, the inventory, companies or stats. This is enforced by the API, not the screen.
  - Deactivating a user or resetting their password signs them out everywhere.
  - Optional **two-factor sign-in** (TOTP: Google Authenticator, Authy...): `POST /api/auth/2fa/setup`, `/2fa/enable`, `/2fa/disable`. With it on, `/login` answers 401 with `X-2FA-Required: true` until the request carries `otp`.
- **Tickets**: shown as `TK-<id>`. Fields: status (open, in progress, waiting, resolved, closed), category (hardware, software, network, access & security, other), priority, company, requester, assignee and an optional asset.
  - Whoever opens a ticket does **not** choose its priority. Technicians set it when they triage, so a new ticket has no priority and no due date yet (the dashboard counts these as "Not triaged"). End users send only title, description, category and asset; the company and requester come from their account (`company_id` on the user).
- **Assets (inventory)**: `AST-<id>` with type, serial (unique), status (in use, stock, maintenance, retired), assigned user and location. End users can link a ticket only to equipment assigned to them (`GET /api/assets/mine`).
- **Due dates**: set from priority (critical 4h, high 24h, medium 72h, low 7d) once a technician sets it, and recalculated when it changes. Overdue tickets are flagged and can be filtered. Resolved and closed tickets are never overdue.
- **Comments**: public replies and technician-only **internal notes**.
- **Activity history**: every change to status, priority, category, assignee, requester, company, asset and title records who changed it and when.
- **List view**:
  - search (title, description, requester, `TK-id`) and filters (status, priority or `none`, category, company, asset, assignee, overdue)
  - sortable columns and pagination
  - bulk updates
  - **CSV export** (protected against formulas running in Excel)
- **Dashboard**: counts by status, overdue, unassigned and "assigned to me", plus active tickets by priority, average time to close, and recent activity. Cards are clickable filters.
- **UI**:
  - ticket detail drawer with inline editing
  - deep links (`#tickets/12`)
  - dark mode, phone layout, keyboard shortcuts (Esc closes; Ctrl/⌘+Enter sends a comment)

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./tickets.db` | Any SQLAlchemy URL (e.g. PostgreSQL) |
| `TOKEN_TTL_HOURS` | `168` | How long a sign-in lasts |
| `PASSWORD_HASH_ITERATIONS` | `600000` | PBKDF2 work factor |
| `SLA_CRITICAL_HOURS` / `SLA_HIGH_HOURS` / `SLA_MEDIUM_HOURS` / `SLA_LOW_HOURS` | `4` / `24` / `72` / `168` | Due-date targets |
| `SETUP_TOKEN` | *(empty)* | If set, creating the first admin needs this code. **Set it on any server others can reach.** |
| `LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_SECONDS` | `5` / `900` | Failed sign-ins allowed per account (and 4× that per IP) before a 15-minute lockout |
| `ENABLE_DOCS` | `1` | Set to `0` to hide `/docs`, `/redoc` and `/openapi.json` on a public server |

## Security

- **Run it on `127.0.0.1`** (the default). Don't start it with `--host 0.0.0.0` unless it sits behind a reverse proxy with HTTPS. With a proxy, add `--proxy-headers` so the throttle sees the real client IP.
- **First run on a shared server:** set `SETUP_TOKEN` before the first start, or anyone who reaches the page first becomes admin.
- Passwords are hashed with salted PBKDF2-SHA256; sessions store only a SHA-256 of the token; failed sign-ins are throttled; every response carries a strict Content-Security-Policy, `nosniff`, `X-Frame-Options: DENY`, and `no-store` on `/api/*`.
- The sign-in token lives in `localStorage`, so an XSS bug would expose it. All user text is escaped and the CSP blocks inline scripts, but if you take this beyond a team tool, move the session to an `HttpOnly` cookie.
- The throttle is in memory (per process). With several workers or servers, back it with a shared store such as Redis.
- Keep dependencies current: `pip install pip-audit && pip-audit -r requirements.txt`.
- `tickets.db` holds real data. It is git-ignored, so keep it out of commits and back it up separately.

## DeskPulse (`deskpulse/`)

The web front-end (IT help desk + asset inventory, in Brazilian Portuguese). It is served by this same server, so there is nothing else to run:

```bash
uvicorn app.main:app --reload       # then open http://127.0.0.1:8000
```

- `/` is DeskPulse. The first visit asks you to create the administrator; after that everyone signs in with the account an administrator created for them.
- `/console` is the original administrator console (tickets, companies, users), kept alongside it. `/docs` is the API reference.
- DeskPulse talks to the API (`/api/...`) with a bearer token. Roles, ticket visibility, SLA and 2FA are all decided by the server; the screens only reflect them.
- The scripts live in `deskpulse/` (`app.js`, `theme.js`, `tailwind-config.js`) because the page's security policy forbids inline scripts. Tailwind and the icons still come from their CDNs.
- Not built yet: sign-in-free ticket tracking, e-mail (password recovery, notifications) and attachments. Until e-mail exists, an administrator sets a new password for someone who forgot theirs.

## Layout

```
app/
  main.py        app setup, security headers, static files
  config.py      settings
  database.py    engine, session, UTC datetime type
  models.py      User, AuthToken, Company, Asset, Ticket, Comment, TicketEvent
  schemas.py     request/response models
  security.py    password hashing, tokens, auth dependencies (CurrentUser, StaffUser, AdminUser)
  totp.py        two-factor codes (RFC 6238)
  services.py    ticket rules (who may set what, due dates, resolving, audit trail)
  routers/       auth (incl. 2FA), users, companies, assets, tickets, stats
  static/        the admin console (index.html, style.css, app.js)
deskpulse/       the DeskPulse front-end (index.html, app.js, theme.js, tailwind-config.js)
alembic/         database migrations
tests/           pytest suite
```

## Notes

- **Database migrations (Alembic).** The app runs `alembic upgrade head` at startup (set `AUTO_MIGRATE=0` to run it yourself as a deploy step). After changing `app/models.py`:
  1. `alembic revision --autogenerate -m "what changed"`
  2. Read the new file in `alembic/versions/`. Autogenerate can miss renames, and a new NOT NULL column on a table with rows needs a default.
  3. `alembic upgrade head`. The test suite fails if a model changed without a migration.

  Other commands: `alembic current`, `alembic history`, `alembic downgrade -1`. A database created before Alembic (by `create_all`) has no `alembic_version` table: back it up and delete it, or run `alembic stamp 0001` only if its schema is exactly the one in `0001_initial_schema.py`.
- Sessions are stored in `localStorage` and the API uses `Authorization: Bearer`. Serve it over **HTTPS** anywhere other than your own machine (HSTS is sent automatically on HTTPS requests).
