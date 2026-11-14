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

# The legacy application requires an admin password at startup. Generate an
# unguessable local-only value without printing, storing or exposing it.
os.environ.setdefault("ADMIN_PASSWORD", secrets.token_urlsafe(48))
os.environ.setdefault("JWT_SECRET", os.environ.get("SESSION_SECRET") or secrets.token_urlsafe(48))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
uvicorn.run("server:app", host="127.0.0.1", port=8000)
