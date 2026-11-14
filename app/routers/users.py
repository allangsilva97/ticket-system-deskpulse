from typing import List

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app import models, schemas
from app.database import DB
from app.security import AdminUser, CurrentUser, hash_password, revoke_tokens
from app.utils import commit_or_409, get_or_404

router = APIRouter(prefix="/api/users", tags=["users"])

EMAIL_TAKEN = "A user with this email already exists"


@router.get("", response_model=List[schemas.UserOut])
def list_users(db: DB, _user: CurrentUser, include_inactive: bool = False):
    stmt = select(models.User).order_by(models.User.name)
    if not include_inactive:
        stmt = stmt.where(models.User.is_active.is_(True))
    return db.scalars(stmt).all()


@router.post("", response_model=schemas.UserOut, status_code=201)
def create_user(payload: schemas.UserCreate, db: DB, _admin: AdminUser):
    user = models.User(
        name=payload.name, email=payload.email, role=payload.role,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    commit_or_409(db, EMAIL_TAKEN)
    return user


@router.patch("/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: int, payload: schemas.UserUpdate, db: DB, admin: AdminUser):
    user = get_or_404(db, models.User, user_id)
    data = payload.model_dump(exclude_unset=True)

    # Stop admins from locking themselves out.
    if user.id == admin.id and (
        data.get("role", models.UserRole.ADMIN) != models.UserRole.ADMIN
        or data.get("is_active") is False
    ):
        raise HTTPException(400, "You can't demote or deactivate your own account")

    if "password" in data:
        user.password_hash = hash_password(data.pop("password"))
        revoke_tokens(db, user.id)
    if data.get("is_active") is False:
        revoke_tokens(db, user.id)
    for field, value in data.items():
        setattr(user, field, value)

    commit_or_409(db, EMAIL_TAKEN)
    return user
