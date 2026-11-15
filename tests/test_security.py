"""Brute-force limits, the setup code, and response headers."""
from app import config

from conftest import ADMIN


def _login(client, password, email=ADMIN["email"]):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_login_locks_out_after_repeated_failures(admin, monkeypatch):
    monkeypatch.setattr(config, "LOGIN_MAX_FAILURES", 3)
    for _ in range(3):
        assert _login(admin, "wrong-password").status_code == 401

    blocked = _login(admin, "wrong-password")
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) > 0

    # Even the right password is refused while locked out, so guesses can't be confirmed.
    assert _login(admin, ADMIN["password"]).status_code == 429


def test_successful_login_resets_the_counter(admin, monkeypatch):
    monkeypatch.setattr(config, "LOGIN_MAX_FAILURES", 3)
    for _ in range(2):
        assert _login(admin, "wrong-password").status_code == 401
    assert _login(admin, ADMIN["password"]).status_code == 200
    for _ in range(2):  # would be the 3rd and 4th failure if the counter hadn't reset
        assert _login(admin, "wrong-password").status_code == 401


def test_lockout_is_per_account(admin, monkeypatch):
    monkeypatch.setattr(config, "LOGIN_MAX_FAILURES", 2)
    for _ in range(2):
        _login(admin, "wrong-password", email="nobody@example.com")
    assert _login(admin, "wrong-password", email="nobody@example.com").status_code == 429
    assert _login(admin, ADMIN["password"]).status_code == 200  # a different account is unaffected


def test_setup_needs_the_code_when_one_is_configured(client, monkeypatch):
    monkeypatch.setattr(config, "SETUP_TOKEN", "let-me-in")
    assert client.get("/api/auth/setup-status").json() == {"needs_setup": True, "setup_token_required": True}

    assert client.post("/api/auth/setup", json=ADMIN).status_code == 403
    bad = client.post("/api/auth/setup", json=ADMIN, headers={"X-Setup-Token": "guess"})
    assert bad.status_code == 403
    assert client.get("/api/auth/setup-status").json()["needs_setup"] is True  # nothing was created

    ok = client.post("/api/auth/setup", json=ADMIN, headers={"X-Setup-Token": "let-me-in"})
    assert ok.status_code == 201


def test_setup_code_guesses_are_limited(client, monkeypatch):
    monkeypatch.setattr(config, "SETUP_TOKEN", "let-me-in")
    monkeypatch.setattr(config, "LOGIN_MAX_FAILURES", 2)
    for _ in range(2):
        assert client.post("/api/auth/setup", json=ADMIN, headers={"X-Setup-Token": "x"}).status_code == 403
    right = client.post("/api/auth/setup", json=ADMIN, headers={"X-Setup-Token": "let-me-in"})
    assert right.status_code == 429


def test_setup_works_without_a_code_when_none_is_configured(client):
    assert client.get("/api/auth/setup-status").json()["setup_token_required"] is False
    assert client.post("/api/auth/setup", json=ADMIN).status_code == 201


def test_security_headers(client):
    page = client.get("/")
    csp = page.headers["Content-Security-Policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp and "object-src 'none'" in csp
    assert page.headers["X-Content-Type-Options"] == "nosniff"
    assert page.headers["X-Frame-Options"] == "DENY"
    assert "Strict-Transport-Security" not in page.headers  # plain http


def test_api_responses_are_not_cached(client):
    assert client.get("/api/health").headers["Cache-Control"] == "no-store"


def test_https_gets_hsts(client):
    r = client.get("https://testserver/api/health")
    assert "max-age=" in r.headers["Strict-Transport-Security"]


def test_docs_page_keeps_working_without_the_strict_policy(client):
    r = client.get("/docs")
    assert r.status_code == 200
    assert "Content-Security-Policy" not in r.headers


def test_huge_ids_are_rejected_not_a_server_error(admin):
    big = "99999999999999999999"  # valid int, but too large for a database integer
    for method, url, body in (
        ("get", f"/api/tickets/{big}", None),
        ("get", f"/api/companies/{big}", None),
        ("get", f"/api/tickets?company_id={big}", None),
        ("get", f"/api/tickets?assignee={big}", None),
        ("patch", f"/api/users/{big}", {"name": "x"}),
        ("post", "/api/tickets/bulk", {"ids": [int(big)], "status": "closed"}),
    ):
        r = getattr(admin, method)(url, json=body) if body else getattr(admin, method)(url)
        assert r.status_code == 422, (url, r.status_code)


def test_login_password_is_case_sensitive(admin):
    assert admin.post("/api/auth/login", json={"email": ADMIN["email"], "password": ADMIN["password"]}).status_code == 200
    assert admin.post("/api/auth/login", json={"email": ADMIN["email"], "password": ADMIN["password"].upper()}).status_code == 401
    # The email is not: addresses are compared case-insensitively
    assert admin.post("/api/auth/login", json={"email": ADMIN["email"].upper(), "password": ADMIN["password"]}).status_code == 200
