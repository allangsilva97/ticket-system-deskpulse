"""The Alembic migrations must build the same schema the models describe."""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _alembic(db_url, *args):
    env = {**os.environ, "DATABASE_URL": db_url}
    return subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env,
                          capture_output=True, text=True)


def test_migrations_match_the_models(tmp_path):
    url = f"sqlite:///{tmp_path / 'migrated.db'}"
    up = _alembic(url, "upgrade", "head")
    assert up.returncode == 0, up.stderr

    # `check` fails if a model changed without a new migration (run `alembic revision --autogenerate`).
    check = _alembic(url, "check")
    assert check.returncode == 0, check.stdout + check.stderr

    down = _alembic(url, "downgrade", "base")
    assert down.returncode == 0, down.stderr
