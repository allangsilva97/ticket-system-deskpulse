import enum
from datetime import datetime
from typing import List, Optional

from sqlalchemy import BigInteger, Boolean, Enum as SQLEnum, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, UTCDateTime
from app.utils import utcnow


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    TECHNICIAN = "technician"
    USER = "user"  # end user: opens tickets and follows their own, nothing else


STAFF_ROLES = (UserRole.ADMIN, UserRole.TECHNICIAN)


class TicketStatus(str, enum.Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    WAITING = "waiting"  # waiting on the customer / a third party
    RESOLVED = "resolved"
    CLOSED = "closed"


DONE_STATUSES = (TicketStatus.RESOLVED, TicketStatus.CLOSED)  # no more work expected


class TicketPriority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class TicketCategory(str, enum.Enum):
    HARDWARE = "hardware"
    SOFTWARE = "software"
    NETWORK = "network"
    ACCESS_SECURITY = "access_security"
    OTHER = "other"


class AssetType(str, enum.Enum):
    LAPTOP = "laptop"
    DESKTOP = "desktop"
    PRINTER = "printer"
    SERVER = "server"
    SOFTWARE_LICENSE = "software_license"
    NETWORK = "network"


class AssetStatus(str, enum.Enum):
    IN_USE = "in_use"
    STOCK = "stock"
    MAINTENANCE = "maintenance"
    RETIRED = "retired"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(SQLEnum(UserRole), default=UserRole.USER)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # The company an end user belongs to; the tickets they open are filed under it.
    company_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True
    )
    # Two-factor (TOTP). The secret exists from setup on, but only counts once enabled.
    totp_secret: Mapped[Optional[str]] = mapped_column(String(64))
    two_factor_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_last_counter: Mapped[Optional[int]] = mapped_column(BigInteger)  # blocks replaying a used code
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    company: Mapped[Optional["Company"]] = relationship(foreign_keys=[company_id])
    tokens: Mapped[List["AuthToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def is_staff(self) -> bool:
        return self.role in STAFF_ROLES


class AuthToken(Base):
    """A sign-in session. Only a SHA-256 of the token is stored, never the token itself."""

    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())

    user: Mapped[User] = relationship(back_populates="tokens")


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    email: Mapped[Optional[str]] = mapped_column(String(255))
    phone: Mapped[Optional[str]] = mapped_column(String(50))
    address: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    tickets: Mapped[List["Ticket"]] = relationship(
        back_populates="company", cascade="all, delete-orphan"
    )


class Asset(Base):
    """A piece of equipment or a licence in the inventory (CMDB)."""

    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    type: Mapped[AssetType] = mapped_column(SQLEnum(AssetType), index=True)
    serial: Mapped[Optional[str]] = mapped_column(String(100), unique=True)
    status: Mapped[AssetStatus] = mapped_column(
        SQLEnum(AssetStatus), default=AssetStatus.STOCK, index=True
    )
    assigned_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # Where it lives when no person holds it: "Rack 4", "3rd floor hallway", a department...
    location: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    assigned_user: Mapped[Optional[User]] = relationship(foreign_keys=[assigned_user_id])

    @property
    def code(self) -> str:
        return f"AST-{self.id}"


class Ticket(Base):
    __tablename__ = "tickets"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[TicketStatus] = mapped_column(
        SQLEnum(TicketStatus), default=TicketStatus.OPEN, index=True
    )
    # Set by technicians when they triage; whoever opens the ticket doesn't choose it.
    priority: Mapped[Optional[TicketPriority]] = mapped_column(SQLEnum(TicketPriority), index=True)
    category: Mapped[TicketCategory] = mapped_column(
        SQLEnum(TicketCategory), default=TicketCategory.OTHER, index=True
    )
    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    assignee_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_by_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # The person who reported it, and the equipment it is about
    requester_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    asset_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("assets.id", ondelete="SET NULL"), index=True
    )

    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)
    due_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), index=True)  # none until a priority is set
    resolved_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())  # when it first reached resolved/closed

    company: Mapped[Company] = relationship(back_populates="tickets")
    assignee: Mapped[Optional[User]] = relationship(foreign_keys=[assignee_id])
    created_by: Mapped[Optional[User]] = relationship(foreign_keys=[created_by_id])
    requester: Mapped[Optional[User]] = relationship(foreign_keys=[requester_id])
    asset: Mapped[Optional[Asset]] = relationship()
    comments: Mapped[List["Comment"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="Comment.id"
    )
    events: Mapped[List["TicketEvent"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="TicketEvent.id"
    )

    @property
    def code(self) -> str:
        return f"TK-{self.id}"

    @property
    def is_overdue(self) -> bool:
        return (
            self.due_at is not None
            and self.status not in DONE_STATUSES
            and self.due_at < utcnow()
        )


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    body: Mapped[str] = mapped_column(Text)
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False)  # staff-only note
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    ticket: Mapped[Ticket] = relationship(back_populates="comments")
    author: Mapped[Optional[User]] = relationship()


class TicketEvent(Base):
    """Audit trail: who changed what on a ticket, and when."""

    __tablename__ = "ticket_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), index=True)
    actor_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # created | status | priority | category | assignee | requester | company | asset | title | comment
    field: Mapped[str] = mapped_column(String(30))
    old_value: Mapped[Optional[str]] = mapped_column(String(255))
    new_value: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    ticket: Mapped[Ticket] = relationship(back_populates="events")
    actor: Mapped[Optional[User]] = relationship()
