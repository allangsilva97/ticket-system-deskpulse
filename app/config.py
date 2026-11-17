"""Settings, all overridable with environment variables."""
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{PROJECT_DIR / 'tickets.db'}")

# Run pending database migrations when the app starts. Turn off if you migrate as a separate deploy step.
AUTO_MIGRATE = os.getenv("AUTO_MIGRATE", "1").strip().lower() not in ("0", "false", "no", "off")

# How long a sign-in lasts.
TOKEN_TTL_HOURS = int(os.getenv("TOKEN_TTL_HOURS", "168"))  # 7 days

# PBKDF2 work factor (OWASP 2023 recommends 600k for PBKDF2-SHA256). Tests lower it for speed.
PASSWORD_HASH_ITERATIONS = int(os.getenv("PASSWORD_HASH_ITERATIONS", "600000"))

# Sign-in throttle: after this many failed attempts inside the window, further attempts get a 429.
LOGIN_MAX_FAILURES = int(os.getenv("LOGIN_MAX_FAILURES", "5"))
LOGIN_WINDOW_SECONDS = int(os.getenv("LOGIN_WINDOW_SECONDS", "900"))  # 15 minutes

# While no user exists, anyone who can reach the server can create the first admin.
# Set a code here on any server other people can reach; setup then needs it (X-Setup-Token header).
SETUP_TOKEN = os.getenv("SETUP_TOKEN", "")

# Interactive API docs at /docs and /redoc. Turn off on a public server.
ENABLE_DOCS = os.getenv("ENABLE_DOCS", "1").strip().lower() not in ("0", "false", "no", "off")

# Time to resolve, per priority, used to compute a ticket's due date.
# Only technicians set a priority, so a ticket has no due date until one does.
SLA_HOURS = {
    "critical": int(os.getenv("SLA_CRITICAL_HOURS", "4")),
    "high": int(os.getenv("SLA_HIGH_HOURS", "24")),
    "medium": int(os.getenv("SLA_MEDIUM_HOURS", "72")),
    "low": int(os.getenv("SLA_LOW_HOURS", "168")),
}

# Shown in the authenticator app when a user turns on two-factor sign-in.
TOTP_ISSUER = os.getenv("TOTP_ISSUER", "DeskPulse")
