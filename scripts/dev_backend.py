"""Local-only launcher. Never connects to the VPS or imports production data."""
import os
import secrets
import sys
from pathlib import Path

import uvicorn

if os.environ.get("DB_NAME") != "spiloveure_local_development":
    raise SystemExit("Refus : ce lanceur est réservé à la base locale de développement.")
if os.environ.get("MONGO_URL") != "mongodb://127.0.0.1:27017":
    raise SystemExit("Refus : MongoDB doit être local.")
if os.environ.get("SPV_PREVIEW_MODE") != "isolated":
    raise SystemExit("Refus : le mode de preview isolé doit être explicitement activé.")

# The legacy application requires an admin password at startup. Generate an
# unguessable local-only value without printing, storing or exposing it.
os.environ.setdefault("ADMIN_PASSWORD", secrets.token_urlsafe(48))
os.environ.setdefault("ADMIN_USERNAME", "preview_admin_local")
os.environ.setdefault("ADMIN_EMAIL", "preview_admin_local@example.test")
os.environ.setdefault("ADMIN_PHONE", "00000001")
os.environ.setdefault("JWT_SECRET", os.environ.get("SESSION_SECRET") or secrets.token_urlsafe(48))
os.environ["SPV_ISOLATED_CHAT_PREVIEW"] = "1"
# Never let preview registrations or password recovery send real email.
os.environ["MAIL_PROVIDER"] = "disabled"
os.environ["MAIL_DOMAIN_VERIFIED"] = "0"
os.environ.pop("MAIL_RESEND_DOMAIN_ID", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
uvicorn.run("server:app", host="127.0.0.1", port=8000)
