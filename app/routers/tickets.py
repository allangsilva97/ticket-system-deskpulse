import csv
import enum
import io
import re
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import Select, case, func, or_, select
from sqlalchemy.orm import selectinload

from app import models, schemas, services
from app.database import DB
from app.security import AdminUser, CurrentUser, StaffUser
from app.utils import get_or_404, utcnow

router = APIRouter(prefix="/api/tickets", tags=["tickets"])

T = models.Ticket
DONE = models.DONE_STATUSES

# Enum order is the sort order. A ticket without a priority ranks below "low".
_rank = lambda col, enum_cls: case(*[(col == v, i) for i, v in enumerate(enum_cls)], else_=-1)  # noqa: E731
SORT_COLUMNS = {
    "id": T.id,
    "title": T.title,
    "created_at": T.created_at,
    "updated_at": T.updated_at,
    "due_at": T.due_at,
    "priority": _rank(T.priority, models.TicketPriority),
    "status": _rank(T.status, models.TicketStatus),
}
LIST_OPTIONS = (selectinload(T.company), selectinload(T.assignee), selectinload(T.requester))


def ticket_filters(
    user: CurrentUser,
    status: Annotated[Optional[str], Query(
        pattern="^(open|in_progress|waiting|resolved|closed|active)$",
        description="A status, or `active` for everything not resolved or closed")] = None,
    priority: Annotated[Optional[str], Query(
        pattern="^(low|medium|high|critical|none)$",
        description="A priority, or `none` for tickets still waiting for triage")] = None,
    category: Optional[models.TicketCategory] = None,
    company_id: Optional[int] = None,
    asset_id: Optional[int] = None,
    assignee: Annotated[Optional[str], Query(
        pattern=r"^(me|none|\d+)$", description="`me`, `none` (unassigned) or a user id")] = None,
    overdue: Optional[bool] = None,
    q: Annotated[Optional[str], Query(max_length=200, description="Search title, description, requester, or TK-id")] = None,
) -> Select:
    """Shared by the list and the CSV export, so both always match."""
    stmt = select(T)
    if not user.is_staff:  # end users only ever see tickets they opened
        stmt = stmt.where(T.requester_id == user.id)
    if status == "active":
        stmt = stmt.where(T.status.not_in(DONE))
    elif status:
        stmt = stmt.where(T.status == models.TicketStatus(status))
    if priority == "none":
        stmt = stmt.where(T.priority.is_(None))
    elif priority:
        stmt = stmt.where(T.priority == models.TicketPriority(priority))
    if category is not None:
        stmt = stmt.where(T.category == category)
    if company_id is not None:
        stmt = stmt.where(T.company_id == company_id)
    if asset_id is not None:
        stmt = stmt.where(T.asset_id == asset_id)
    if assignee == "me":
        stmt = stmt.where(T.assignee_id == user.id)
    elif assignee == "none":
        stmt = stmt.where(T.assignee_id.is_(None))
    elif assignee:
        stmt = stmt.where(T.assignee_id == int(assignee))
    if overdue is True:
        stmt = stmt.where(T.status.not_in(DONE), T.due_at < utcnow())
    elif overdue is False:
        stmt = stmt.where(or_(T.status.in_(DONE), T.due_at.is_(None), T.due_at >= utcnow()))
    if q and q.strip():
        term = q.strip()
        # Escape LIKE wildcards so a search for "100%" or "a_b" matches those characters literally.
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        conds = [c.ilike(like, escape="\\") for c in (T.title, T.description)]
        conds.append(T.requester.has(or_(
            models.User.name.ilike(like, escape="\\"), models.User.email.ilike(like, escape="\\"))))
        code = re.sub(r"^(tk-|#)", "", term, flags=re.IGNORECASE)  # "TK-12", "#12" and "12" all find ticket 12
        if code.isascii() and code.isdigit():
            conds.append(T.id == int(code))
        stmt = stmt.where(or_(*conds))
    return stmt


Filtered = Annotated[Select, Depends(ticket_filters)]


def _full(db, ticket_id: int, user: models.User) -> schemas.TicketOut:
    ticket = db.scalar(
        select(T).where(T.id == ticket_id).options(
            *LIST_OPTIONS,
            selectinload(T.created_by),
            selectinload(T.asset),
            selectinload(T.comments).selectinload(models.Comment.author),
            selectinload(T.events).selectinload(models.TicketEvent.actor),
        )
    )
    # Someone else's ticket looks the same as one that doesn't exist.
    if ticket is None or not (user.is_staff or ticket.requester_id == user.id):
        raise HTTPException(404, "Ticket not found")
    out = schemas.TicketOut.model_validate(ticket)
    if not user.is_staff:  # internal notes, and the log lines that announce them, are staff-only
        out.comments = [c for c in out.comments if not c.is_internal]
        out.events = [e for e in out.events if not (e.field == "comment" and e.new_value == "internal")]
    return out


@router.get("", response_model=schemas.TicketPage)
def list_tickets(
    db: DB,
    stmt: Filtered,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 25,
    sort: Annotated[str, Query(pattern="^(" + "|".join(SORT_COLUMNS) + ")$")] = "created_at",
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
):
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    col = SORT_COLUMNS[sort]
    rows = db.scalars(
        stmt.options(*LIST_OPTIONS)
        .order_by(col.asc() if order == "asc" else col.desc(), T.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return schemas.TicketPage(
        items=[schemas.TicketListItem.model_validate(t) for t in rows],
        total=total, page=page, page_size=page_size,
    )


def _csv_cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, enum.Enum):
        return value.value
    text = str(value)
    # Block CSV/formula injection: Excel runs cells that start with these characters.
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


@router.get("/export.csv", response_class=Response)
def export_csv(db: DB, stmt: Filtered, _staff: StaffUser):
    rows = db.scalars(stmt.options(*LIST_OPTIONS).order_by(T.created_at.desc()).limit(10_000)).all()
    buf = io.StringIO()
    buf.write("﻿")  # BOM so Excel opens accented text as UTF-8
    writer = csv.writer(buf)
    writer.writerow(["id", "title", "status", "priority", "category", "company", "assignee", "requester",
                     "requester_email", "created_at", "due_at", "resolved_at", "overdue"])
    for t in rows:
        writer.writerow([_csv_cell(v) for v in (
            t.code, t.title, t.status, t.priority, t.category, t.company.name,
            t.assignee.name if t.assignee else None,
            t.requester.name if t.requester else None, t.requester.email if t.requester else None,
            t.created_at, t.due_at, t.resolved_at, "yes" if t.is_overdue else "no",
        )])
    return Response(
        buf.getvalue(), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="tickets.csv"'},
    )


@router.post("", response_model=schemas.TicketOut, status_code=201)
def create_ticket(payload: schemas.TicketCreate, db: DB, user: CurrentUser):
    ticket = services.create_ticket(db, payload.model_dump(), user)
    db.commit()
    return _full(db, ticket.id, user)


@router.post("/bulk", response_model=schemas.BulkResult)
def bulk_update(payload: schemas.TicketBulkUpdate, db: DB, user: StaffUser):
    changes = payload.model_dump(exclude_unset=True, exclude={"ids"})
    if not changes:
        raise HTTPException(400, "Nothing to change")
    ids = set(payload.ids)
    tickets = db.scalars(select(T).where(T.id.in_(ids)).options(*LIST_OPTIONS)).all()
    if len(tickets) != len(ids):
        raise HTTPException(404, "Some tickets were not found")
    for ticket in tickets:
        services.apply_changes(db, ticket, changes, user)
    db.commit()
    return schemas.BulkResult(updated=len(tickets))


@router.get("/{ticket_id}", response_model=schemas.TicketOut)
def get_ticket(ticket_id: int, db: DB, user: CurrentUser):
    return _full(db, ticket_id, user)


@router.patch("/{ticket_id}", response_model=schemas.TicketOut)
def update_ticket(ticket_id: int, payload: schemas.TicketUpdate, db: DB, user: StaffUser):
    ticket = get_or_404(db, T, ticket_id)
    services.apply_changes(db, ticket, payload.model_dump(exclude_unset=True), user)
    db.commit()
    db.expire_all()
    return _full(db, ticket_id, user)


@router.delete("/{ticket_id}", status_code=204)
def delete_ticket(ticket_id: int, db: DB, _admin: AdminUser):
    db.delete(get_or_404(db, T, ticket_id))
    db.commit()
    return Response(status_code=204)


@router.post("/{ticket_id}/comments", response_model=schemas.CommentOut, status_code=201)
def add_comment(ticket_id: int, payload: schemas.CommentCreate, db: DB, user: CurrentUser):
    ticket = get_or_404(db, T, ticket_id)
    if not (user.is_staff or ticket.requester_id == user.id):
        raise HTTPException(404, "Ticket not found")
    comment = services.add_comment(db, ticket, user, payload.body, payload.is_internal)
    db.commit()
    return schemas.CommentOut.model_validate(comment)
