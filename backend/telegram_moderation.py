"""Telegram group moderation for pending user publications.

The bot token is read only from TELEGRAM_BOT_TOKEN. The webhook secret is
derived from that token; tokens and Telegram API URLs are never logged.
Telegram group admins link the group with /link. Every member of the linked
group may use the one-time approve/reject buttons.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from auth import require_admin

log = logging.getLogger("telegram_moderation")
admin = APIRouter(prefix="/api/admin/telegram-bot", tags=["telegram-bot-admin"], dependencies=[Depends(require_admin)])
webhook = APIRouter(prefix="/api/webhooks/telegram", tags=["telegram-bot-webhook"])
BOT_API = "https://api.telegram.org"
TOKEN_ENV = "TELEGRAM_BOT_TOKEN"
ACTION_TTL = timedelta(days=14)


def _token() -> str:
    return (os.environ.get(TOKEN_ENV) or "").strip()


def _webhook_secret(token: str) -> str:
    return hmac.new(token.encode(), b"spiloveure-telegram-webhook", hashlib.sha256).hexdigest()


def _public_url() -> str:
    return (
        os.environ.get("TELEGRAM_PUBLIC_URL")
        or os.environ.get("PUBLIC_APP_URL")
        or os.environ.get("SITE_URL")
        or ""
    ).rstrip("/")


def _utc_datetime(value) -> Optional[datetime]:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


async def _config(db) -> dict:
    doc = await db.app_settings.find_one({"key": "telegram_moderation"}) or {}
    return doc.get("value") if isinstance(doc.get("value"), dict) else {}


async def _store_config(db, changes: dict) -> dict:
    cfg = await _config(db)
    cfg.update(changes)
    await db.app_settings.update_one(
        {"key": "telegram_moderation"},
        {"$set": {"key": "telegram_moderation", "value": cfg,
                  "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return cfg


async def _bot_call(method: str, payload: dict) -> dict:
    token = _token()
    if not token:
        raise HTTPException(503, "Ajoutez le jeton du bot dans les Secrets du serveur.")
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            response = await client.post(f"{BOT_API}/bot{token}/{method}", json=payload)
        result = response.json()
    except Exception as exc:
        log.warning("Telegram API %s unavailable (%s)", method, type(exc).__name__)
        raise HTTPException(502, f"Telegram est temporairement injoignable ({method}).")
    if response.status_code >= 400 or not isinstance(result, dict) or not result.get("ok"):
        log.warning("Telegram API %s refused request (HTTP %s)", method, response.status_code)
        raise HTTPException(502, f"Telegram a refusé la requête {method}. Vérifiez le bot et ses droits.")
    return result.get("result") or {}


def _safe_media_url(value: str) -> Optional[str]:
    value = str(value or "").strip()
    if value.startswith("/api/uploads/"):
        base = _public_url()
        return f"{base}{value}" if base.startswith("https://") else None
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return None
    try:
        ip = ipaddress.ip_address(parsed.hostname)
        if not ip.is_global:
            return None
    except ValueError:
        host = parsed.hostname.lower()
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            return None
    return value


def _collect_media(item: dict) -> list[tuple[str, str]]:
    raw: list[tuple[str, str]] = []
    for key, default_kind in (
        ("images", "photo"), ("videos", "video"), ("audio", "audio"),
        ("cover_image_url", "photo"), ("video_url", "video"),
        ("documents", "document"), ("document_url", "document"),
        ("pdf_url", "document"), ("files", "document"),
        ("attachments", "document"),
    ):
        values = item.get(key)
        if isinstance(values, str):
            values = [values]
        elif isinstance(values, dict):
            values = [values]
        for entry in values or []:
            value = entry
            kind = default_kind
            if isinstance(entry, dict):
                value = entry.get("url") or entry.get("file_url") or entry.get("src")
                mime = str(entry.get("mime_type") or entry.get("type") or "").lower()
                if mime.startswith("image/"):
                    kind = "photo"
                elif mime.startswith("video/"):
                    kind = "video"
                elif mime.startswith("audio/"):
                    kind = "audio"
                elif "pdf" in mime:
                    kind = "document"
            url = _safe_media_url(value) if isinstance(value, str) else None
            if url:
                ext = PurePosixPath(urlparse(url).path).suffix.lower()
                if ext == ".pdf":
                    kind = "document"
                raw.append((kind, url))
    unique = []
    seen = set()
    for kind, url in raw:
        if url not in seen:
            unique.append((kind, url))
            seen.add(url)
    return unique[:10]


def _summary(kind: str, item: dict) -> str:
    title = item.get("name") if kind == "marketplace" else item.get("title")
    owner = item.get("seller_username") or item.get("username") or item.get("creator_username") or "utilisateur"
    parts = [f"Nouvelle soumission — {kind.replace('_', ' ').title()}",
             f"Publication : {str(title or item.get('action_type') or 'Sans titre')[:180]}",
             f"Auteur : @{str(owner)[:80]}"]
    if kind == "marketplace":
        parts.extend([f"Catégorie : {str(item.get('category') or '—')[:100]}",
                      f"Prix : {item.get('price', 0)} {item.get('currency') or 'FCFA'}",
                      f"Ville : {str(item.get('city') or '—')[:100]}"])
    elif kind == "ads":
        parts.extend([f"Format : {'vidéo' if item.get('video_url') else 'affiche'}",
                      f"Durée : {item.get('duration_days') or '—'} jours"])
    else:
        parts.extend([f"Réseau : {str(item.get('network') or '—')[:60]}",
                      f"Action : {str(item.get('action_type') or '—')[:60]}",
                      f"Quantité : {item.get('quantity_target') or '—'}",
                      f"Montant payé : {item.get('price_amount') or '—'} {item.get('currency') or 'FCFA'}",
                      f"Paiement confirmé : {item.get('payment_reference') or 'oui'}"])
    description = str(item.get("description") or "").strip()
    if description:
        parts.append(f"Description : {description[:700]}")
    if kind == "special_task" and item.get("link"):
        link = _safe_media_url(str(item["link"]))
        if link:
            parts.append(f"Lien de la tâche : {link}")
    parts.append("Le premier vote valide ou rejette la publication pour tout le groupe.")
    if kind == "special_task":
        parts.append("En cas de rejet, un remboursement manuel sera à traiter ; aucun remboursement automatique n’est envoyé.")
    return "\n".join(parts)


async def notify_submission(db, kind: str, item_id: str) -> bool:
    cfg = await _config(db)
    chat_id = cfg.get("group_chat_id")
    if not _token() or not chat_id:
        return False
    source = {"marketplace": "marketplace_listings", "ads": "ads",
              "special_task": "special_tasks"}.get(kind)
    if not source:
        return False
    item = await db[source].find_one({"id": item_id}, {"_id": 0})
    if not item:
        return False
    pending_state = "pending_admin_review"
    if item.get("status") != pending_state:
        return False
    now = datetime.now(timezone.utc)
    await db.telegram_moderation_actions.create_index("subject_key", unique=True)
    prior = await db.telegram_moderation_actions.find_one({"subject_key": f"{kind}:{item_id}"})
    if prior:
        if prior.get("status") != "send_failed":
            return True
    token = secrets.token_urlsafe(18)
    action = {
        "token": token, "subject_key": f"{kind}:{item_id}",
        "kind": kind, "item_id": item_id, "status": "sending",
        "created_at": now, "expires_at": now + ACTION_TTL,
    }
    if prior:
        await db.telegram_moderation_actions.update_one(
            {"_id": prior["_id"], "status": "send_failed"}, {"$set": action})
        if await db.telegram_moderation_actions.find_one({"token": token}) is None:
            return False
    else:
        try:
            await db.telegram_moderation_actions.insert_one(action)
        except Exception:
            return False
    keyboard = {"inline_keyboard": [[
        {"text": "✅ Valider", "callback_data": f"mod:{token}:approve"},
        {"text": "❌ Rejeter", "callback_data": f"mod:{token}:reject"},
    ]]}
    try:
        message = await _bot_call("sendMessage", {
            "chat_id": chat_id, "text": _summary(kind, item),
            "reply_markup": keyboard, "disable_web_page_preview": False,
        })
        await db.telegram_moderation_actions.update_one(
            {"token": token}, {"$set": {"status": "pending", "message_id": message.get("message_id"),
                                         "chat_id": str(chat_id)}})
        for media_kind, url in _collect_media(item):
            try:
                await _bot_call({"photo": "sendPhoto", "video": "sendVideo", "audio": "sendAudio",
                                 "document": "sendDocument"}[media_kind], {
                    "chat_id": chat_id, media_kind: url,
                })
            except HTTPException:
                # Keep the moderation buttons working even when one old or
                # private media URL cannot be fetched by Telegram.
                log.warning("Telegram could not attach one %s file to %s", media_kind, kind)
    except HTTPException:
        await db.telegram_moderation_actions.update_one(
            {"token": token}, {"$set": {"status": "send_failed", "failed_at": datetime.now(timezone.utc)}})
        return False
    return True


async def _notify_safely(db, kind: str, item_id: str) -> None:
    try:
        await notify_submission(db, kind, item_id)
    except Exception as exc:
        log.warning("Telegram notification for %s failed (%s)", kind, type(exc).__name__)


def schedule_submission(db, kind: str, item_id: str) -> None:
    """Dispatch notifications outside payment and publication HTTP requests."""
    asyncio.create_task(_notify_safely(db, kind, item_id))


async def _perform_decision(db, action: dict, decision: str, actor: str) -> str:
    from types import SimpleNamespace
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    operator = {"id": f"telegram:{actor}", "username": f"Telegram {actor}"}
    kind, item_id = action["kind"], action["item_id"]
    if kind == "marketplace":
        import marketplace as module
        if decision == "approve":
            await module.admin_approve(item_id, request, operator)
        else:
            await module.admin_reject(item_id, request, operator)
    elif kind == "ads":
        import ads as module
        if decision == "approve":
            await module.admin_approve(item_id, request, operator)
        else:
            await module.admin_reject(item_id, module.AdRejectReason(reason="Rejeté depuis le groupe Telegram."),
                                      request, operator)
    else:
        from special_tasks import decide_paid_task
        await decide_paid_task(db, item_id, decision, operator["id"])
    return "validated" if decision == "approve" else "rejected"


async def _answer_callback(update: dict, db) -> None:
    query = update.get("callback_query") or {}
    query_id = query.get("id")
    data = str(query.get("data") or "")
    match = __import__("re").fullmatch(r"mod:([A-Za-z0-9_-]{20,32}):(approve|reject)", data)
    if not match:
        await _bot_call("answerCallbackQuery", {"callback_query_id": query_id, "text": "Bouton non reconnu.", "show_alert": True})
        return
    token, decision = match.groups()
    message = query.get("message") or {}
    cfg = await _config(db)
    if str((message.get("chat") or {}).get("id")) != str(cfg.get("group_chat_id")):
        await _bot_call("answerCallbackQuery", {"callback_query_id": query_id, "text": "Groupe non autorisé.", "show_alert": True})
        return
    action = await db.telegram_moderation_actions.find_one(
        {"token": token, "status": "pending", "message_id": message.get("message_id"),
         "chat_id": str(cfg.get("group_chat_id")), "expires_at": {"$gt": datetime.now(timezone.utc)}})
    if not action:
        await _bot_call("answerCallbackQuery", {"callback_query_id": query_id, "text": "Déjà traité ou expiré.", "show_alert": True})
        return
    claim = await db.telegram_moderation_actions.update_one(
        {"token": token, "status": "pending"},
        {"$set": {"status": "processing", "decision": decision,
                  "actor_id": str((query.get("from") or {}).get("id")),
                  "actor_name": str((query.get("from") or {}).get("username") or "")[:100],
                  "decided_at": datetime.now(timezone.utc)}})
    if not claim.modified_count:
        await _bot_call("answerCallbackQuery", {"callback_query_id": query_id, "text": "Un autre membre vient de traiter cette publication.", "show_alert": True})
        return
    try:
        state = await _perform_decision(db, action, decision, str((query.get("from") or {}).get("id") or "unknown"))
    except HTTPException as exc:
        await db.telegram_moderation_actions.update_one(
            {"token": token, "status": "processing"},
            {"$set": {"status": "stale", "error_code": exc.status_code}})
        await _bot_call("answerCallbackQuery", {"callback_query_id": query_id, "text": "La publication n’est plus en attente.", "show_alert": True})
        await _bot_call("editMessageReplyMarkup", {
            "chat_id": cfg.get("group_chat_id"), "message_id": message.get("message_id"),
            "reply_markup": {"inline_keyboard": []}})
        return
    await db.telegram_moderation_actions.update_one(
        {"token": token, "status": "processing"},
        {"$set": {"status": state, "updated_at": datetime.now(timezone.utc)}})
    suffix = "validée" if decision == "approve" else "rejetée"
    await _bot_call("answerCallbackQuery", {"callback_query_id": query_id, "text": f"Publication {suffix}."})
    await _bot_call("editMessageReplyMarkup", {
        "chat_id": cfg.get("group_chat_id"), "message_id": message.get("message_id"),
        "reply_markup": {"inline_keyboard": []}})
    try:
        await _bot_call("sendMessage", {"chat_id": cfg.get("group_chat_id"),
            "text": f"Décision : publication {suffix} par @{((query.get('from') or {}).get('username') or 'membre')}."})
    except HTTPException:
        pass


async def _link_group(update: dict, db) -> None:
    message = update.get("message") or {}
    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    if chat.get("type") not in ("group", "supergroup"):
        return
    text = str(message.get("text") or "").strip()
    _, _, supplied_code = text.partition(" ")
    cfg = await _config(db)
    if cfg.get("group_chat_id") and str(cfg.get("group_chat_id")) != str(chat.get("id")):
        await _bot_call("sendMessage", {"chat_id": chat.get("id"), "text": "Ce groupe n’est pas autorisé à remplacer le groupe SPILOVEURE déjà lié."})
        return
    member = await _bot_call("getChatMember", {"chat_id": chat.get("id"), "user_id": sender.get("id")})
    if member.get("status") not in ("creator", "administrator"):
        await _bot_call("sendMessage", {"chat_id": chat.get("id"), "text": "Seul un administrateur Telegram du groupe peut le relier au bot."})
        return
    expires = _utc_datetime(cfg.get("link_code_expires_at"))
    if (not supplied_code or not cfg.get("link_code")
            or not hmac.compare_digest(supplied_code.strip(), str(cfg.get("link_code")))
            or expires is None
            or expires <= datetime.now(timezone.utc)):
        await _bot_call("sendMessage", {"chat_id": chat.get("id"), "text": "Code de liaison absent ou expiré. Un administrateur SPILOVEURE doit copier le nouveau code dans le panneau d’administration."})
        return
    await _store_config(db, {"group_chat_id": str(chat["id"]), "group_title": str(chat.get("title") or "")[:120],
                             "group_linked_at": datetime.now(timezone.utc)})
    await db.app_settings.update_one(
        {"key": "telegram_moderation"},
        {"$unset": {"value.link_code": "", "value.link_code_expires_at": ""}},
    )
    await _bot_call("sendMessage", {"chat_id": chat["id"], "text":
        "Groupe SPILOVEURE lié. Tous les membres peuvent valider ou rejeter les publications avec les boutons."})


@webhook.post("")
async def telegram_webhook(request: Request,
                           secret: Optional[str] = Header(default=None, alias="X-Telegram-Bot-Api-Secret-Token")):
    token = _token()
    if not token or not secret or not hmac.compare_digest(secret, _webhook_secret(token)):
        raise HTTPException(401, "Webhook Telegram non autorisé.")
    update = await request.json()
    db = request.app.state.db
    if isinstance(update, dict) and update.get("callback_query"):
        await _answer_callback(update, db)
    elif isinstance(update, dict) and str((update.get("message") or {}).get("text") or "").split("@", 1)[0].split(" ", 1)[0].strip() == "/link":
        await _link_group(update, db)
    return JSONResponse({"ok": True})


@admin.get("")
async def admin_get(request: Request):
    cfg = await _config(request.app.state.db)
    now = datetime.now(timezone.utc)
    code_expiry = _utc_datetime(cfg.get("link_code_expires_at"))
    if not cfg.get("group_chat_id") and (
        not cfg.get("link_code") or code_expiry is None or code_expiry <= now
    ):
        cfg = await _store_config(request.app.state.db, {
            "link_code": secrets.token_urlsafe(9),
            "link_code_expires_at": now + timedelta(minutes=15),
        })
    return {
        "token_configured": bool(_token()),
        "group_chat_id": cfg.get("group_chat_id") or "",
        "group_title": cfg.get("group_title") or "",
        "group_link_code": cfg.get("link_code") or "",
        "group_link_code_expires_at": code_expiry.isoformat() if code_expiry else "",
        "webhook_configured": bool(cfg.get("webhook_configured_at")),
        "webhook_url": f"{_public_url()}/api/webhooks/telegram" if _public_url() else "",
        "public_url_configured": _public_url().startswith("https://"),
    }


@admin.post("/configure")
async def admin_configure(request: Request):
    token = _token()
    base = _public_url()
    if not token:
        raise HTTPException(503, f"Ajoutez {TOKEN_ENV} aux Secrets du serveur avant de connecter le bot.")
    if not base.startswith("https://"):
        raise HTTPException(
            503,
            "Configurez TELEGRAM_PUBLIC_URL avec le domaine HTTPS public qui héberge le webhook du bot.",
        )
    url = f"{base}/api/webhooks/telegram"
    result = await _bot_call("setWebhook", {
        "url": url, "secret_token": _webhook_secret(token),
        "allowed_updates": ["message", "callback_query"],
        "drop_pending_updates": False,
    })
    await _store_config(request.app.state.db, {
        "webhook_configured_at": datetime.now(timezone.utc),
        "webhook_url": url,
    })
    return {"ok": True, "webhook_configured": True, "url": url, "result": bool(result)}


@admin.post("/notify-pending")
async def admin_notify_pending(request: Request, kind: str, item_id: str):
    if kind not in ("marketplace", "ads", "special_task"):
        raise HTTPException(400, "Type de publication invalide.")
    sent = await notify_submission(request.app.state.db, kind, item_id)
    if not sent:
        raise HTTPException(409, "Publication non envoyée : vérifiez le webhook, le groupe lié et son statut en attente.")
    return {"ok": True}
