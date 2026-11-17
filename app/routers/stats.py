from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app import models, schemas
from app.database import DB
from app.security import StaffUser
from app.utils import utcnow

router = APIRouter(prefix="/api/stats", tags=["stats"])

T = models.Ticket
DONE_VALUES = {s.value for s in models.DONE_STATUSES}


@router.get("", response_model=schemas.Stats)
def get_stats(db: DB, user: StaffUser):
    active = T.status.not_in(models.DONE_STATUSES)
    count = lambda *where: db.scalar(select(func.count(T.id)).where(*where)) or 0  # noqa: E731

    by_status = {s.value: 0 for s in models.TicketStatus}
    for status, n in db.execute(select(T.status, func.count()).group_by(T.status)):
        by_status[status.value] = n

    by_priority = {p.value: 0 for p in models.TicketPriority}
    unprioritized = 0
    for priority, n in db.execute(select(T.priority, func.count()).where(active).group_by(T.priority)):
        if priority is None:
            unprioritized = n
        else:
            by_priority[priority.value] = n

    assets_by_status = {s.value: 0 for s in models.AssetStatus}
    for status, n in db.execute(select(models.Asset.status, func.count()).group_by(models.Asset.status)):
        assets_by_status[status.value] = n

    # Average time to close, in hours (done in Python so it works on any database)
    durations = [
        (resolved - created).total_seconds()
        for created, resolved in db.execute(select(T.created_at, T.resolved_at).where(T.resolved_at.is_not(None)))
    ]
    avg_hours = round(sum(durations) / len(durations) / 3600, 1) if durations else None

    events = db.scalars(
        select(models.TicketEvent)
        .options(selectinload(models.TicketEvent.actor), selectinload(models.TicketEvent.ticket))
        .order_by(models.TicketEvent.id.desc())
        .limit(12)
    ).all()

    return schemas.Stats(
        total_tickets=sum(by_status.values()),
        active_tickets=sum(n for s, n in by_status.items() if s not in DONE_VALUES),
        by_status=by_status,
        by_priority=by_priority,
        unprioritized=unprioritized,
        total_assets=sum(assets_by_status.values()),
        assets_by_status=assets_by_status,
        overdue=count(active, T.due_at < utcnow()),
        unassigned=count(active, T.assignee_id.is_(None)),
        mine=count(active, T.assignee_id == user.id),
        total_companies=db.scalar(select(func.count(models.Company.id))) or 0,
        avg_resolution_hours=avg_hours,
        recent_activity=[
            schemas.ActivityItem(
                id=e.id, ticket_id=e.ticket_id, ticket_code=e.ticket.code, ticket_title=e.ticket.title, field=e.field,
                old_value=e.old_value, new_value=e.new_value,
                actor_name=e.actor.name if e.actor else None, created_at=e.created_at,
            )
            for e in events
        ],
    )
