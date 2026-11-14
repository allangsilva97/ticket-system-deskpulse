"""Throttle for failed sign-ins, kept in memory.

Each process keeps its own counts, so with several workers the real limit is higher;
use a shared store (e.g. Redis) if you scale out. Counts reset when the app restarts.
"""
import time
from collections import deque
from threading import Lock
from typing import Deque, Dict, Iterable, Optional, Tuple

from fastapi import HTTPException, Request

from app import config

Rule = Tuple[str, int]  # (counter name, failures allowed inside the window)
_MAX_TRACKED = 10_000   # hard cap on distinct counters, so a flood of fake emails can't grow memory


def client_ip(request: Request) -> str:
    # Behind a reverse proxy, run uvicorn with --proxy-headers so this is the real client, not the proxy.
    return request.client.host if request.client else "unknown"


def login_rules(request: Request, email: str) -> Iterable[Rule]:
    ip, limit = client_ip(request), config.LOGIN_MAX_FAILURES
    return (
        (f"acct:{ip}:{email}", limit),  # one person hammering one account
        (f"ip:{ip}", limit * 4),        # one address trying many accounts
    )


class FailureLimiter:
    def __init__(self) -> None:
        self._hits: Dict[str, Deque[float]] = {}
        self._lock = Lock()

    def _recent(self, key: str, now: float) -> Optional[Deque[float]]:
        hits = self._hits.get(key)
        if hits is None:
            return None
        cutoff = now - config.LOGIN_WINDOW_SECONDS
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if not hits:
            del self._hits[key]
            return None
        return hits

    def check(self, rules: Iterable[Rule]) -> None:
        """Raise 429 if any counter is already at its limit."""
        now = time.monotonic()
        with self._lock:
            for key, limit in rules:
                hits = self._recent(key, now)
                if hits is not None and len(hits) >= limit:
                    wait = max(1, int(hits[0] + config.LOGIN_WINDOW_SECONDS - now) + 1)
                    raise HTTPException(
                        429, "Too many failed attempts. Please wait a few minutes and try again.",
                        headers={"Retry-After": str(wait)},
                    )

    def fail(self, rules: Iterable[Rule]) -> None:
        now = time.monotonic()
        with self._lock:
            if len(self._hits) >= _MAX_TRACKED:
                for key in list(self._hits):
                    self._recent(key, now)  # drops expired counters
            for key, _limit in rules:
                if key in self._hits or len(self._hits) < _MAX_TRACKED:
                    self._hits.setdefault(key, deque()).append(now)

    def clear(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


login_limiter = FailureLimiter()
