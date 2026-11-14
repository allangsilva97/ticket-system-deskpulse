from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app import models, schemas
from app.database import DB
from app.security import CurrentUser
from app.utils import utcnow

router = APIRouter(prefix="/api/stats", tags=["stats"])

T = models.Ticket


@router.get("", response_model=schemas.Stats)
def get_stats(db: DB, user: CurrentUser):
    active = T.status != models.TicketStatus.CLOSED
    count = lambda *where: db.scalar(select(func.count(T.id)).where(*where)) or 0  # noqa: E731

    by_status = {s.value: 0 for s in models.TicketStatus}
    for status, n in db.execute(select(T.status, func.count()).group_by(T.status)):
        by_status[status.value] = n

    by_priority = {p.value: 0 for p in models.TicketPriority}
    for priority, n in db.execute(select(T.priority, func.count()).where(active).group_by(T.priority)):
        by_priority[priority.value] = n

    # Average time to close, in hours (done in Python so it works on any database)
    durations = [
        (closed - created).total_seconds()
        for created, closed in db.execute(select(T.created_at, T.closed_at).where(T.closed_at.is_not(None)))
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
        active_tickets=sum(n for s, n in by_status.items() if s != models.TicketStatus.CLOSED.value),
        by_status=by_status,
        by_priority=by_priority,
        overdue=count(active, T.due_at < utcnow()),
        unassigned=count(active, T.assignee_id.is_(None)),
        mine=count(active, T.assignee_id == user.id),
        total_companies=db.scalar(select(func.count(models.Company.id))) or 0,
        avg_resolution_hours=avg_hours,
        recent_activity=[
            schemas.ActivityItem(
                id=e.id, ticket_id=e.ticket_id, ticket_title=e.ticket.title, field=e.field,
                old_value=e.old_value, new_value=e.new_value,
                actor_name=e.actor.name if e.actor else None, created_at=e.created_at,
            )
            for e in events
        ],
    )
