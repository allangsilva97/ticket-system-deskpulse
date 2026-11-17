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
  - **Admins** manage users and can delete companies/tickets.
  - **Agents** work tickets.
  - Deactivating a user or resetting their password signs them out everywhere.
- **Tickets**: status (open, in progress, waiting, closed), priority, company, assignee, requester name/email.
- **Due dates**: set from priority (urgent 4h, high 24h, medium 72h, low 7d) and recalculated when priority changes. Overdue tickets are flagged and can be filtered.
- **Comments**: public replies and agent-only **internal notes**.
- **Activity history**: every change to status, priority, assignee, company and title records who changed it and when.
- **List view**:
  - search (title, description, requester, `#id`) and filters (status, priority, company, assignee, overdue)
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
| `SLA_URGENT_HOURS` / `SLA_HIGH_HOURS` / `SLA_MEDIUM_HOURS` / `SLA_LOW_HOURS` | `4` / `24` / `72` / `168` | Due-date targets |
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

## DeskPulse prototype (`deskpulse/`)

A separate single-file front-end demo (IT help desk + asset inventory, in Brazilian Portuguese). It has **no server**: the sign-in is simulated in the browser and the data sits in `localStorage`, so it is for demos only. Never put real data in it or rely on its permissions as security. Open the file directly or run `python -m http.server 5180 --bind 127.0.0.1 --directory deskpulse`.

**Future idea:** this Ticket System backend (real sign-in, database, server-side SLA) is what DeskPulse lacks to leave demo mode. If you want that, adapt this code as DeskPulse's backend.

## Layout

```
app/
  main.py        app setup, security headers, static files
  config.py      settings
  database.py    engine, session, UTC datetime type
  models.py      User, AuthToken, Company, Ticket, Comment, TicketEvent
  schemas.py     request/response models
  security.py    password hashing, tokens, auth dependencies
  services.py    ticket rules (due dates, closing, audit trail)
  routers/       auth, users, companies, tickets, stats
  static/        index.html, style.css, app.js
tests/           pytest suite
```

## Notes

- The schema changed from v1, so delete an old `tickets.db` before the first run. Tables are created at startup with `create_all`. Before running this in production, add **Alembic** migrations so future schema changes don't need a fresh database.
- Sessions are stored in `localStorage` and the API uses `Authorization: Bearer`. Serve it over **HTTPS** anywhere other than your own machine (HSTS is sent automatically on HTTPS requests).
