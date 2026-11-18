"""Resolve registration sponsorship without changing placement/commission rules."""
import os
import re

from fastapi import HTTPException


async def registration_sponsor(db, supplied: str | None):
    username = (supplied or "").strip()
    if username:
        sponsor = await db.users.find_one({"username": username})
        if not sponsor:
            # Never silently replace a mistyped or obsolete invitation.
            raise HTTPException(400, "Parrain introuvable. Vérifiez votre lien de parrainage.")
        return sponsor
    # ADMIN_EMAIL is the authoritative identity used at server startup.
    email = os.environ.get("ADMIN_EMAIL", "").strip()
    if not email:
        raise HTTPException(503, "Le parrain officiel n’est pas configuré. Contactez l’administration.")
    sponsor = await db.users.find_one({
        "email": {"$regex": "^" + re.escape(email) + "$", "$options": "i"},
        "role": "admin", "status": "active",
    })
    if not sponsor:
        raise HTTPException(503, "Le parrain officiel est indisponible. Contactez l’administration.")
    return sponsor
