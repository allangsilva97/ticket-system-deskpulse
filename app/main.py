from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import DataError

from app import config
from app.database import init_db
from app.routers import assets, auth, companies, stats, tickets, users

STATIC_DIR = config.APP_DIR / "static"        # the admin console (/console)
DESKPULSE_DIR = config.PROJECT_DIR / "deskpulse"  # the DeskPulse portal (/)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Ticket System", version="2.0.0", lifespan=lifespan,
    docs_url="/docs" if config.ENABLE_DOCS else None,
    redoc_url="/redoc" if config.ENABLE_DOCS else None,
    openapi_url="/openapi.json" if config.ENABLE_DOCS else None,
)

# Only our own scripts and styles may run. The one inline style (the dashboard bar widths) is allowed by style-src-attr.
CSP = "; ".join([
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:", "connect-src 'self'", "object-src 'none'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
])
# DeskPulse builds its styles at runtime with the Tailwind CDN, which needs inline styles; icons and the font
# come from two CDNs. Scripts are still limited to our own files and those two hosts.
DESKPULSE_CSP = "; ".join([
    "default-src 'none'", "script-src 'self' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "font-src https://cdnjs.cloudflare.com https://fonts.gstatic.com", "img-src 'self' data:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
])
DESKPULSE_PATHS = ("/deskpulse",)  # plus "/" itself
DOC_PATHS = ("/docs", "/redoc")  # Swagger UI and ReDoc load their scripts from a CDN, so this policy would break them


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    headers = response.headers
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Referrer-Policy", "same-origin")
    headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    path = request.url.path
    if path == "/" or path.startswith(DESKPULSE_PATHS):
        headers.setdefault("Content-Security-Policy", DESKPULSE_CSP)
    elif not path.startswith(DOC_PATHS):
        headers.setdefault("Content-Security-Policy", CSP)
    if request.url.path.startswith("/api/"):
        headers.setdefault("Cache-Control", "no-store")  # tickets and user lists shouldn't sit in a shared cache
    if request.url.scheme == "https":
        headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.exception_handler(OverflowError)
@app.exception_handler(DataError)
async def out_of_range(_request: Request, _exc: Exception):
    # An id like 99999999999999999999 passes int validation but doesn't fit a database integer:
    # SQLite raises OverflowError, PostgreSQL a DataError. Either way it's bad input, not a crash.
    return JSONResponse(status_code=422, content={"detail": "A numeric value is out of range"})


for module in (auth, users, companies, assets, tickets, stats):
    app.include_router(module.router)


@app.get("/api/health", tags=["health"])
def health():
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/deskpulse", StaticFiles(directory=DESKPULSE_DIR), name="deskpulse")


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def index():
    page = DESKPULSE_DIR / "index.html"
    if page.is_file():
        return FileResponse(page)
    return HTMLResponse("<h1>Ticket System</h1><p>See <a href='/docs'>/docs</a>.</p>")


@app.api_route("/console", methods=["GET", "HEAD"], include_in_schema=False)
def console():
    """The original administrator console, kept next to DeskPulse."""
    return FileResponse(STATIC_DIR / "index.html")
