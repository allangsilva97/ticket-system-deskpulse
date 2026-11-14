from conftest import ADMIN


def test_setup_only_once_and_login(client):
    assert client.get("/api/auth/setup-status").json() == {"needs_setup": True, "setup_token_required": False}
    r = client.post("/api/auth/setup", json=ADMIN)
    assert r.status_code == 201
    assert r.json()["user"]["role"] == "admin"
    assert client.get("/api/auth/setup-status").json() == {"needs_setup": False, "setup_token_required": False}
    assert client.post("/api/auth/setup", json=ADMIN).status_code == 409

    # email is case-insensitive
    r = client.post("/api/auth/login", json={"email": "ADA@example.com", "password": ADMIN["password"]})
    assert r.status_code == 200 and r.json()["token"]


def test_wrong_credentials_get_the_same_error(client):
    client.post("/api/auth/setup", json=ADMIN)
    bad_pw = client.post("/api/auth/login", json={"email": ADMIN["email"], "password": "wrong-password"})
    no_user = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "whatever-1"})
    assert bad_pw.status_code == no_user.status_code == 401
    assert bad_pw.json() == no_user.json()


def test_api_requires_auth(client):
    for path in ("/api/tickets", "/api/companies", "/api/stats", "/api/users", "/api/auth/me"):
        assert client.get(path).status_code == 401, path
    assert client.get("/api/tickets", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/health").status_code == 200


def test_logout_revokes_token(admin):
    assert admin.get("/api/auth/me").status_code == 200
    assert admin.post("/api/auth/logout").status_code == 204
    assert admin.get("/api/auth/me").status_code == 401


def test_change_password(admin):
    r = admin.patch("/api/auth/me", json={"current_password": "wrong", "new_password": "new-pass-456"})
    assert r.status_code == 400
    r = admin.patch("/api/auth/me", json={"current_password": ADMIN["password"], "new_password": "new-pass-456"})
    assert r.status_code == 200
    assert admin.post("/api/auth/login", json={"email": ADMIN["email"], "password": "new-pass-456"}).status_code == 200


def test_agents_cannot_manage_users(admin, make_agent):
    _, agent = make_agent()
    r = admin.post("/api/users", json={"name": "X", "email": "x@example.com", "password": "short"})
    assert r.status_code == 422  # password too short
    r = admin.post("/api/users", json={"name": "X", "email": "x@example.com", "password": "long-enough"},
                   headers=agent)
    assert r.status_code == 403
    assert admin.get("/api/users", headers=agent).status_code == 200  # but can list them (for assigning)


def test_duplicate_email_is_409(admin, make_agent):
    make_agent()
    r = admin.post("/api/users", json={"name": "Dup", "email": "ALEX@example.com", "password": "long-enough"})
    assert r.status_code == 409


def test_admin_cannot_lock_themselves_out(admin):
    me = admin.get("/api/auth/me").json()
    assert admin.patch(f"/api/users/{me['id']}", json={"role": "agent"}).status_code == 400
    assert admin.patch(f"/api/users/{me['id']}", json={"is_active": False}).status_code == 400
    assert admin.patch(f"/api/users/{me['id']}", json={"name": "Ada L."}).status_code == 200


def test_deactivating_a_user_signs_them_out(admin, make_agent):
    agent, headers = make_agent()
    assert admin.get("/api/auth/me", headers=headers).status_code == 200
    assert admin.patch(f"/api/users/{agent['id']}", json={"is_active": False}).status_code == 200
    assert admin.get("/api/auth/me", headers=headers).status_code == 401
    login = {"email": agent["email"], "password": "agent-pass-123"}
    assert admin.post("/api/auth/login", json=login).status_code == 401
    # hidden from the default list, visible with include_inactive
    assert agent["id"] not in [u["id"] for u in admin.get("/api/users").json()]
    assert agent["id"] in [u["id"] for u in admin.get("/api/users?include_inactive=true").json()]
