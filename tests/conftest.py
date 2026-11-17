import os
import tempfile

# Must be set before the app is imported.
os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
os.environ["PASSWORD_HASH_ITERATIONS"] = "1000"  # fast hashing for tests
os.environ["AUTO_MIGRATE"] = "0"  # the fixtures build the tables straight from the models

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import models  # noqa: E402, F401
from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.ratelimit import login_limiter  # noqa: E402

ADMIN = {"name": "Ada Admin", "email": "ada@example.com", "password": "admin-pass-123"}


@pytest.fixture
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    login_limiter.reset()  # failed-login counts live in memory; start every test clean
    with TestClient(app) as c:
        yield c


@pytest.fixture
def admin(client):
    """The client, signed in as the first admin."""
    r = client.post("/api/auth/setup", json=ADMIN)
    assert r.status_code == 201, r.text
    client.headers["Authorization"] = f"Bearer {r.json()['token']}"
    return client


def _make_account(admin, role, name, email, password, company_id=None):
    body = {"name": name, "email": email, "password": password, "role": role, "company_id": company_id}
    user = admin.post("/api/users", json=body).json()
    token = admin.post("/api/auth/login", json={"email": email, "password": password}).json()["token"]
    return user, {"Authorization": f"Bearer {token}"}


@pytest.fixture
def make_tech(admin):
    """Create a technician and return (user, headers)."""
    def _make(name="Alex Tech", email="alex@example.com", password="tech-pass-123"):
        return _make_account(admin, "technician", name, email, password)
    return _make


@pytest.fixture
def company(admin):
    return admin.post("/api/companies", json={"name": "Acme"}).json()


@pytest.fixture
def make_user(admin, company):
    """Create an end user at the Acme company and return (user, headers)."""
    def _make(name="Sarah User", email="sarah@example.com", password="user-pass-123"):
        return _make_account(admin, "user", name, email, password, company["id"])
    return _make
