import time

from app import totp
from app.database import SessionLocal
from app.models import User

from conftest import ADMIN


# ---------- Assets ----------

def test_asset_crud_and_permissions(admin, make_tech, make_user):
    _, tech = make_tech()
    user, end_user = make_user()
    body = {"name": 'MacBook Pro 16"', "type": "laptop", "serial": "C02G80XZMD6M", "status": "in_use",
            "assigned_user_id": user["id"]}

    a = admin.post("/api/assets", json=body, headers=tech).json()
    assert a["code"] == f"AST-{a['id']}" and a["assigned_user"]["name"] == "Sarah User"
    assert admin.post("/api/assets", json={**body, "name": "Dup"}).status_code == 409  # serial is unique
    assert admin.post("/api/assets", json={"name": "x", "type": "toaster"}).status_code == 422
    assert admin.post("/api/assets", json={**body, "serial": "S2", "assigned_user_id": 999}).status_code == 404

    r = admin.patch(f"/api/assets/{a['id']}", json={"status": "maintenance", "assigned_user_id": None})
    assert r.status_code == 200 and r.json()["assigned_user"] is None and r.json()["status"] == "maintenance"
    assert admin.patch(f"/api/assets/{a['id']}", json={"status": None}).status_code == 422

    # End users can't browse the inventory, only see what is assigned to them.
    assert admin.get("/api/assets", headers=end_user).status_code == 403
    assert admin.get(f"/api/assets/{a['id']}", headers=end_user).status_code == 403
    assert admin.get("/api/assets/mine", headers=end_user).json() == []
    admin.patch(f"/api/assets/{a['id']}", json={"assigned_user_id": user["id"], "status": "in_use"})
    assert [x["id"] for x in admin.get("/api/assets/mine", headers=end_user).json()] == [a["id"]]

    assert admin.delete(f"/api/assets/{a['id']}", headers=tech).status_code == 403
    assert admin.delete(f"/api/assets/{a['id']}").status_code == 204


def test_asset_list_filters(admin):
    admin.post("/api/assets", json={"name": "Dell Latitude", "type": "laptop", "serial": "DL-1"})
    admin.post("/api/assets", json={"name": "HP LaserJet", "type": "printer", "location": "3rd floor hallway"})
    admin.post("/api/assets", json={"name": "Old PC", "type": "desktop", "status": "retired"})

    names = lambda **p: [a["name"] for a in admin.get("/api/assets", params=p).json()["items"]]  # noqa: E731
    assert names(type="printer") == ["HP LaserJet"]
    assert names(status="retired") == ["Old PC"]
    assert names(q="hallway") == ["HP LaserJet"] and names(q="dl-1") == ["Dell Latitude"]
    assert names(q="%") == []
    assert admin.get("/api/assets", params={"type": "x"}).status_code == 422


# ---------- Two-factor ----------

def _current_code(secret):
    return totp._code(secret, int(time.time() // totp.STEP))


def test_totp_matches_rfc_6238_vector():
    # RFC 6238 appendix B, SHA-1, secret "12345678901234567890", T = 59 s -> 94287082 (last 6 digits)
    import base64
    secret = base64.b32encode(b"12345678901234567890").decode().rstrip("=")
    assert totp._code(secret, 59 // 30) == "287082"
    assert totp.match(secret, "287082", now=59) == 1
    assert totp.match(secret, "287082", now=59 + 300) is None  # too old


def test_two_factor_flow(client, admin):
    assert admin.post("/api/auth/2fa/enable", json={"code": "123456"}).status_code == 400  # no setup yet

    setup = admin.post("/api/auth/2fa/setup").json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/DeskPulse:") and setup["secret"] in setup["otpauth_uri"]
    assert admin.post("/api/auth/2fa/enable", json={"code": "000000"}).status_code == 400
    me = admin.post("/api/auth/2fa/enable", json={"code": _current_code(setup["secret"])}).json()
    assert me["two_factor_enabled"] is True

    creds = {"email": ADMIN["email"], "password": ADMIN["password"]}
    r = client.post("/api/auth/login", json=creds)
    assert r.status_code == 401 and r.headers["X-2FA-Required"] == "true"
    assert client.post("/api/auth/login", json={**creds, "otp": "000000"}).status_code == 401

    # The code used to enable it is spent; a fresh one is needed. Make one for the next time step.
    with SessionLocal() as db:
        user = db.query(User).first()
        user.totp_last_counter = int(time.time() // totp.STEP) - 1
        db.commit()
    code = _current_code(setup["secret"])
    ok = client.post("/api/auth/login", json={**creds, "otp": code})
    assert ok.status_code == 200 and ok.json()["user"]["two_factor_enabled"] is True
    assert client.post("/api/auth/login", json={**creds, "otp": code}).status_code == 401  # replay refused


def test_two_factor_disable_needs_password_and_code(client, admin):
    secret = admin.post("/api/auth/2fa/setup").json()["secret"]
    admin.post("/api/auth/2fa/enable", json={"code": _current_code(secret)})
    with SessionLocal() as db:
        db.query(User).first().totp_last_counter = int(time.time() // totp.STEP) - 1
        db.commit()

    assert admin.post("/api/auth/2fa/disable", json={"password": "wrong-password", "code": _current_code(secret)}
                      ).status_code == 400
    r = admin.post("/api/auth/2fa/disable", json={"password": ADMIN["password"], "code": _current_code(secret)})
    assert r.status_code == 200 and r.json()["two_factor_enabled"] is False
    creds = {"email": ADMIN["email"], "password": ADMIN["password"]}
    assert client.post("/api/auth/login", json=creds).status_code == 200  # back to password only
