from typing import Annotated, List, Optional

from fastapi import APIRouter, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app import models, schemas
from app.database import DB
from app.security import AdminUser, CurrentUser, StaffUser
from app.utils import commit_or_409, get_or_404

router = APIRouter(prefix="/api/assets", tags=["assets"])

A = models.Asset
SERIAL_TAKEN = "An asset with this serial number already exists"


def _check_owner(db, user_id: Optional[int]) -> None:
    if user_id is not None:
        get_or_404(db, models.User, user_id)


@router.get("/mine", response_model=List[schemas.AssetSummary])
def my_assets(db: DB, user: CurrentUser):
    """The equipment assigned to the signed-in user: what they can pick when opening a ticket."""
    stmt = (select(A).where(A.assigned_user_id == user.id, A.status != models.AssetStatus.RETIRED)
            .order_by(A.name))
    return db.scalars(stmt).all()


@router.get("", response_model=schemas.AssetPage)
def list_assets(
    db: DB,
    _staff: StaffUser,
    type: Optional[models.AssetType] = None,
    status: Optional[models.AssetStatus] = None,
    assigned_user_id: Optional[int] = None,
    q: Annotated[Optional[str], Query(max_length=200, description="Search name, serial or location")] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
):
    stmt = select(A)
    if type is not None:
        stmt = stmt.where(A.type == type)
    if status is not None:
        stmt = stmt.where(A.status == status)
    if assigned_user_id is not None:
        stmt = stmt.where(A.assigned_user_id == assigned_user_id)
    if q and q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        stmt = stmt.where(or_(*(c.ilike(like, escape="\\") for c in (A.name, A.serial, A.location))))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(
        stmt.options(selectinload(A.assigned_user)).order_by(A.name, A.id)
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    return schemas.AssetPage(
        items=[schemas.AssetOut.model_validate(a) for a in rows],
        total=total, page=page, page_size=page_size,
    )


@router.post("", response_model=schemas.AssetOut, status_code=201)
def create_asset(payload: schemas.AssetCreate, db: DB, _staff: StaffUser):
    _check_owner(db, payload.assigned_user_id)
    asset = A(**payload.model_dump())
    db.add(asset)
    commit_or_409(db, SERIAL_TAKEN)
    return asset


@router.get("/{asset_id}", response_model=schemas.AssetOut)
def get_asset(asset_id: int, db: DB, _staff: StaffUser):
    return get_or_404(db, A, asset_id)


@router.patch("/{asset_id}", response_model=schemas.AssetOut)
def update_asset(asset_id: int, payload: schemas.AssetUpdate, db: DB, _staff: StaffUser):
    asset = get_or_404(db, A, asset_id)
    data = payload.model_dump(exclude_unset=True)
    if "assigned_user_id" in data:
        _check_owner(db, data["assigned_user_id"])
    for field, value in data.items():
        setattr(asset, field, value)
    commit_or_409(db, SERIAL_TAKEN)
    return asset


@router.delete("/{asset_id}", status_code=204)
def delete_asset(asset_id: int, db: DB, _admin: AdminUser):
    db.delete(get_or_404(db, A, asset_id))  # tickets that mention it keep existing, with no asset
    db.commit()
    return Response(status_code=204)
