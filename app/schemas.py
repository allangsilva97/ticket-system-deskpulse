from datetime import datetime
from typing import Annotated, Dict, List, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field, StringConstraints, field_validator

from app.models import AssetStatus, AssetType, TicketCategory, TicketPriority, TicketStatus, UserRole

# ---------- Reusable field types ----------
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20_000)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, max_length=50)]
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]  # never stripped
Email = Annotated[EmailStr, AfterValidator(lambda v: v.lower())]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def _not_null(v, info):
    # Validators don't run on defaults, so this only fires for an explicit `null`.
    if v is None:
        raise ValueError(f"{info.field_name} cannot be null")
    return v


# ---------- Auth & users ----------

class UserSummary(_Out):
    id: int
    name: str


class UserOut(_Out):
    id: int
    name: str
    email: str
    role: UserRole
    is_active: bool
    company_id: Optional[int] = None
    two_factor_enabled: bool = False
    created_at: datetime


class SetupIn(_In):
    name: Name
    email: Email
    password: Password


class LoginIn(_In):
    email: Email
    password: Annotated[str, StringConstraints(max_length=128)]
    otp: Optional[Annotated[str, StringConstraints(pattern=r"^\d{6}$")]] = None  # needed only with two-factor on


class TwoFactorSetupOut(BaseModel):
    secret: str
    otpauth_uri: str


class TwoFactorCode(_In):
    code: Annotated[str, StringConstraints(pattern=r"^\d{6}$")]


class TwoFactorDisable(_In):
    password: Annotated[str, StringConstraints(max_length=128)]
    code: Annotated[str, StringConstraints(pattern=r"^\d{6}$")]


class TokenOut(BaseModel):
    token: str
    user: UserOut


class MeUpdate(_In):
    name: Optional[Name] = None
    current_password: Optional[Annotated[str, StringConstraints(max_length=128)]] = None  # same cap as login
    new_password: Optional[Password] = None

    _nn = field_validator("name")(_not_null)


class UserCreate(_In):
    name: Name
    email: Email
    password: Password
    role: UserRole = UserRole.USER
    company_id: Optional[int] = None


class UserUpdate(_In):
    name: Optional[Name] = None
    email: Optional[Email] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None
    password: Optional[Password] = None
    company_id: Optional[int] = None  # explicit null = no company
    reset_two_factor: Optional[bool] = None  # true = switch their 2FA off (lost phone); they enrol again

    _nn = field_validator("name", "email", "role", "is_active", "password")(_not_null)


# ---------- Companies ----------

class CompanyCreate(_In):
    name: Name
    email: Optional[Email] = None
    phone: Optional[Phone] = None
    address: Optional[LongText] = None


class CompanyUpdate(_In):
    name: Optional[Name] = None
    email: Optional[Email] = None
    phone: Optional[Phone] = None
    address: Optional[LongText] = None

    _nn = field_validator("name")(_not_null)


class CompanySummary(_Out):
    id: int
    name: str


class CompanyOut(_Out):
    id: int
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    ticket_count: int = 0
    open_ticket_count: int = 0
    created_at: datetime
    updated_at: datetime


# ---------- Assets ----------

Serial = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class AssetCreate(_In):
    name: Name
    type: AssetType
    serial: Optional[Serial] = None
    status: AssetStatus = AssetStatus.STOCK
    assigned_user_id: Optional[int] = None
    location: Optional[Name] = None


class AssetUpdate(_In):
    name: Optional[Name] = None
    type: Optional[AssetType] = None
    serial: Optional[Serial] = None
    status: Optional[AssetStatus] = None
    assigned_user_id: Optional[int] = None  # explicit null = nobody
    location: Optional[Name] = None

    _nn = field_validator("name", "type", "status")(_not_null)


class AssetSummary(_Out):
    id: int
    code: str
    name: str


class AssetOut(AssetSummary):
    type: AssetType
    serial: Optional[str] = None
    status: AssetStatus
    assigned_user: Optional[UserSummary] = None
    location: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class AssetPage(BaseModel):
    items: List[AssetOut]
    total: int
    page: int
    page_size: int


# ---------- Tickets ----------

class TicketCreate(_In):
    """What whoever opens a ticket may fill in.

    End users can only send title, description, category and asset: the company and requester
    come from their account, and `priority`, `assignee_id` and `requester_id` are for technicians.
    """

    title: Name
    description: Optional[LongText] = None
    category: TicketCategory = TicketCategory.OTHER
    asset_id: Optional[int] = None
    company_id: Optional[int] = None    # technicians only (end users file under their own company)
    requester_id: Optional[int] = None  # technicians only: who the ticket is for
    assignee_id: Optional[int] = None   # technicians only
    priority: Optional[TicketPriority] = None  # technicians only


class TicketUpdate(_In):
    title: Optional[Name] = None
    description: Optional[LongText] = None
    status: Optional[TicketStatus] = None
    priority: Optional[TicketPriority] = None
    category: Optional[TicketCategory] = None
    company_id: Optional[int] = None
    assignee_id: Optional[int] = None   # explicit null = unassign
    requester_id: Optional[int] = None  # explicit null = nobody
    asset_id: Optional[int] = None      # explicit null = no asset

    _nn = field_validator("title", "status", "priority", "category", "company_id")(_not_null)


class TicketBulkUpdate(_In):
    ids: Annotated[List[int], Field(min_length=1, max_length=500)]
    status: Optional[TicketStatus] = None
    priority: Optional[TicketPriority] = None
    assignee_id: Optional[int] = None  # explicit null = unassign

    _nn = field_validator("status", "priority")(_not_null)


class BulkResult(BaseModel):
    updated: int


class CommentCreate(_In):
    body: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20_000)]
    is_internal: bool = False


class CommentOut(_Out):
    id: int
    body: str
    is_internal: bool
    author: Optional[UserSummary] = None
    created_at: datetime


class EventOut(_Out):
    id: int
    field: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    actor: Optional[UserSummary] = None
    created_at: datetime


class TicketListItem(_Out):
    id: int
    code: str
    title: str
    status: TicketStatus
    priority: Optional[TicketPriority] = None  # none until a technician triages it
    category: TicketCategory
    company: CompanySummary
    requester: Optional[UserSummary] = None
    assignee: Optional[UserSummary] = None
    assignee_id: Optional[int] = None
    asset_id: Optional[int] = None
    due_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    is_overdue: bool
    created_at: datetime
    updated_at: datetime


class TicketOut(TicketListItem):
    description: Optional[str] = None
    company_id: int
    requester_id: Optional[int] = None
    asset: Optional[AssetSummary] = None
    created_by: Optional[UserSummary] = None
    comments: List[CommentOut] = []
    events: List[EventOut] = []


class TicketPage(BaseModel):
    items: List[TicketListItem]
    total: int
    page: int
    page_size: int


# ---------- Stats ----------

class ActivityItem(BaseModel):
    id: int
    ticket_id: int
    ticket_code: str
    ticket_title: str
    field: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    actor_name: Optional[str] = None
    created_at: datetime


class Stats(BaseModel):
    total_tickets: int
    active_tickets: int
    by_status: Dict[str, int]
    by_priority: Dict[str, int]  # active tickets that have a priority
    unprioritized: int           # active tickets still waiting for triage
    total_assets: int
    assets_by_status: Dict[str, int]
    overdue: int
    unassigned: int
    mine: int
    total_companies: int
    avg_resolution_hours: Optional[float] = None
    recent_activity: List[ActivityItem]
