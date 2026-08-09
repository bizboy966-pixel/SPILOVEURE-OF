"""Helper module — fire-and-forget push notifications from anywhere in the
codebase (ads, marketplace, comments, ...).

Everything is best-effort — a failure to send a push MUST NEVER break the
underlying business flow (comment creation, ad approval, etc.). Exceptions
are logged and swallowed.
"""
from __future__ import annotations

import logging
import os
from typing import Iterable, Optional

import firebase_admin
from firebase_admin import messaging

log = logging.getLogger("push_helper")

# Public URL of the app — used to convert every relative link (like
# `/(app)/ads`) to a fully-qualified HTTPS URL, as required by Firebase's
# `WebpushFCMOptions.link` validator.
_PUBLIC_APP_URL: str = (
    os.environ.get("PUBLIC_APP_URL")
    or os.environ.get("REACT_APP_BACKEND_URL")
    or "https://spiloveure.com"
).rstrip("/")


def _absolute_link(link: Optional[str]) -> Optional[str]:
    if not link:
        return None
    if link.startswith(("http://", "https://")):
        return link
    if not link.startswith("/"):
        link = "/" + link
    return f"{_PUBLIC_APP_URL}{link}"


async def _tokens_for_users(db, user_ids: Iterable[str]) -> list[str]:
    ids = [u for u in user_ids if u]
    if not ids:
        return []
    tokens: list[str] = []
    async for t in db.push_tokens.find(
        {"user_id": {"$in": ids}}, {"_id": 0, "token": 1}
    ):
        tok = t.get("token")
        if tok:
            tokens.append(tok)
    return tokens


async def _tokens_for_all(db, only_activated: bool = False) -> list[str]:
    """All registered device tokens.
    If `only_activated=True`, restrict to users with max_level >= 1 —
    matches the product rule that non-activated users don't see ads /
    marketplace anyway.
    """
    q_users: dict = {}
    if only_activated:
        q_users["max_level"] = {"$gte": 1}
    if q_users:
        allowed = [u["id"] async for u in db.users.find(q_users, {"_id": 0, "id": 1})]
        return await _tokens_for_users(db, allowed)
    tokens: list[str] = []
    async for t in db.push_tokens.find({}, {"_id": 0, "token": 1}):
        tok = t.get("token")
        if tok:
            tokens.append(tok)
    return tokens


async def _send(
    db, tokens: list[str], *, title: str, body: str,
    link: Optional[str] = None, data: Optional[dict] = None,
    tag: Optional[str] = None,
) -> dict:
    if not tokens:
        log.info("push %r: no tokens registered — skipping", title)
        return {"requested": 0, "success": 0, "failure": 0, "removed_invalid": 0}
    if not firebase_admin._apps:
        log.warning("Firebase Admin not initialised — dropping push %r", title)
        return {"requested": len(tokens), "success": 0, "failure": len(tokens),
                "removed_invalid": 0, "error": "firebase_not_init"}
    log.info("push %r → dispatching to %d tokens", title, len(tokens))

    data_payload = {str(k): str(v) for k, v in (data or {}).items()}
    # Firebase requires an absolute HTTPS URL — coerce relative paths.
    abs_link = _absolute_link(link)
    if abs_link:
        data_payload.setdefault("link", abs_link)
    if tag:
        data_payload.setdefault("tag", tag)

    webpush = messaging.WebpushConfig(
        fcm_options=messaging.WebpushFCMOptions(link=abs_link) if abs_link else None,
        notification=messaging.WebpushNotification(
            title=title, body=body, icon="/icon-192.png", tag=tag or "spiloveure",
        ),
    )

    success = 0
    failure = 0
    dead: list[str] = []
    for i in range(0, len(tokens), 500):
        batch = tokens[i:i + 500]
        try:
            resp = messaging.send_each_for_multicast(
                messaging.MulticastMessage(
                    tokens=batch,
                    notification=messaging.Notification(title=title, body=body),
                    data=data_payload,
                    webpush=webpush,
                )
            )
        except Exception as e:
            log.exception("push batch failed: %s", e)
            failure += len(batch)
            continue
        success += resp.success_count
        failure += resp.failure_count
        for tok, r in zip(batch, resp.responses):
            if r.success:
                continue
            exc = r.exception
            msg = str(exc).lower() if exc else ""
            # Prune tokens that FCM confirms are dead / invalid strings.
            if (isinstance(exc, (
                    messaging.UnregisteredError,
                    messaging.SenderIdMismatchError,
                ))
                or "registration-token-not-registered" in msg
                or "not a valid fcm registration token" in msg
                or "invalid registration" in msg):
                dead.append(tok)

    if dead:
        await db.push_tokens.delete_many({"token": {"$in": dead}})
        log.info("push %r: pruned %d invalid tokens", title, len(dead))

    result = {
        "requested": len(tokens), "success": success, "failure": failure,
        "removed_invalid": len(dead),
    }
    log.info("push %r result: %s", title, result)
    return result


# ─── Public API ──────────────────────────────────────────────────────────
async def push_to_user(db, user_id: str, *, title: str, body: str,
                       link: Optional[str] = None, data: Optional[dict] = None,
                       tag: Optional[str] = None) -> dict:
    try:
        tokens = await _tokens_for_users(db, [user_id])
        return await _send(db, tokens, title=title, body=body,
                           link=link, data=data, tag=tag)
    except Exception as e:
        log.exception("push_to_user failed: %s", e)
        return {"error": str(e), "requested": 0}


async def push_to_users(db, user_ids: Iterable[str], *, title: str, body: str,
                        link: Optional[str] = None, data: Optional[dict] = None,
                        tag: Optional[str] = None) -> dict:
    try:
        tokens = await _tokens_for_users(db, user_ids)
        return await _send(db, tokens, title=title, body=body,
                           link=link, data=data, tag=tag)
    except Exception as e:
        log.exception("push_to_users failed: %s", e)
        return {"error": str(e), "requested": 0}


async def push_to_activated(db, *, title: str, body: str,
                            link: Optional[str] = None,
                            data: Optional[dict] = None,
                            tag: Optional[str] = None,
                            exclude_user_id: Optional[str] = None) -> dict:
    """Broadcast to every ACTIVATED user (max_level>=1).
    Optionally excludes one user (typically the author of the event).
    """
    try:
        q_users: dict = {"max_level": {"$gte": 1}}
        if exclude_user_id:
            q_users["id"] = {"$ne": exclude_user_id}
        allowed = [u["id"] async for u in db.users.find(q_users, {"_id": 0, "id": 1})]
        tokens = await _tokens_for_users(db, allowed)
        return await _send(db, tokens, title=title, body=body,
                           link=link, data=data, tag=tag)
    except Exception as e:
        log.exception("push_to_activated failed: %s", e)
        return {"error": str(e), "requested": 0}


async def push_to_all_registered(db, *, title: str, body: str,
                                 link: Optional[str] = None,
                                 data: Optional[dict] = None,
                                 tag: Optional[str] = None,
                                 exclude_user_id: Optional[str] = None) -> dict:
    """Broadcast to EVERY device with a registered token, regardless of
    activation status. Per spec 2026-02: pubs/marketplace approvals notify
    all users who have opted in — even non-activated ones (they'll be
    redirected to /activation on click).
    """
    try:
        q_tok: dict = {}
        if exclude_user_id:
            q_tok["user_id"] = {"$ne": exclude_user_id}
        tokens: list[str] = []
        async for t in db.push_tokens.find(q_tok, {"_id": 0, "token": 1}):
            tok = t.get("token")
            if tok:
                tokens.append(tok)
        log.info("push_to_all_registered %r → %d tokens", title, len(tokens))
        return await _send(db, tokens, title=title, body=body,
                           link=link, data=data, tag=tag)
    except Exception as e:
        log.exception("push_to_all_registered failed: %s", e)
        return {"error": str(e), "requested": 0}
