import csv
import io
from datetime import datetime, timedelta, timezone

from app import models
from app.database import SessionLocal


def new_ticket(client, company, **extra):
    body = {"title": "Printer on fire", "company_id": company["id"], **extra}
    r = client.post("/api/tickets", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def hours_between(a, b):
    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 3600


# ---------- Companies ----------

def test_company_crud_and_counts(admin, company):
    assert admin.post("/api/companies", json={"name": "Acme"}).status_code == 409
    assert admin.post("/api/companies", json={"name": "X", "email": "bad"}).status_code == 422
    assert admin.patch(f"/api/companies/{company['id']}", json={"name": None}).status_code == 422

    new_ticket(admin, company)
    done = new_ticket(admin, company)
    admin.patch(f"/api/tickets/{done['id']}", json={"status": "resolved"})
    c = admin.get(f"/api/companies/{company['id']}").json()
    assert (c["ticket_count"], c["open_ticket_count"]) == (2, 1)


def test_company_access_and_cascade(admin, company, make_tech, make_user):
    _, tech = make_tech()
    _, end_user = make_user()
    t = new_ticket(admin, company)
    assert admin.get("/api/companies", headers=end_user).status_code == 403
    assert admin.get("/api/companies", headers=tech).status_code == 200
    assert admin.delete(f"/api/companies/{company['id']}", headers=tech).status_code == 403
    assert admin.delete(f"/api/companies/{company['id']}").status_code == 204
    assert admin.get(f"/api/tickets/{t['id']}").status_code == 404


# ---------- Create ----------

def test_create_by_staff_has_code_and_no_deadline_until_triaged(admin, company):
    t = new_ticket(admin, company)
    assert t["code"] == f"TK-{t['id']}"
    assert t["status"] == "open" and t["category"] == "other"
    assert t["priority"] is None and t["due_at"] is None and t["is_overdue"] is False
    assert t["created_by"]["name"] == "Ada Admin" and t["requester"] is None
    assert [e["field"] for e in t["events"]] == ["created"]
    assert t["created_at"].endswith("Z") or t["created_at"].endswith("+00:00")


def test_staff_may_set_priority_on_create_and_sla_follows(admin, company):
    t = new_ticket(admin, company, priority="critical")
    assert round(hours_between(t["created_at"], t["due_at"])) == 4
    assert [e["field"] for e in t["events"]] == ["created", "priority"]


def test_end_user_opens_ticket_under_own_company_without_priority(admin, company, make_user):
    user, headers = make_user()
    r = admin.post("/api/tickets", headers=headers, json={"title": "VPN down", "category": "network"})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["company"]["id"] == company["id"] and t["requester"]["id"] == user["id"]
    assert t["category"] == "network" and t["priority"] is None and t["due_at"] is None

    # Everything that is the technicians' call is refused, not silently ignored.
    for extra in ({"priority": "high"}, {"assignee_id": 1}, {"requester_id": 1}, {"company_id": company["id"]}):
        r = admin.post("/api/tickets", headers=headers, json={"title": "x", **extra})
        assert r.status_code == 403, extra


def test_end_user_needs_a_company(admin):
    admin.post("/api/users", json={"name": "Loose", "email": "loose@example.com",
                                   "password": "long-enough-1", "role": "user"})
    token = admin.post("/api/auth/login", json={"email": "loose@example.com",
                                                "password": "long-enough-1"}).json()["token"]
    r = admin.post("/api/tickets", headers={"Authorization": f"Bearer {token}"}, json={"title": "x"})
    assert r.status_code == 400


def test_create_validation(admin, company, make_tech, make_user):
    assert admin.post("/api/tickets", json={"title": "x"}).status_code == 400  # staff must pick a company
    assert admin.post("/api/tickets", json={"title": "x", "company_id": 999}).status_code == 404
    assert admin.post("/api/tickets", json={"title": "  ", "company_id": company["id"]}).status_code == 422
    assert admin.post("/api/tickets", json={"title": "x", "company_id": company["id"],
                                            "priority": "urgent"}).status_code == 422  # renamed to critical
    tech, _ = make_tech()
    user, _ = make_user()
    admin.patch(f"/api/users/{tech['id']}", json={"is_active": False})
    body = {"title": "x", "company_id": company["id"]}
    assert admin.post("/api/tickets", json={**body, "assignee_id": tech["id"]}).status_code == 400
    assert admin.post("/api/tickets", json={**body, "assignee_id": user["id"]}).status_code == 400  # not staff
    assert admin.post("/api/tickets", json={**body, "requester_id": user["id"]}).status_code == 201


# ---------- Update & audit trail ----------

def test_update_logs_changes_and_handles_resolving(admin, company, make_tech):
    tech, _ = make_tech()
    t = new_ticket(admin, company, description="smoke")

    t = admin.patch(f"/api/tickets/{t['id']}", json={
        "status": "resolved", "priority": "high", "category": "hardware", "assignee_id": tech["id"]}).json()
    assert t["resolved_at"] and t["description"] == "smoke" and t["category"] == "hardware"
    assert t["assignee"]["name"] == "Alex Tech"
    assert round(hours_between(t["created_at"], t["due_at"])) == 24  # SLA follows priority
    fields = {e["field"]: e for e in t["events"]}
    assert fields["status"]["old_value"] == "open" and fields["status"]["new_value"] == "resolved"
    assert fields["assignee"]["new_value"] == "Alex Tech"
    assert fields["priority"]["old_value"] is None and fields["priority"]["actor"]["name"] == "Ada Admin"

    first = t["resolved_at"]  # resolved -> closed keeps the original time
    t = admin.patch(f"/api/tickets/{t['id']}", json={"status": "closed"}).json()
    assert t["resolved_at"] == first

    t = admin.patch(f"/api/tickets/{t['id']}", json={"status": "waiting", "assignee_id": None}).json()
    assert t["resolved_at"] is None and t["assignee"] is None

    n = len(t["events"])  # no-op update records nothing new
    t = admin.patch(f"/api/tickets/{t['id']}", json={"status": "waiting"}).json()
    assert len(t["events"]) == n

    assert admin.patch(f"/api/tickets/{t['id']}", json={"title": None}).status_code == 422
    assert admin.patch(f"/api/tickets/{t['id']}", json={"priority": None}).status_code == 422
    assert admin.patch(f"/api/tickets/{t['id']}", json={"company_id": 999}).status_code == 404


def test_end_users_cannot_edit_tickets(admin, company, make_user):
    _, headers = make_user()
    t = admin.post("/api/tickets", headers=headers, json={"title": "Mine"}).json()
    assert admin.patch(f"/api/tickets/{t['id']}", headers=headers, json={"priority": "low"}).status_code == 403
    assert admin.post("/api/tickets/bulk", headers=headers,
                      json={"ids": [t["id"]], "status": "closed"}).status_code == 403
    assert admin.delete(f"/api/tickets/{t['id']}", headers=headers).status_code == 403
    assert admin.get("/api/tickets/export.csv", headers=headers).status_code == 403
    assert admin.get("/api/stats", headers=headers).status_code == 403


# ---------- Assets on tickets ----------

def test_ticket_asset_rules(admin, company, make_user):
    user, headers = make_user()
    mine = admin.post("/api/assets", json={"name": "MacBook", "type": "laptop", "status": "in_use",
                                           "assigned_user_id": user["id"]}).json()
    other = admin.post("/api/assets", json={"name": "Printer", "type": "printer"}).json()

    r = admin.post("/api/tickets", headers=headers, json={"title": "Slow", "asset_id": other["id"]})
    assert r.status_code == 400  # not theirs
    t = admin.post("/api/tickets", headers=headers, json={"title": "Slow", "asset_id": mine["id"]}).json()
    assert t["asset"]["code"] == mine["code"]

    # staff can link any asset, and the change is logged
    t = admin.patch(f"/api/tickets/{t['id']}", json={"asset_id": other["id"]}).json()
    assert t["asset"]["id"] == other["id"]
    assert [e for e in t["events"] if e["field"] == "asset"][0]["new_value"] == other["code"]
    assert admin.patch(f"/api/tickets/{t['id']}", json={"asset_id": 999}).status_code == 404

    # deleting the asset leaves the ticket, unlinked
    assert admin.delete(f"/api/assets/{other['id']}").status_code == 204
    assert admin.get(f"/api/tickets/{t['id']}").json()["asset"] is None


# ---------- What an end user can see ----------

def test_end_user_sees_only_own_tickets_and_no_internal_notes(admin, company, make_user, make_tech):
    _, sarah = make_user()
    _, tom = make_user("Tom User", "tom@example.com")
    _, tech = make_tech()
    t = admin.post("/api/tickets", headers=sarah, json={"title": "Mine"}).json()
    admin.post("/api/tickets", headers=tom, json={"title": "Not yours"})

    assert [x["id"] for x in admin.get("/api/tickets", headers=sarah).json()["items"]] == [t["id"]]
    assert admin.get(f"/api/tickets/{t['id']}", headers=tom).status_code == 404
    assert admin.post(f"/api/tickets/{t['id']}/comments", headers=tom, json={"body": "hi"}).status_code == 404

    admin.post(f"/api/tickets/{t['id']}/comments", headers=tech, json={"body": "Public reply"})
    admin.post(f"/api/tickets/{t['id']}/comments", headers=tech, json={"body": "Secret", "is_internal": True})
    admin.post(f"/api/tickets/{t['id']}/comments", headers=sarah, json={"body": "Thanks"})
    r = admin.post(f"/api/tickets/{t['id']}/comments", headers=sarah, json={"body": "x", "is_internal": True})
    assert r.status_code == 403

    seen = admin.get(f"/api/tickets/{t['id']}", headers=sarah).json()
    assert [c["body"] for c in seen["comments"]] == ["Public reply", "Thanks"]
    assert not any(e["field"] == "comment" and e["new_value"] == "internal" for e in seen["events"])
    staff_view = admin.get(f"/api/tickets/{t['id']}", headers=tech).json()
    assert [c["body"] for c in staff_view["comments"]] == ["Public reply", "Secret", "Thanks"]


# ---------- Comments & deletes ----------

def test_comments(admin, company, make_tech):
    _, tech = make_tech()
    t = new_ticket(admin, company)
    r = admin.post(f"/api/tickets/{t['id']}/comments", json={"body": "  On it  "}, headers=tech)
    assert r.status_code == 201 and r.json()["body"] == "On it"
    admin.post(f"/api/tickets/{t['id']}/comments", json={"body": "VIP customer", "is_internal": True})
    assert admin.post(f"/api/tickets/{t['id']}/comments", json={"body": "   "}).status_code == 422

    t = admin.get(f"/api/tickets/{t['id']}").json()
    assert [(c["author"]["name"], c["is_internal"]) for c in t["comments"]] == [
        ("Alex Tech", False), ("Ada Admin", True)]


def test_only_admins_delete_tickets(admin, company, make_tech):
    _, tech = make_tech()
    t = new_ticket(admin, company)
    assert admin.delete(f"/api/tickets/{t['id']}", headers=tech).status_code == 403
    assert admin.delete(f"/api/tickets/{t['id']}").status_code == 204


# ---------- List: filters, search, sort, pages ----------

def test_list_filters_search_sort_and_pagination(admin, company, make_tech, make_user):
    tech, tech_headers = make_tech()
    sarah, _ = make_user()
    other = admin.post("/api/companies", json={"name": "Globex"}).json()
    a = new_ticket(admin, company, title="Email down", priority="low")
    b = new_ticket(admin, company, title="VPN broken", priority="critical", assignee_id=tech["id"],
                   category="network", requester_id=sarah["id"])
    c = new_ticket(admin, other, title="New laptop", description="for the CEO", priority="high")
    d = new_ticket(admin, company, title="Untriaged")
    admin.patch(f"/api/tickets/{a['id']}", json={"status": "closed"})

    ids = lambda **p: [t["id"] for t in admin.get("/api/tickets", params=p).json()["items"]]  # noqa: E731

    assert set(ids(status="active")) == {b["id"], c["id"], d["id"]}
    assert ids(status="closed") == [a["id"]]
    assert set(ids(company_id=other["id"])) == {c["id"]}
    assert ids(category="network") == [b["id"]]
    assert ids(priority="none") == [d["id"]]
    assert ids(priority="high") == [c["id"]]
    assert ids(q="ceo") == [c["id"]]                       # searches description
    assert ids(q="sarah") == [b["id"]]                     # searches the requester's name
    assert ids(q=f"#{b['id']}") == [b["id"]]               # search by id...
    assert ids(q=f"tk-{b['id']}") == [b["id"]]             # ...or by code
    assert ids(q="%") == [] and ids(q="_") == []           # LIKE wildcards are literal
    assert set(ids(assignee="none", status="active")) == {c["id"], d["id"]}
    assert ids(assignee=str(tech["id"])) == [b["id"]]
    assert [t["id"] for t in admin.get("/api/tickets", params={"assignee": "me"},
                                       headers=tech_headers).json()["items"]] == [b["id"]]
    assert ids(sort="priority", order="desc") == [b["id"], c["id"], a["id"], d["id"]]  # untriaged last

    page = admin.get("/api/tickets", params={"page_size": 2, "page": 2, "sort": "id", "order": "asc"}).json()
    assert page["total"] == 4 and [t["id"] for t in page["items"]] == [c["id"], d["id"]]

    assert admin.get("/api/tickets", params={"status": "bogus"}).status_code == 422
    assert admin.get("/api/tickets", params={"priority": "urgent"}).status_code == 422
    assert admin.get("/api/tickets", params={"page_size": 1000}).status_code == 422


def test_overdue(admin, company):
    late = new_ticket(admin, company, title="Late", priority="low")
    new_ticket(admin, company, title="On time", priority="low")
    new_ticket(admin, company, title="No deadline yet")
    with SessionLocal() as db:  # push one ticket's due date into the past
        db.get(models.Ticket, late["id"]).due_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.commit()

    items = admin.get("/api/tickets", params={"overdue": "true"}).json()["items"]
    assert [t["id"] for t in items] == [late["id"]] and items[0]["is_overdue"] is True
    assert admin.get("/api/stats").json()["overdue"] == 1

    admin.patch(f"/api/tickets/{late['id']}", json={"status": "resolved"})
    assert admin.get("/api/tickets", params={"overdue": "true"}).json()["total"] == 0


# ---------- Bulk, export, stats ----------

def test_bulk_update(admin, company, make_tech):
    tech, _ = make_tech()
    t1, t2 = new_ticket(admin, company), new_ticket(admin, company)
    r = admin.post("/api/tickets/bulk", json={
        "ids": [t1["id"], t2["id"]], "status": "in_progress", "assignee_id": tech["id"]})
    assert r.status_code == 200 and r.json() == {"updated": 2}
    for t in (t1, t2):
        got = admin.get(f"/api/tickets/{t['id']}").json()
        assert got["status"] == "in_progress" and got["assignee"]["id"] == tech["id"]

    assert admin.post("/api/tickets/bulk", json={"ids": [t1["id"]]}).status_code == 400
    assert admin.post("/api/tickets/bulk", json={"ids": [t1["id"], 999], "status": "open"}).status_code == 404
    assert admin.get(f"/api/tickets/{t1['id']}").json()["status"] == "in_progress"  # all-or-nothing


def test_csv_export_respects_filters_and_blocks_formula_injection(admin, company):
    new_ticket(admin, company, title="=HYPERLINK(\"http://evil\")")
    done = new_ticket(admin, company, title="Done")
    admin.patch(f"/api/tickets/{done['id']}", json={"status": "closed"})

    r = admin.get("/api/tickets/export.csv", params={"status": "active"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert rows[0][0] == "id" and len(rows) == 2
    assert rows[1][0].startswith("TK-") and rows[1][1].startswith("'=")


def test_stats(admin, company, make_tech):
    me = admin.get("/api/auth/me").json()
    new_ticket(admin, company, priority="critical", assignee_id=me["id"])
    new_ticket(admin, company, priority="low")
    new_ticket(admin, company)  # not triaged yet
    done = new_ticket(admin, company)
    admin.patch(f"/api/tickets/{done['id']}", json={"status": "closed"})
    admin.post("/api/assets", json={"name": "Switch", "type": "network", "status": "in_use"})

    s = admin.get("/api/stats").json()
    assert s["total_tickets"] == 4 and s["active_tickets"] == 3
    assert s["by_status"]["closed"] == 1 and s["by_status"]["waiting"] == 0
    assert s["by_priority"] == {"low": 1, "medium": 0, "high": 0, "critical": 1}
    assert s["unprioritized"] == 1
    assert (s["mine"], s["unassigned"], s["total_companies"]) == (1, 2, 1)
    assert s["total_assets"] == 1 and s["assets_by_status"]["in_use"] == 1
    assert s["avg_resolution_hours"] is not None
    assert s["recent_activity"][0]["field"] == "status" and s["recent_activity"][0]["ticket_code"].startswith("TK-")


def test_frontend_is_served(client):
    home = client.get("/")
    assert home.status_code == 200 and "DeskPulse" in home.text  # the portal is the front page
    assert client.head("/").status_code == 200
    assert client.get("/deskpulse/app.js").status_code == 200
    assert client.get("/deskpulse/theme.js").status_code == 200
    assert client.get("/console").status_code == 200 and "Ticket System" in client.get("/console").text
    assert client.get("/static/app.js").status_code == 200
    assert home.headers["x-content-type-options"] == "nosniff"
    csp = home.headers["content-security-policy"]  # the portal may load Tailwind and icons from their CDNs, nothing else
    assert "connect-src 'self'" in csp and "cdn.tailwindcss.com" in csp and "frame-ancestors 'none'" in csp
    assert "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]  # no inline scripts
    assert "cdn.tailwindcss.com" not in client.get("/console").headers["content-security-policy"]
