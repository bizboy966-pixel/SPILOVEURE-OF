"""AI-powered screenshot verification for Special Tasks.

Uses Gemini 3 Flash (via emergentintegrations + EMERGENT_LLM_KEY) to look at
a user-submitted proof screenshot and decide whether the requested social-
media action was actually performed.

The verifier returns a dict with:
    verified    : bool   — model's yes/no
    confidence  : float  — 0..1
    reason      : str    — short French sentence explaining the verdict

If the model / key is unavailable (env not set, network error, etc.) we
default to `verified=True, confidence=0.55, reason="Vérification IA
indisponible — validation manuelle"` so users are never blocked by an
infra outage. Admins can spot-check via the existing completions panel.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from typing import Any

import httpx
from PIL import Image

log = logging.getLogger("task_verification")

_ACTION_HINTS = {
    "video": "regarder / visionner une vidéo (durée écoulée, lecture en cours, écran vidéo actif)",
    "subscribe": "un abonnement effectué à une chaîne / page / compte (bouton 'Abonné', 'Subscribed', 'Suivi', ou compteur incrémenté visible)",
    "like": "un like actif sur une publication (cœur rouge, pouce bleu, icône colorée à l'état ON)",
    "comment": "un commentaire posté par l'utilisateur (texte visible dans la section commentaires)",
    "share": "un partage effectué (fenêtre de partage, message envoyé, ou confirmation de partage)",
    "group": "avoir rejoint un groupe (bouton 'Rejoindre' devenu 'Membre', 'Quitter', ou liste de membres visible)",
}

_NETWORK_HINTS = {
    "tiktok": "TikTok (application ou site tiktok.com)",
    "facebook": "Facebook (application ou site facebook.com)",
    "instagram": "Instagram (application ou site instagram.com)",
    "youtube": "YouTube (application ou site youtube.com)",
    "whatsapp": "WhatsApp (application ou web.whatsapp.com)",
    "telegram": "Telegram (application ou t.me)",
}


def _extract_json(text: str) -> dict[str, Any] | None:
    """Extract the first JSON object from an LLM response — the model
    sometimes wraps its JSON in markdown fences or prose."""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


async def _download_image_as_base64(url: str, mime_hint: str = "image/jpeg") -> tuple[str, str] | None:
    """Fetch an image URL and return (base64_data, mime_type). Normalises
    animated / exotic formats to PNG so Gemini accepts them."""
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
            raw = r.content
    except Exception as e:
        log.warning("[verify] download failed: %s", e)
        return None
    # Normalise to PNG via PIL (strips animation, honours orientation)
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            # Downscale huge screenshots to keep payload small
            max_side = 1600
            if max(im.size) > max_side:
                im.thumbnail((max_side, max_side))
            buf = io.BytesIO()
            im.save(buf, format="PNG", optimize=True)
            data = buf.getvalue()
            return base64.b64encode(data).decode("ascii"), "image/png"
    except Exception as e:
        log.warning("[verify] image normalisation failed, falling back to raw: %s", e)
        return base64.b64encode(raw).decode("ascii"), mime_hint


async def verify_screenshot(
    *,
    proof_url: str,
    action_type: str,
    network: str,
    link: str,
    description: str | None = None,
) -> dict[str, Any]:
    """Return an AI verdict for the given proof screenshot.

    Never raises. On any failure returns a soft-approve result so a
    single outage cannot block genuine users.
    """
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        return {"verified": True, "confidence": 0.55, "reason": "Vérification IA indisponible."}

    dl = await _download_image_as_base64(proof_url)
    if not dl:
        return {"verified": True, "confidence": 0.55,
                "reason": "Capture illisible — validation manuelle en attente."}
    img_b64, img_mime = dl

    action_hint = _ACTION_HINTS.get(action_type, action_type)
    net_hint = _NETWORK_HINTS.get(network, network)
    desc = (description or "").strip()

    system_prompt = (
        "Tu es un vérificateur automatique de captures d'écran pour SPILOVEURE. "
        "Ton rôle est de déterminer si l'utilisateur a effectivement réalisé l'action demandée "
        "sur le réseau social ciblé. Sois strict et méfiant : les fausses preuves sont fréquentes. "
        "Réponds UNIQUEMENT avec un JSON valide, sans texte autour, au format :\n"
        '{"verified": true|false, "confidence": 0.0-1.0, "reason": "phrase courte en français"}'
    )
    user_prompt = (
        f"ACTION ATTENDUE : {action_hint}\n"
        f"RÉSEAU ATTENDU : {net_hint}\n"
        f"LIEN CIBLE (indicatif) : {link}\n"
        + (f"CONSIGNE DU CRÉATEUR : {desc}\n" if desc else "")
        + "\nAnalyse la capture et détermine si l'action attendue a bien été réalisée sur le bon réseau. "
        "Un simple screenshot de la page d'accueil ou d'un contenu sans l'action ne suffit pas. "
        "Retourne le JSON demandé — rien d'autre."
    )

    try:
        # Lazy-import to keep the module optional at boot.
        from emergentintegrations.llm.chat import (
            ImageContent, LlmChat, UserMessage,
        )
        chat = LlmChat(
            api_key=key,
            session_id=f"verify-{proof_url[-24:]}",
            system_message=system_prompt,
        ).with_model("gemini", "gemini-3-flash-preview")
        msg = UserMessage(
            text=user_prompt,
            file_contents=[ImageContent(image_base64=img_b64, mime_type=img_mime)],
        )
        raw = await chat.send_message(msg)
    except TypeError:
        # Some SDK versions expect no mime_type on ImageContent
        try:
            from emergentintegrations.llm.chat import (
                ImageContent as _IC, LlmChat as _LC, UserMessage as _UM,
            )
            chat = _LC(api_key=key,
                       session_id=f"verify-{proof_url[-24:]}",
                       system_message=system_prompt).with_model("gemini", "gemini-3-flash-preview")
            msg = _UM(text=user_prompt, file_contents=[_IC(image_base64=img_b64)])
            raw = await chat.send_message(msg)
        except Exception as e:
            log.warning("[verify] LLM call failed: %s", e)
            return {"verified": True, "confidence": 0.55,
                    "reason": "Vérification IA indisponible — accordée par défaut."}
    except Exception as e:
        log.warning("[verify] LLM call failed: %s", e)
        return {"verified": True, "confidence": 0.55,
                "reason": "Vérification IA indisponible — accordée par défaut."}

    # `raw` may be a string or a ChatMessage/response object depending on SDK
    text = raw if isinstance(raw, str) else getattr(raw, "text", str(raw))
    parsed = _extract_json(text) or {}
    verified = bool(parsed.get("verified", False))
    try:
        confidence = float(parsed.get("confidence", 0.0))
    except Exception:
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    reason = str(parsed.get("reason") or ("Vérification IA : action détectée." if verified
                                          else "L'action attendue n'est pas visible."))[:280]
    return {"verified": verified, "confidence": confidence, "reason": reason}
