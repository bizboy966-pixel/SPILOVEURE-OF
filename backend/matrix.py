"""Binary forced matrix + spillover + commission distribution + auto-upgrade."""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Optional

from levels import LEVELS_BY_NUM

log = logging.getLogger("matrix")


async def place_in_matrix(db, user_id: str, sponsor_id: Optional[str], level: int) -> dict:
    """Place user in the binary matrix at `level`. Returns placement dict with parent_id and is_spillover.

    Strategy: try sponsor first; if both legs full at that level, BFS through descendants.
    The matrix is stored in collection `matrix_placements` keyed by (user_id, level).

    Idempotent: if a placement already exists for (user_id, level) it is returned as-is
    instead of raising a duplicate-key error. This makes retries (admin reprocess of a
    stuck payment) safe.
    """
    existing = await db.matrix_placements.find_one(
        {"user_id": user_id, "level": level}, {"_id": 0},
    )
    if existing:
        log.info(f"place_in_matrix idempotent: placement already exists for {user_id} L{level}")
        return existing

    if not sponsor_id:
        # admin or first user with no sponsor
        placement = {
            "user_id": user_id, "level": level,
            "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        }
        await db.matrix_placements.insert_one(placement)
        placement.pop("_id", None)
        return placement

    # BFS starting from sponsor
    queue = [sponsor_id]
    visited = set()
    chosen_parent = None
    chosen_leg = None
    while queue:
        candidate = queue.pop(0)
        if candidate in visited:
            continue
        visited.add(candidate)
        children = await db.matrix_placements.find(
            {"level": level, "parent_id": candidate},
            {"_id": 0, "user_id": 1, "leg": 1},
        ).to_list(10)
        legs = {c["leg"] for c in children}
        if "left" not in legs:
            chosen_parent, chosen_leg = candidate, "left"
            break
        if "right" not in legs:
            chosen_parent, chosen_leg = candidate, "right"
            break
        for c in children:
            queue.append(c["user_id"])

    if not chosen_parent:
        chosen_parent, chosen_leg = sponsor_id, "left"

    is_spillover = chosen_parent != sponsor_id
    placement = {
        "user_id": user_id, "level": level,
        "parent_id": chosen_parent, "leg": chosen_leg,
        "sponsor_id": sponsor_id, "is_spillover": is_spillover,
        "created_at": datetime.now(timezone.utc),
    }
    await db.matrix_placements.insert_one(placement)
    placement.pop("_id", None)
    return placement


async def _walk_up_sponsors(db, start_user_id: Optional[str], hops: int) -> Optional[str]:
    """Walk up the direct-sponsor chain by `hops` hops. Returns the ancestor id or None."""
    if not start_user_id or hops < 0:
        return None
    current = start_user_id
    for _ in range(hops):
        doc = await db.users.find_one({"id": current}, {"_id": 0, "sponsor_id": 1})
        if not doc or not doc.get("sponsor_id"):
            return None
        current = doc["sponsor_id"]
    return current


async def distribute_commission(db, new_user_id: str, sponsor_id: Optional[str], parent_id: Optional[str], level: int, is_spillover: bool) -> list:
    """Credit level-N commission to the proper ancestor(s) up the sponsor chain.

    Rule (per business spec):
      - When user X activates level N, the ancestor exactly (N-1) hops further
        above X's direct sponsor — i.e. N hops above X — receives the commission.
      - That ancestor MUST have already activated level N themselves; otherwise
        the commission is skipped (not paid retroactively).

    Direct placement (no spillover):
      - Full commission goes to the direct ancestor.
      - Split: upgrade_reserve_ratio (per level) → balance_upgrade,
               rest                            → balance_profit.

    Spillover placement (parent_id != sponsor_id):
      - Commission is split 50/50:
          a) DIRECT-SPONSOR ANCESTOR (the level-N ancestor up the sponsor chain
             from the new user's direct sponsor):
             • Their 50% share goes **100% into balance_profit**.
             • No portion goes to upgrade_reserve.
          b) SPILLOVER BENEFICIARY (the level-N ancestor up the matrix chain
             from the spillover parent):
             • Their 50% share is split 50/50 between balance_profit and
               balance_upgrade, UNTIL the beneficiary has fully funded the
               price of their next level. Once that reserve is full (or they
               are already at max level 12), 100% goes to balance_profit.
    """
    if not sponsor_id:
        return []
    lv = LEVELS_BY_NUM.get(level)
    if not lv:
        return []
    commission = lv["commission_per_invite"]
    total_gain = lv["total_gain"] or 1
    upgrade_reserve = lv["upgrade_reserve"]
    direct_upgrade_ratio = upgrade_reserve / total_gain

    direct_ancestor = await _walk_up_sponsors(db, sponsor_id, level - 1)

    credits = []
    is_spill = bool(is_spillover and parent_id and parent_id != sponsor_id)

    if is_spill:
        spillover_ancestor = await _walk_up_sponsors(db, parent_id, level - 1)
        # Same person on both chains? give full commission, treat as direct.
        if spillover_ancestor and direct_ancestor and spillover_ancestor == direct_ancestor:
            recipients = [(direct_ancestor, commission, "direct", direct_upgrade_ratio, False)]
        else:
            half = commission // 2
            other_half = commission - half
            recipients = []
            if direct_ancestor:
                # Direct sponsor share — 100% profit, NO upgrade reserve.
                recipients.append((direct_ancestor, half, "spillover_sponsor", 0.0, False))
            if spillover_ancestor:
                # Beneficiary share — 50/50 dynamic (capped to next-level price).
                recipients.append((spillover_ancestor, other_half, "spillover_beneficiary", 0.5, True))
    else:
        recipients = []
        if direct_ancestor:
            recipients.append((direct_ancestor, commission, "direct", direct_upgrade_ratio, False))

    for user_id, amount, kind, upgrade_ratio, cap_to_next_level in recipients:
        recipient = await db.users.find_one(
            {"id": user_id}, {"_id": 0, "max_level": 1, "balance_upgrade": 1},
        )
        if not recipient or recipient.get("max_level", 0) < level:
            log.info(f"Recipient {user_id} not at level {level}, commission skipped")
            continue

        if upgrade_ratio <= 0:
            upgrade_share = 0
        else:
            upgrade_share = int(round(amount * upgrade_ratio))

        if cap_to_next_level and upgrade_share > 0:
            # Stop feeding the reserve once next-level price is funded.
            current_max = recipient.get("max_level", 0)
            current_upgrade = recipient.get("balance_upgrade", 0) or 0
            if current_max >= 12:
                upgrade_share = 0
            else:
                next_price = LEVELS_BY_NUM[current_max + 1]["price"]
                remaining = max(0, next_price - current_upgrade)
                upgrade_share = min(upgrade_share, remaining)

        profit_share = amount - upgrade_share

        commission_doc = {
            "user_id": user_id, "from_user_id": new_user_id,
            "level": level, "kind": kind,
            "amount": amount, "upgrade_share": upgrade_share, "profit_share": profit_share,
            "created_at": datetime.now(timezone.utc),
        }
        await db.commissions.insert_one(commission_doc)
        await db.users.update_one(
            {"id": user_id},
            {"$inc": {
                "balance_profit": profit_share,
                "balance_upgrade": upgrade_share,
                f"earnings_per_level.{level}": amount,
                "total_earned": amount,
                "commission_direct" if kind == "direct" else "commission_spillover": amount,
            }},
        )
        credits.append(commission_doc)

        # Trigger auto-upgrade cascade if the recipient now has enough reserve.
        try:
            # Loop in case multiple levels can be activated back-to-back.
            for _ in range(12):
                upgraded_to = await try_auto_upgrade(db, user_id)
                if not upgraded_to:
                    break
                log.info(f"Auto-upgrade: user {user_id} → level {upgraded_to}")
        except Exception as e:
            log.exception(f"try_auto_upgrade failed for {user_id}: {e}")

    return credits


async def try_auto_upgrade(db, user_id: str) -> Optional[int]:
    """If user has enough in balance_upgrade and matrix is sufficiently filled, auto-activate next level."""
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        return None
    cur = user.get("max_level", 0)
    if cur >= 12:
        return None
    next_lv = LEVELS_BY_NUM[cur + 1]
    if user.get("balance_upgrade", 0) < next_lv["price"]:
        return None
    # check current level matrix fill: at least invites_required filled at current level
    if cur >= 1:
        cur_lv = LEVELS_BY_NUM[cur]
        # BFS-aware count of all descendants under user_id at level=cur
        descendants = await _count_descendants(db, user_id, cur)
        if descendants < cur_lv["invites_required"]:
            return None
    # Activate next level
    return await activate_level(db, user_id, next_lv["level"], source="auto_upgrade")


async def _count_descendants(db, root_user_id: str, level: int) -> int:
    count = 0
    queue = [root_user_id]
    visited = set()
    while queue:
        u = queue.pop(0)
        if u in visited:
            continue
        visited.add(u)
        children = await db.matrix_placements.find(
            {"level": level, "parent_id": u}, {"_id": 0, "user_id": 1}
        ).to_list(2000)
        for c in children:
            count += 1
            queue.append(c["user_id"])
    return count


async def activate_level(db, user_id: str, level: int, source: str = "manual") -> int:
    """Activate `level` for user: place in matrix, deduct upgrade balance if level>1, distribute commission to sponsor."""
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise ValueError("Utilisateur introuvable")
    if user.get("max_level", 0) >= level:
        return level  # already activated
    if level != user.get("max_level", 0) + 1:
        raise ValueError("Vous devez activer les niveaux dans l'ordre")
    lv = LEVELS_BY_NUM[level]
    sponsor_id = user.get("sponsor_id")
    # Deduct from balance_upgrade when the activation is paid from the
    # internal reserve. Three sources qualify:
    #   - "auto_upgrade"  — cascade triggered automatically when reserve is full.
    #   - "manual"        — user clicks "Activer Niveau N" from /matrices page
    #                       (`/api/activations/request` for level>=2). The reserve
    #                       was built up specifically to fund this upgrade.
    #   - "admin_manual"  — admin forces the level via /api/admin/users/{id}/action.
    # External payments (WestPay / SendavaPay / manual Mobile Money / Crypto
    # validated by admin) settle out-of-band and must NOT touch the reserve.
    # Strict sources (auto_upgrade, manual) raise if reserve is insufficient.
    # admin_manual is permissive (admin override) — proceeds with warning.
    if level >= 2 and source in ("auto_upgrade", "manual", "admin_manual"):
        if user.get("balance_upgrade", 0) < lv["price"]:
            if source in ("auto_upgrade", "manual"):
                raise ValueError("Réserve de mise à niveau insuffisante")
            # admin_manual: log the gap but proceed (admin is responsible).
            log.warning(
                f"admin_manual activate_level user={user_id} level={level}: "
                f"balance_upgrade={user.get('balance_upgrade', 0)} < price={lv['price']} "
                f"→ activating without debiting (admin override)"
            )
        else:
            await db.users.update_one(
                {"id": user_id}, {"$inc": {"balance_upgrade": -lv["price"]}},
            )
    placement = await place_in_matrix(db, user_id, sponsor_id, level)
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"max_level": level, "status": "active", f"level_activated_at.{level}": datetime.now(timezone.utc)}},
    )
    await distribute_commission(
        db, user_id, sponsor_id, placement.get("parent_id"), level,
        placement.get("is_spillover", False),
    )
    # cascade: maybe sponsor also auto-upgrades
    if sponsor_id:
        try:
            await try_auto_upgrade(db, sponsor_id)
        except Exception as e:
            log.warning(f"auto-upgrade cascade failed for {sponsor_id}: {e}")
    # cascade auto-upgrade for self too
    try:
        await try_auto_upgrade(db, user_id)
    except Exception as e:
        log.warning(f"self auto-upgrade failed for {user_id}: {e}")
    return level
