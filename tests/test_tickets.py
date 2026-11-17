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
    closed = new_ticket(admin, company)
    admin.patch(f"/api/tickets/{closed['id']}", json={"status": "closed"})
    c = admin.get(f"/api/companies/{company['id']}").json()
    assert (c["ticket_count"], c["open_ticket_count"]) == (2, 1)


def test_only_admins_delete_companies_and_it_cascades(admin, company, make_agent):
    _, agent = make_agent()
    t = new_ticket(admin, company)
    admin.post(f"/api/tickets/{t['id']}/comments", json={"body": "hi"})
    assert admin.delete(f"/api/companies/{company['id']}", headers=agent).status_code == 403
    assert admin.delete(f"/api/companies/{company['id']}").status_code == 204
    assert admin.get(f"/api/tickets/{t['id']}").status_code == 404


# ---------- Create ----------

def test_create_sets_sla_due_date_and_logs_event(admin, company):
    t = new_ticket(admin, company, priority="urgent", requester_email="Bob@Acme.io")
    assert t["status"] == "open"
    assert round(hours_between(t["created_at"], t["due_at"])) == 4
    assert t["requester_email"] == "bob@acme.io"
    assert t["created_by"]["name"] == "Ada Admin"
    assert [e["field"] for e in t["events"]] == ["created"]
    assert t["created_at"].endswith("Z") or t["created_at"].endswith("+00:00")


def test_create_validation(admin, company, make_agent):
    assert admin.post("/api/tickets", json={"title": "x", "company_id": 999}).status_code == 404
    assert admin.post("/api/tickets", json={"title": "  ", "company_id": company["id"]}).status_code == 422
    agent, _ = make_agent()
    admin.patch(f"/api/users/{agent['id']}", json={"is_active": False})
    r = admin.post("/api/tickets", json={"title": "x", "company_id": company["id"], "assignee_id": agent["id"]})
    assert r.status_code == 400


# ---------- Update & audit trail ----------

def test_update_logs_changes_and_handles_closing(admin, company, make_agent):
    agent, _ = make_agent()
    t = new_ticket(admin, company, description="smoke")

    t = admin.patch(f"/api/tickets/{t['id']}", json={
        "status": "closed", "priority": "high", "assignee_id": agent["id"]}).json()
    assert t["closed_at"] and t["description"] == "smoke"
    assert t["assignee"]["name"] == "Alex Agent"
    assert round(hours_between(t["created_at"], t["due_at"])) == 24  # SLA follows priority
    fields = {e["field"]: e for e in t["events"]}
    assert fields["status"]["old_value"] == "open" and fields["status"]["new_value"] == "closed"
    assert fields["assignee"]["new_value"] == "Alex Agent"
    assert fields["priority"]["actor"]["name"] == "Ada Admin"

    t = admin.patch(f"/api/tickets/{t['id']}", json={"status": "waiting", "assignee_id": None}).json()
    assert t["closed_at"] is None and t["assignee"] is None

    # no-op update records nothing new
    n = len(t["events"])
    t = admin.patch(f"/api/tickets/{t['id']}", json={"status": "waiting"}).json()
    assert len(t["events"]) == n

    assert admin.patch(f"/api/tickets/{t['id']}", json={"title": None}).status_code == 422
    assert admin.patch(f"/api/tickets/{t['id']}", json={"company_id": 999}).status_code == 404


def test_comments(admin, company, make_agent):
    _, agent = make_agent()
    t = new_ticket(admin, company)
    r = admin.post(f"/api/tickets/{t['id']}/comments", json={"body": "  On it  "}, headers=agent)
    assert r.status_code == 201 and r.json()["body"] == "On it"
    admin.post(f"/api/tickets/{t['id']}/comments", json={"body": "VIP customer", "is_internal": True})
    assert admin.post(f"/api/tickets/{t['id']}/comments", json={"body": "   "}).status_code == 422

    t = admin.get(f"/api/tickets/{t['id']}").json()
    assert [(c["author"]["name"], c["is_internal"]) for c in t["comments"]] == [
        ("Alex Agent", False), ("Ada Admin", True)]


def test_only_admins_delete_tickets(admin, company, make_agent):
    _, agent = make_agent()
    t = new_ticket(admin, company)
    assert admin.delete(f"/api/tickets/{t['id']}", headers=agent).status_code == 403
    assert admin.delete(f"/api/tickets/{t['id']}").status_code == 204


# ---------- List: filters, search, sort, pages ----------

def test_list_filters_search_sort_and_pagination(admin, company, make_agent):
    agent, agent_headers = make_agent()
    other = admin.post("/api/companies", json={"name": "Globex"}).json()
    a = new_ticket(admin, company, title="Email down", priority="low")
    b = new_ticket(admin, company, title="VPN broken", priority="urgent", assignee_id=agent["id"])
    c = new_ticket(admin, other, title="New laptop", description="for the CEO", priority="high")
    admin.patch(f"/api/tickets/{a['id']}", json={"status": "closed"})

    ids = lambda **p: [t["id"] for t in admin.get("/api/tickets", params=p).json()["items"]]  # noqa: E731

    assert set(ids(status="active")) == {b["id"], c["id"]}
    assert ids(status="closed") == [a["id"]]
    assert set(ids(company_id=other["id"])) == {c["id"]}
    assert ids(q="ceo") == [c["id"]]                  # searches description
    assert ids(q=f"#{b['id']}") == [b["id"]]          # search by id
    assert ids(q="%") == [] and ids(q="_") == []      # LIKE wildcards are literal
    assert ids(assignee="none", status="active") == [c["id"]]
    assert ids(assignee=str(agent["id"])) == [b["id"]]
    assert [t["id"] for t in admin.get("/api/tickets", params={"assignee": "me"},
                                       headers=agent_headers).json()["items"]] == [b["id"]]
    assert ids(sort="priority", order="desc") == [b["id"], c["id"], a["id"]]

    page = admin.get("/api/tickets", params={"page_size": 2, "page": 2, "sort": "id", "order": "asc"}).json()
    assert page["total"] == 3 and [t["id"] for t in page["items"]] == [c["id"]]

    assert admin.get("/api/tickets", params={"status": "bogus"}).status_code == 422
    assert admin.get("/api/tickets", params={"page_size": 1000}).status_code == 422


def test_overdue(admin, company):
    late = new_ticket(admin, company, title="Late")
    new_ticket(admin, company, title="On time")
    with SessionLocal() as db:  # push one ticket's due date into the past
        db.get(models.Ticket, late["id"]).due_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.commit()

    items = admin.get("/api/tickets", params={"overdue": "true"}).json()["items"]
    assert [t["id"] for t in items] == [late["id"]] and items[0]["is_overdue"] is True
    assert admin.get("/api/stats").json()["overdue"] == 1

    admin.patch(f"/api/tickets/{late['id']}", json={"status": "closed"})
    assert admin.get("/api/tickets", params={"overdue": "true"}).json()["total"] == 0


# ---------- Bulk, export, stats ----------

def test_bulk_update(admin, company, make_agent):
    agent, _ = make_agent()
    t1, t2 = new_ticket(admin, company), new_ticket(admin, company)
    r = admin.post("/api/tickets/bulk", json={
        "ids": [t1["id"], t2["id"]], "status": "in_progress", "assignee_id": agent["id"]})
    assert r.status_code == 200 and r.json() == {"updated": 2}
    for t in (t1, t2):
        got = admin.get(f"/api/tickets/{t['id']}").json()
        assert got["status"] == "in_progress" and got["assignee"]["id"] == agent["id"]

    assert admin.post("/api/tickets/bulk", json={"ids": [t1["id"]]}).status_code == 400
    assert admin.post("/api/tickets/bulk", json={"ids": [t1["id"], 999], "status": "open"}).status_code == 404
    assert admin.get(f"/api/tickets/{t1['id']}").json()["status"] == "in_progress"  # all-or-nothing


def test_csv_export_respects_filters_and_blocks_formula_injection(admin, company):
    new_ticket(admin, company, title="=HYPERLINK(\"http://evil\")")
    closed = new_ticket(admin, company, title="Done")
    admin.patch(f"/api/tickets/{closed['id']}", json={"status": "closed"})

    r = admin.get("/api/tickets/export.csv", params={"status": "active"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert rows[0][0] == "id" and len(rows) == 2
    assert rows[1][1].startswith("'=")


def test_stats(admin, company, make_agent):
    me = admin.get("/api/auth/me").json()
    new_ticket(admin, company, priority="urgent", assignee_id=me["id"])
    new_ticket(admin, company, priority="low")
    done = new_ticket(admin, company)
    admin.patch(f"/api/tickets/{done['id']}", json={"status": "closed"})

    s = admin.get("/api/stats").json()
    assert s["total_tickets"] == 3 and s["active_tickets"] == 2
    assert s["by_status"]["closed"] == 1 and s["by_status"]["waiting"] == 0
    assert s["by_priority"] == {"low": 1, "medium": 0, "high": 0, "urgent": 1}
    assert (s["mine"], s["unassigned"], s["total_companies"]) == (1, 1, 1)
    assert s["avg_resolution_hours"] is not None
    assert s["recent_activity"][0]["field"] == "status"


def test_frontend_is_served(client):
    assert client.get("/").status_code == 200
    assert client.head("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/").headers["x-content-type-options"] == "nosniff"
