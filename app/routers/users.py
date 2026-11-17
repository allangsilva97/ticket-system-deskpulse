from typing import List, Optional

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import func, select

from app import models, schemas
from app.database import DB
from app.security import AdminUser, StaffUser, hash_password, revoke_tokens
from app.utils import commit_or_409, get_or_404

router = APIRouter(prefix="/api/users", tags=["users"])

EMAIL_TAKEN = "A user with this email already exists"


@router.get("", response_model=List[schemas.UserOut])
def list_users(db: DB, _staff: StaffUser, include_inactive: bool = False,
               role: Optional[models.UserRole] = None):
    stmt = select(models.User).order_by(models.User.name)
    if not include_inactive:
        stmt = stmt.where(models.User.is_active.is_(True))
    if role is not None:
        stmt = stmt.where(models.User.role == role)
    return db.scalars(stmt).all()


@router.post("", response_model=schemas.UserOut, status_code=201)
def create_user(payload: schemas.UserCreate, db: DB, _admin: AdminUser):
    if payload.company_id is not None:
        get_or_404(db, models.Company, payload.company_id)
    user = models.User(
        name=payload.name, email=payload.email, role=payload.role, company_id=payload.company_id,
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

    if data.get("company_id") is not None:
        get_or_404(db, models.Company, data["company_id"])

    if data.pop("reset_two_factor", None):
        user.two_factor_enabled = False
        user.totp_secret = None
        user.totp_last_counter = None

    if "password" in data:
        user.password_hash = hash_password(data.pop("password"))
        revoke_tokens(db, user.id)
    if data.get("is_active") is False:
        revoke_tokens(db, user.id)
    for field, value in data.items():
        setattr(user, field, value)

    commit_or_409(db, EMAIL_TAKEN)
    return user


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, db: DB, admin: AdminUser):
    """Remove an account. Their tickets, comments and assets stay, with the person cleared."""
    user = get_or_404(db, models.User, user_id)
    if user.id == admin.id:
        raise HTTPException(400, "You can't delete your own account")
    if user.role == models.UserRole.ADMIN and user.is_active:
        others = db.scalar(select(func.count(models.User.id)).where(
            models.User.role == models.UserRole.ADMIN, models.User.is_active.is_(True),
            models.User.id != user.id)) or 0
        if not others:
            raise HTTPException(400, "Keep at least one active administrator")
    db.delete(user)
    db.commit()
    return Response(status_code=204)
