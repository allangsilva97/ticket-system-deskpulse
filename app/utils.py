from datetime import datetime, timezone
from typing import Type, TypeVar

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

M = TypeVar("M")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def get_or_404(db: Session, model: Type[M], obj_id: int) -> M:
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(404, f"{model.__name__} not found")
    return obj


def commit_or_409(db: Session, detail: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, detail)
