"""Time-based one-time passwords (RFC 6238), standard library only.

Compatible with Google Authenticator, Authy, 1Password and the like (SHA-1, 6 digits, 30 s).
"""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from typing import Optional
from urllib.parse import quote

STEP = 30
DIGITS = 6


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _code(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    number = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(number % 10 ** DIGITS).zfill(DIGITS)


def match(secret: str, code: str, now: Optional[float] = None, window: int = 1) -> Optional[int]:
    """Return the time step the code belongs to, or None. Allows `window` steps of clock drift."""
    counter = int((time.time() if now is None else now) // STEP)
    for step in range(counter - window, counter + window + 1):
        if hmac.compare_digest(_code(secret, step), code):
            return step
    return None


def otpauth_uri(secret: str, account: str, issuer: str) -> str:
    return (f"otpauth://totp/{quote(issuer)}:{quote(account)}"
            f"?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits={DIGITS}&period={STEP}")
