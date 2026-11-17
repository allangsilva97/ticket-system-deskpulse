from typing import Annotated, List

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import case, func, select

from app import models, schemas
from app.database import DB
from app.security import AdminUser, require_staff
from app.utils import commit_or_409, get_or_404

router = APIRouter(
    prefix="/api/companies", tags=["companies"], dependencies=[Depends(require_staff)]
)

NAME_TAKEN = "A company with this name already exists"

T = models.Ticket
_total = func.count(T.id)
_open = func.coalesce(func.sum(case((T.status.not_in(models.DONE_STATUSES), 1), else_=0)), 0)


def _with_counts():
    return (
        select(models.Company, _total, _open)
        .outerjoin(T, T.company_id == models.Company.id)
        .group_by(models.Company.id)
    )


def _out(company: models.Company, total: int, open_: int) -> schemas.CompanyOut:
    out = schemas.CompanyOut.model_validate(company)
    out.ticket_count, out.open_ticket_count = total, open_
    return out


def _load(db, company_id: int) -> schemas.CompanyOut:
    row = db.execute(_with_counts().where(models.Company.id == company_id)).first()
    if row is None:
        get_or_404(db, models.Company, company_id)  # raises 404
    return _out(*row)


@router.get("", response_model=List[schemas.CompanyOut])
def list_companies(
    db: DB,
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
):
    stmt = _with_counts().order_by(models.Company.name).offset(skip).limit(limit)
    return [_out(*row) for row in db.execute(stmt).all()]


@router.post("", response_model=schemas.CompanyOut, status_code=201)
def create_company(payload: schemas.CompanyCreate, db: DB):
    company = models.Company(**payload.model_dump())
    db.add(company)
    commit_or_409(db, NAME_TAKEN)
    return _out(company, 0, 0)


@router.get("/{company_id}", response_model=schemas.CompanyOut)
def get_company(company_id: int, db: DB):
    return _load(db, company_id)


@router.patch("/{company_id}", response_model=schemas.CompanyOut)
def update_company(company_id: int, payload: schemas.CompanyUpdate, db: DB):
    company = get_or_404(db, models.Company, company_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(company, field, value)
    commit_or_409(db, NAME_TAKEN)
    return _load(db, company_id)


@router.delete("/{company_id}", status_code=204)
def delete_company(company_id: int, db: DB, _admin: AdminUser):
    db.delete(get_or_404(db, models.Company, company_id))
    db.commit()
    return Response(status_code=204)
