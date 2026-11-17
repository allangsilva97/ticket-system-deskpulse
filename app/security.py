"""Password hashing and bearer-token sessions, using only the standard library."""
import hashlib
import hmac
import secrets
from datetime import timedelta
from functools import lru_cache
from typing import Annotated, Optional

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import config, models
from app.database import DB
from app.utils import utcnow


# ---------- Passwords (PBKDF2-SHA256, salted) ----------

def hash_password(password: str, iterations: Optional[int] = None) -> str:
    iterations = iterations or config.PASSWORD_HASH_ITERATIONS
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, iterations, salt, expected = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    return hash_password("not-a-real-password")


def burn_password_check(password: str) -> None:
    """Spend the same time as a real check, so response time doesn't reveal which emails exist."""
    verify_password(password, _dummy_hash())


# ---------- Tokens ----------

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(db: Session, user: models.User) -> str:
    raw = secrets.token_urlsafe(32)
    now = utcnow()
    db.execute(  # tidy up this user's expired sessions
        delete(models.AuthToken).where(
            models.AuthToken.user_id == user.id, models.AuthToken.expires_at < now
        )
    )
    db.add(models.AuthToken(
        token_hash=hash_token(raw),
        user=user,
        expires_at=now + timedelta(hours=config.TOKEN_TTL_HOURS),
    ))
    return raw


def revoke_tokens(db: Session, user_id: int, keep_id: Optional[int] = None) -> None:
    stmt = delete(models.AuthToken).where(models.AuthToken.user_id == user_id)
    if keep_id is not None:
        stmt = stmt.where(models.AuthToken.id != keep_id)
    db.execute(stmt)


# ---------- Dependencies ----------

_bearer = HTTPBearer(auto_error=False)


def _unauthorized() -> HTTPException:
    return HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})


def get_current_token(
    db: DB,
    creds: Annotated[Optional[HTTPAuthorizationCredentials], Depends(_bearer)],
) -> models.AuthToken:
    if creds is None:
        raise _unauthorized()
    token = db.scalar(
        select(models.AuthToken).where(models.AuthToken.token_hash == hash_token(creds.credentials))
    )
    if token is None or token.expires_at <= utcnow() or not token.user.is_active:
        raise _unauthorized()
    return token


def get_current_user(token: Annotated[models.AuthToken, Depends(get_current_token)]) -> models.User:
    return token.user


CurrentToken = Annotated[models.AuthToken, Depends(get_current_token)]
CurrentUser = Annotated[models.User, Depends(get_current_user)]


def require_admin(user: CurrentUser) -> models.User:
    if user.role != models.UserRole.ADMIN:
        raise HTTPException(403, "Admins only")
    return user


AdminUser = Annotated[models.User, Depends(require_admin)]


def require_staff(user: CurrentUser) -> models.User:
    """Administrators and technicians. End users never get past this."""
    if not user.is_staff:
        raise HTTPException(403, "Technicians only")
    return user


StaffUser = Annotated[models.User, Depends(require_staff)]
