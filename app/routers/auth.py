import hmac
from typing import Annotated, Optional

from fastapi import APIRouter, Header, HTTPException, Request, Response
from sqlalchemy import func, select

from app import config, models, schemas, totp
from app.database import DB
from app.ratelimit import client_ip, login_limiter, login_rules
from app.security import (
    CurrentToken, CurrentUser, burn_password_check, hash_password, issue_token,
    revoke_tokens, verify_password,
)
from app.utils import commit_or_409

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_count(db) -> int:
    return db.scalar(select(func.count(models.User.id))) or 0


@router.get("/setup-status")
def setup_status(db: DB):
    """`needs_setup` is true until the first admin exists; `setup_token_required` says to ask for the setup code."""
    return {"needs_setup": _user_count(db) == 0, "setup_token_required": bool(config.SETUP_TOKEN)}


@router.post("/setup", response_model=schemas.TokenOut, status_code=201)
def setup(
    payload: schemas.SetupIn, request: Request, db: DB,
    x_setup_token: Annotated[Optional[str], Header()] = None,
):
    """Create the first admin. Only works while there are no users."""
    if _user_count(db) > 0:
        raise HTTPException(409, "Setup is already complete. Please sign in.")
    if config.SETUP_TOKEN:
        rules = [(f"setup:{client_ip(request)}", config.LOGIN_MAX_FAILURES)]
        login_limiter.check(rules)
        if not hmac.compare_digest((x_setup_token or "").encode(), config.SETUP_TOKEN.encode()):
            login_limiter.fail(rules)
            raise HTTPException(403, "Invalid setup code")
    user = models.User(
        name=payload.name, email=payload.email,
        password_hash=hash_password(payload.password), role=models.UserRole.ADMIN,
    )
    db.add(user)
    db.flush()
    token = issue_token(db, user)
    commit_or_409(db, "Setup is already complete. Please sign in.")
    return schemas.TokenOut(token=token, user=schemas.UserOut.model_validate(user))


@router.post("/login", response_model=schemas.TokenOut)
def login(payload: schemas.LoginIn, request: Request, db: DB):
    rules = list(login_rules(request, payload.email))
    login_limiter.check(rules)  # before the slow hash, so a locked-out client can't burn CPU either
    user = db.scalar(select(models.User).where(models.User.email == payload.email))
    if user is None:
        burn_password_check(payload.password)
    if user is None or not verify_password(payload.password, user.password_hash) or not user.is_active:
        login_limiter.fail(rules)
        raise HTTPException(401, "Invalid email or password")  # same message: don't reveal which part was wrong
    if user.two_factor_enabled:
        if payload.otp is None:  # password was right: ask for the second factor (not a failed attempt)
            raise HTTPException(401, "Two-factor code required", headers={"X-2FA-Required": "true"})
        if not _use_code(user, payload.otp):
            login_limiter.fail(rules)
            raise HTTPException(401, "Invalid two-factor code")
    login_limiter.clear(rules[0][0])
    token = issue_token(db, user)
    db.commit()
    return schemas.TokenOut(token=token, user=schemas.UserOut.model_validate(user))


def _use_code(user: models.User, code: str) -> bool:
    """Check a TOTP code and remember the step, so the same code can't be used twice."""
    if not user.totp_secret:
        return False
    step = totp.match(user.totp_secret, code)
    if step is None or (user.totp_last_counter is not None and step <= user.totp_last_counter):
        return False
    user.totp_last_counter = step
    return True


@router.post("/logout", status_code=204)
def logout(token: CurrentToken, db: DB):
    db.delete(token)
    db.commit()
    return Response(status_code=204)


@router.get("/me", response_model=schemas.UserOut)
def me(user: CurrentUser):
    return user


@router.patch("/me", response_model=schemas.UserOut)
def update_me(payload: schemas.MeUpdate, user: CurrentUser, token: CurrentToken, db: DB):
    if payload.name is not None:
        user.name = payload.name
    if payload.new_password is not None:
        if not payload.current_password or not verify_password(payload.current_password, user.password_hash):
            raise HTTPException(400, "Current password is incorrect")
        user.password_hash = hash_password(payload.new_password)
        revoke_tokens(db, user.id, keep_id=token.id)  # sign out other devices
    db.commit()
    return user


# ---------- Two-factor (TOTP) ----------

def _2fa_rules(request: Request, user: models.User):
    return [(f"2fa:{client_ip(request)}:{user.id}", config.LOGIN_MAX_FAILURES)]


@router.post("/2fa/setup", response_model=schemas.TwoFactorSetupOut)
def two_factor_setup(user: CurrentUser, db: DB):
    """Start enrolling: returns the secret to scan. It only counts after /2fa/enable confirms a code."""
    if user.two_factor_enabled:
        raise HTTPException(409, "Two-factor is already on. Turn it off first to enrol a new device.")
    user.totp_secret = totp.new_secret()
    user.totp_last_counter = None
    db.commit()
    return schemas.TwoFactorSetupOut(
        secret=user.totp_secret,
        otpauth_uri=totp.otpauth_uri(user.totp_secret, user.email, config.TOTP_ISSUER),
    )


@router.post("/2fa/enable", response_model=schemas.UserOut)
def two_factor_enable(payload: schemas.TwoFactorCode, request: Request, user: CurrentUser, db: DB):
    if user.two_factor_enabled:
        raise HTTPException(409, "Two-factor is already on")
    if not user.totp_secret:
        raise HTTPException(400, "Start with /2fa/setup")
    rules = _2fa_rules(request, user)
    login_limiter.check(rules)
    if not _use_code(user, payload.code):
        login_limiter.fail(rules)
        raise HTTPException(400, "Invalid two-factor code")
    user.two_factor_enabled = True
    db.commit()
    return user


@router.post("/2fa/disable", response_model=schemas.UserOut)
def two_factor_disable(payload: schemas.TwoFactorDisable, request: Request, user: CurrentUser, db: DB):
    """Needs the password and a current code, so a stolen session alone can't switch it off."""
    if not user.two_factor_enabled:
        raise HTTPException(409, "Two-factor is not on")
    rules = _2fa_rules(request, user)
    login_limiter.check(rules)
    if not verify_password(payload.password, user.password_hash) or not _use_code(user, payload.code):
        login_limiter.fail(rules)
        raise HTTPException(400, "Wrong password or code")
    user.two_factor_enabled = False
    user.totp_secret = None
    user.totp_last_counter = None
    db.commit()
    return user
