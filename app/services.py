"""Ticket business rules, shared by creation, single updates and bulk updates."""
import enum
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import config, models
from app.utils import get_or_404, utcnow

TRACKED_FIELDS = ("title", "status", "priority", "category")


def due_for(created_at: datetime, priority: Optional[models.TicketPriority]) -> Optional[datetime]:
    """No priority, no deadline: the clock starts when a technician triages the ticket."""
    if priority is None:
        return None
    return created_at + timedelta(hours=config.SLA_HOURS[priority.value])


def active_staff_or_400(db: Session, user_id: int) -> models.User:
    user = db.get(models.User, user_id)
    if user is None or not user.is_active or not user.is_staff:
        raise HTTPException(400, "Assignee must be an active technician or admin")
    return user


def active_user_or_400(db: Session, user_id: int) -> models.User:
    user = db.get(models.User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(400, "Requester must be an active user")
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
    data = dict(data)
    asset_id = data.pop("asset_id", None)
    assignee_id = data.pop("assignee_id", None)
    requester_id = data.pop("requester_id", None)
    company_id = data.pop("company_id", None)
    priority = data.pop("priority", None)

    if actor.is_staff:
        if company_id is None:
            raise HTTPException(400, "company_id is required")
        company = get_or_404(db, models.Company, company_id)
        requester = active_user_or_400(db, requester_id) if requester_id is not None else None
        assignee = active_staff_or_400(db, assignee_id) if assignee_id is not None else None
        asset = get_or_404(db, models.Asset, asset_id) if asset_id is not None else None
    else:
        if any(v is not None for v in (priority, assignee_id, requester_id, company_id)):
            raise HTTPException(403, "Only technicians can set priority, assignee, requester or company")
        if actor.company is None:
            raise HTTPException(400, "Your account is not linked to a company. Ask an administrator.")
        company, requester, assignee = actor.company, actor, None
        asset = None
        if asset_id is not None:  # an end user can only report problems with equipment that is theirs
            asset = db.get(models.Asset, asset_id)
            if asset is None or asset.assigned_user_id != actor.id:
                raise HTTPException(400, "That asset is not assigned to you")

    now = utcnow()
    ticket = models.Ticket(
        **data,
        priority=priority,
        company=company,
        requester=requester,
        assignee=assignee,
        asset=asset,
        created_by=actor,
        created_at=now,
        updated_at=now,
        due_at=due_for(now, priority),
    )
    db.add(ticket)
    _log(db, ticket, actor, "created")
    if priority:
        _log(db, ticket, actor, "priority", None, priority)
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
            new = active_staff_or_400(db, assignee_id) if assignee_id is not None else None
            _log(db, ticket, actor, "assignee",
                 ticket.assignee.name if ticket.assignee else None, new.name if new else None)
            ticket.assignee = new

    if "requester_id" in data:
        requester_id = data.pop("requester_id")
        if requester_id != ticket.requester_id:
            new = active_user_or_400(db, requester_id) if requester_id is not None else None
            _log(db, ticket, actor, "requester",
                 ticket.requester.name if ticket.requester else None, new.name if new else None)
            ticket.requester = new

    if "asset_id" in data:
        asset_id = data.pop("asset_id")
        if asset_id != ticket.asset_id:
            new = get_or_404(db, models.Asset, asset_id) if asset_id is not None else None
            _log(db, ticket, actor, "asset",
                 ticket.asset.code if ticket.asset else None, new.code if new else None)
            ticket.asset = new

    new_status = data.get("status")
    if new_status is not None and new_status != ticket.status:
        if new_status in models.DONE_STATUSES:
            if ticket.status not in models.DONE_STATUSES:  # resolved -> closed keeps the original time
                ticket.resolved_at = utcnow()
        else:
            ticket.resolved_at = None

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
    if is_internal and not actor.is_staff:
        raise HTTPException(403, "Only technicians can write internal notes")
    comment = models.Comment(ticket=ticket, author=actor, body=body, is_internal=is_internal)
    db.add(comment)
    _log(db, ticket, actor, "comment", None, "internal" if is_internal else "public")
    ticket.updated_at = utcnow()
    return comment
