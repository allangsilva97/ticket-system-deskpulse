"""Ticket business rules, shared by single and bulk updates."""
import enum
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import config, models
from app.utils import get_or_404, utcnow

TRACKED_FIELDS = ("title", "status", "priority")


def due_for(created_at: datetime, priority: models.TicketPriority) -> datetime:
    return created_at + timedelta(hours=config.SLA_HOURS[priority.value])


def active_user_or_400(db: Session, user_id: int) -> models.User:
    user = db.get(models.User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(400, "Assignee must be an active user")
    return user


def _display(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, enum.Enum):
        return value.value
    return str(value)[:255]


def _log(db: Session, ticket: models.Ticket, actor: models.User, field: str,
         old: Any = None, new: Any = None) -> None:
    db.add(models.TicketEvent(
        ticket=ticket, actor=actor, field=field, old_value=_display(old), new_value=_display(new)
    ))


def create_ticket(db: Session, data: Dict[str, Any], actor: models.User) -> models.Ticket:
    company = get_or_404(db, models.Company, data.pop("company_id"))
    assignee_id = data.pop("assignee_id", None)
    assignee = active_user_or_400(db, assignee_id) if assignee_id is not None else None

    now = utcnow()
    ticket = models.Ticket(
        **data,
        company=company,
        assignee=assignee,
        created_by=actor,
        created_at=now,
        updated_at=now,
        due_at=due_for(now, data["priority"]),
    )
    db.add(ticket)
    _log(db, ticket, actor, "created")
    if assignee:
        _log(db, ticket, actor, "assignee", None, assignee.name)
    return ticket


def apply_changes(db: Session, ticket: models.Ticket, data: Dict[str, Any], actor: models.User) -> None:
    """Apply a partial update and record an audit event for every tracked change."""
    data = dict(data)

    if "company_id" in data:
        company_id = data.pop("company_id")
        if company_id != ticket.company_id:
            company = get_or_404(db, models.Company, company_id)
            _log(db, ticket, actor, "company", ticket.company.name, company.name)
            ticket.company = company

    if "assignee_id" in data:
        assignee_id = data.pop("assignee_id")
        if assignee_id != ticket.assignee_id:
            new = active_user_or_400(db, assignee_id) if assignee_id is not None else None
            _log(db, ticket, actor, "assignee",
                 ticket.assignee.name if ticket.assignee else None, new.name if new else None)
            ticket.assignee = new

    new_status = data.get("status")
    if new_status is not None and new_status != ticket.status:
        ticket.closed_at = utcnow() if new_status == models.TicketStatus.CLOSED else None

    new_priority = data.get("priority")
    if new_priority is not None and new_priority != ticket.priority:
        ticket.due_at = due_for(ticket.created_at, new_priority)

    for field in TRACKED_FIELDS:
        if field in data and data[field] != getattr(ticket, field):
            _log(db, ticket, actor, field, getattr(ticket, field), data[field])

    for field, value in data.items():
        setattr(ticket, field, value)


def add_comment(db: Session, ticket: models.Ticket, actor: models.User,
                body: str, is_internal: bool) -> models.Comment:
    comment = models.Comment(ticket=ticket, author=actor, body=body, is_internal=is_internal)
    db.add(comment)
    _log(db, ticket, actor, "comment", None, "internal" if is_internal else "public")
    ticket.updated_at = utcnow()
    return comment
