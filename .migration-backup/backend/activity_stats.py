"""Dashboard activity statistics module (v27ap, 2026-03-04).

Exposes two endpoints for the user Dashboard "ACTIVITÉ / Statistiques"
section :

  • GET /api/stats/activity?period=24h|7d|30d|1y
      Aggregated bar-chart buckets with per-category totals (parrainage,
      equipe, ads, missions, taches) and a summary (total, max day, min
      day, average).

  • GET /api/stats/activity/day?date=YYYY-MM-DD
      Per-category breakdown of EVERY individual gain credited to the
      caller that day, so the UI can list "Commission directe — User345
      1 000 FCFA" style rows.

Design rules :
  • Reads existing collections ONLY — never invents data.
      - `commissions` : MLM commissions + lottery wins + paid-task rows.
      - `ads_reactor_rewards` : rewards from the "React to an ad" flow.
      - `mission_completions` : paid-mission completions (YouTube, TikTok,
        Instagram, Facebook, questionnaires…).
  • NEVER counts deposits / activations as a gain.
  • Backend performs the aggregation — the frontend only renders.
  • Timezone : UTC. Day keys use YYYY-MM-DD on UTC midnight boundaries.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user

router = APIRouter(prefix="/api/stats", tags=["stats"])

Period = Literal["24h", "7d", "30d", "1y"]

# ---- period helpers ----------------------------------------------------------


def _period_window(period: str) -> tuple[datetime, datetime, str, int]:
    """Return (start, end, bucket_fmt, bucket_count).

    bucket_fmt is a Mongo $dateToString format :
      - "%Y-%m-%dT%H:00" for 24h (hourly buckets)
      - "%Y-%m-%d" for 7d / 30d (daily buckets)
      - "%Y-%m" for 1y (monthly buckets)
    """
    now = datetime.now(timezone.utc)
    if period == "24h":
        end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        start = end - timedelta(hours=24)
        return start, end, "%Y-%m-%dT%H:00", 24
    if period == "30d":
        today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        start = today - timedelta(days=29)
        end = today + timedelta(days=1)
        return start, end, "%Y-%m-%d", 30
    if period == "1y":
        # 12 monthly buckets ending with the current month.
        y, m = now.year, now.month
        start_m = m - 11
        start_y = y
        while start_m <= 0:
            start_m += 12
            start_y -= 1
        start = datetime(start_y, start_m, 1, tzinfo=timezone.utc)
        end = datetime(y, m, 1, tzinfo=timezone.utc)
        # advance one month
        em = m + 1
        ey = y
        if em > 12:
            em = 1
            ey = y + 1
        end = datetime(ey, em, 1, tzinfo=timezone.utc)
        return start, end, "%Y-%m", 12
    # default : 7d
    today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    start = today - timedelta(days=6)
    end = today + timedelta(days=1)
    return start, end, "%Y-%m-%d", 7


def _enumerate_buckets(start: datetime, end: datetime, fmt: str) -> list[str]:
    out: list[str] = []
    cur = start
    if fmt == "%Y-%m":
        # Month increments.
        while cur < end:
            out.append(cur.strftime("%Y-%m"))
            m = cur.month + 1
            y = cur.year
            if m > 12:
                m = 1
                y += 1
            cur = datetime(y, m, 1, tzinfo=timezone.utc)
    elif fmt == "%Y-%m-%dT%H:00":
        while cur < end:
            out.append(cur.strftime("%Y-%m-%dT%H:00"))
            cur = cur + timedelta(hours=1)
    else:  # daily
        while cur < end:
            out.append(cur.strftime("%Y-%m-%d"))
            cur = cur + timedelta(days=1)
    return out


# ---- commission classification ----------------------------------------------
#
# MLM commissions live in `commissions` with a `kind` and a `level` field.
# The user-facing taxonomy :
#   • "parrainage" : direct level-1 commissions (the user they sponsored
#       activated or triggered a rebate). Kinds : "direct",
#       "spillover_sponsor".
#   • "equipe"     : indirect commissions attributed via spillover /
#       levels 2..12. Kind : "spillover_beneficiary" OR any commission
#       with level > 1.
#   • "taches"     : task / lottery / special-mission rewards logged into
#       the `commissions` collection with a non-commission kind.

_PARRAINAGE_KINDS = {"direct", "spillover_sponsor"}
_EQUIPE_KINDS = {"spillover_beneficiary"}
_TASK_KINDS = {
    "paid_task", "special_task", "task_reward", "lottery_win",
    "ebook_bonus", "formation_bonus",
}


def _classify_commission(doc: dict) -> str | None:
    """Return one of parrainage / equipe / taches / None (not a gain)."""
    kind = (doc.get("kind") or "").strip()
    level = doc.get("level")
    if kind == "lottery_entry" or kind == "lottery_loss":
        # Participations and losses are NOT gains.
        return None
    if kind in _PARRAINAGE_KINDS and (level is None or level == 1):
        return "parrainage"
    if kind in _EQUIPE_KINDS:
        return "equipe"
    if kind in _PARRAINAGE_KINDS and (level or 0) > 1:
        return "equipe"
    if kind in _TASK_KINDS:
        return "taches"
    # Unknown positive commission rows fall back to "taches" so no gain
    # ever disappears from the user's view.
    amt = float(doc.get("amount") or doc.get("profit_share") or 0)
    if amt > 0:
        return "taches"
    return None


def _commission_amount(doc: dict) -> float:
    """A commission's effective gain = profit_share when present (MLM
    rewards split between profit and upgrade buckets), else amount."""
    v = doc.get("profit_share")
    if v is None:
        v = doc.get("amount")
    try:
        return float(v or 0)
    except Exception:
        return 0.0


# ---- the aggregation ---------------------------------------------------------


async def _collect_bucketed_gains(db, user_id: str, start: datetime, end: datetime, fmt: str) -> dict[str, dict[str, float]]:
    """Return {bucket_key: {parrainage, equipe, ads, missions, taches}}
    containing REAL amounts for the time window.
    """
    totals: dict[str, dict[str, float]] = {}

    def _bump(bucket: str, cat: str, amount: float) -> None:
        if amount <= 0:
            return
        d = totals.setdefault(bucket, {})
        d[cat] = d.get(cat, 0.0) + amount

    def _fmt(d: datetime) -> str:
        d = d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        if fmt == "%Y-%m":
            return d.strftime("%Y-%m")
        if fmt == "%Y-%m-%dT%H:00":
            return d.strftime("%Y-%m-%dT%H:00")
        return d.strftime("%Y-%m-%d")

    # 1) MLM commissions + special-task rewards + lottery wins.
    cur = db.commissions.find(
        {"user_id": user_id, "created_at": {"$gte": start, "$lt": end}},
        {"_id": 0, "amount": 1, "profit_share": 1, "kind": 1, "level": 1, "created_at": 1},
    )
    async for doc in cur:
        cat = _classify_commission(doc)
        if not cat:
            continue
        amt = _commission_amount(doc)
        if amt <= 0:
            continue
        _bump(_fmt(doc["created_at"]), cat, amt)

    # 2) Ads reactor rewards.
    cur = db.ads_reactor_rewards.find(
        {"user_id": user_id, "created_at": {"$gte": start, "$lt": end}},
        {"_id": 0, "amount": 1, "created_at": 1},
    )
    async for doc in cur:
        amt = float(doc.get("amount") or 0)
        if amt <= 0:
            continue
        _bump(_fmt(doc["created_at"]), "ads", amt)

    # 3) Paid mission completions.
    cur = db.mission_completions.find(
        {"user_id": user_id, "completed_at": {"$gte": start, "$lt": end}},
        {"_id": 0, "reward": 1, "completed_at": 1},
    )
    async for doc in cur:
        amt = float(doc.get("reward") or 0)
        if amt <= 0:
            continue
        _bump(_fmt(doc["completed_at"]), "missions", amt)

    return totals


@router.get("/activity")
async def activity_series(
    request: Request,
    period: str = "7d",
    user=Depends(get_current_user),
) -> dict[str, Any]:
    if period not in ("24h", "7d", "30d", "1y"):
        raise HTTPException(400, "Période invalide. Utiliser 24h, 7d, 30d ou 1y.")
    db = request.app.state.db
    start, end, fmt, count = _period_window(period)
    keys = _enumerate_buckets(start, end, fmt)
    gains = await _collect_bucketed_gains(db, user["id"], start, end, fmt)

    buckets: list[dict[str, Any]] = []
    total = 0.0
    max_bucket: dict[str, Any] | None = None
    min_bucket: dict[str, Any] | None = None
    for k in keys:
        row = gains.get(k, {})
        parrainage = row.get("parrainage", 0.0)
        equipe = row.get("equipe", 0.0)
        ads = row.get("ads", 0.0)
        missions = row.get("missions", 0.0)
        taches = row.get("taches", 0.0)
        bucket_total = parrainage + equipe + ads + missions + taches
        total += bucket_total
        buckets.append({
            "key": k,
            "parrainage": parrainage,
            "equipe": equipe,
            "ads": ads,
            "missions": missions,
            "taches": taches,
            "total": bucket_total,
        })
        if max_bucket is None or bucket_total > max_bucket["total"]:
            max_bucket = {"key": k, "total": bucket_total}
        if min_bucket is None or bucket_total < min_bucket["total"]:
            min_bucket = {"key": k, "total": bucket_total}

    avg = (total / len(buckets)) if buckets else 0.0

    return {
        "period": period,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "bucket_format": fmt,
        "buckets": buckets,
        "summary": {
            "total": total,
            "max_day": max_bucket or {"key": None, "total": 0.0},
            "min_day": min_bucket or {"key": None, "total": 0.0},
            "average": avg,
            "bucket_count": len(buckets),
        },
    }


@router.get("/activity/day")
async def activity_day(
    request: Request,
    date: str,
    user=Depends(get_current_user),
) -> dict[str, Any]:
    """Per-user per-day breakdown with individual transactions.

    `date` is YYYY-MM-DD on UTC. For the 24h view the frontend passes
    the hour key (e.g. 2026-03-04T14:00) and we match any transaction
    inside that hour. For the 1y view we accept YYYY-MM and match the
    whole month.
    """
    db = request.app.state.db
    try:
        if "T" in date:  # hour
            start = datetime.strptime(date, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
            end = start + timedelta(hours=1)
        elif date.count("-") == 1:  # month
            y, m = date.split("-")
            start = datetime(int(y), int(m), 1, tzinfo=timezone.utc)
            if int(m) == 12:
                end = datetime(int(y) + 1, 1, 1, tzinfo=timezone.utc)
            else:
                end = datetime(int(y), int(m) + 1, 1, tzinfo=timezone.utc)
        else:  # day
            start = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            end = start + timedelta(days=1)
    except Exception as exc:
        raise HTTPException(400, f"Date invalide : {exc}") from exc

    buckets: dict[str, list[dict[str, Any]]] = {
        "parrainage": [], "equipe": [], "ads": [], "missions": [], "taches": [],
    }

    # Commissions.
    cur = db.commissions.find(
        {"user_id": user["id"], "created_at": {"$gte": start, "$lt": end}},
        {"_id": 0},
    ).sort("created_at", 1)
    async for doc in cur:
        cat = _classify_commission(doc)
        if not cat:
            continue
        amt = _commission_amount(doc)
        if amt <= 0:
            continue
        from_username = None
        from_uid = doc.get("from_user_id")
        if from_uid:
            fu = await db.users.find_one({"id": from_uid}, {"_id": 0, "username": 1})
            if fu:
                from_username = fu.get("username")
        kind = (doc.get("kind") or "").strip()
        level = doc.get("level")
        if kind in _PARRAINAGE_KINDS and (level is None or level == 1):
            label = "Commission directe"
        elif kind == "lottery_win":
            label = "Gain Loterie"
        elif cat == "equipe":
            label = f"Commission niveau {level}" if level else "Commission équipe"
        else:
            label = {
                "paid_task": "Tâche rémunérée",
                "special_task": "Tâche spéciale",
                "task_reward": "Récompense de tâche",
                "ebook_bonus": "Bonus e-book",
                "formation_bonus": "Bonus formation",
            }.get(kind, "Récompense")
        buckets[cat].append({
            "amount": amt,
            "label": label,
            "from_username": from_username,
            "from_user_id": from_uid,
            "level": level,
            "kind": kind,
            "at": (doc["created_at"].isoformat()
                   if isinstance(doc.get("created_at"), datetime) else None),
            "ref": doc.get("id") or doc.get("_id"),
        })

    # Ads.
    cur = db.ads_reactor_rewards.find(
        {"user_id": user["id"], "created_at": {"$gte": start, "$lt": end}},
        {"_id": 0, "amount": 1, "ad_id": 1, "ad_title": 1, "created_at": 1},
    ).sort("created_at", 1)
    async for doc in cur:
        amt = float(doc.get("amount") or 0)
        if amt <= 0:
            continue
        buckets["ads"].append({
            "amount": amt,
            "label": doc.get("ad_title") or "Publicité",
            "ad_id": doc.get("ad_id"),
            "at": (doc["created_at"].isoformat()
                   if isinstance(doc.get("created_at"), datetime) else None),
        })

    # Missions.
    cur = db.mission_completions.find(
        {"user_id": user["id"], "completed_at": {"$gte": start, "$lt": end}},
        {"_id": 0, "reward": 1, "mission_id": 1, "mission_title": 1, "platform": 1, "completed_at": 1},
    ).sort("completed_at", 1)
    async for doc in cur:
        amt = float(doc.get("reward") or 0)
        if amt <= 0:
            continue
        platform = (doc.get("platform") or "").strip()
        platform_label = {"youtube": "YouTube", "tiktok": "TikTok",
                          "instagram": "Instagram", "facebook": "Facebook",
                          "questionnaire": "Questionnaire"}.get(platform, platform.title() or "Mission")
        buckets["missions"].append({
            "amount": amt,
            "label": doc.get("mission_title") or f"Mission {platform_label}",
            "mission_id": doc.get("mission_id"),
            "platform": platform,
            "at": (doc["completed_at"].isoformat()
                   if isinstance(doc.get("completed_at"), datetime) else None),
        })

    totals = {k: sum(x["amount"] for x in v) for k, v in buckets.items()}
    grand_total = sum(totals.values())
    return {
        "date": date,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "totals": totals,
        "grand_total": grand_total,
        "transactions": buckets,
    }


def register(app):
    """Called from server.py to mount the router."""
    app.include_router(router)
