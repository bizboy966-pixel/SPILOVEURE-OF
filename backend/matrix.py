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
    """
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
        the commission is skipped (will never be paid retroactively — the user
        must qualify at activation time).
      - For spillover: split 50/50 between
          * the level-N ancestor of the direct sponsor chain,
          * the level-N ancestor of the spillover-parent chain.
      - Each credit is split between upgrade_reserve and profit per level config.
    """
    if not sponsor_id:
        return []
    lv = LEVELS_BY_NUM.get(level)
    if not lv:
        return []
    commission = lv["commission_per_invite"]
    total_gain = lv["total_gain"] or 1
    upgrade_reserve = lv["upgrade_reserve"]
    upgrade_ratio = upgrade_reserve / total_gain

    # Walk up (level - 1) more hops from direct sponsor → level-N ancestor.
    direct_ancestor = await _walk_up_sponsors(db, sponsor_id, level - 1)

    credits = []
    recipients: list[tuple[str, int, str]] = []
    if is_spillover and parent_id and parent_id != sponsor_id:
        spillover_ancestor = await _walk_up_sponsors(db, parent_id, level - 1)
        if direct_ancestor:
            recipients.append((direct_ancestor, commission // 2, "spillover_sponsor"))
        if spillover_ancestor and spillover_ancestor != direct_ancestor:
            recipients.append((spillover_ancestor, commission - commission // 2, "spillover_beneficiary"))
        elif direct_ancestor:
            # if both chains converge to the same person, give the full commission
            recipients[-1] = (direct_ancestor, commission, "spillover_sponsor")
    else:
        if direct_ancestor:
            recipients.append((direct_ancestor, commission, "direct"))

    for user_id, amount, kind in recipients:
        upgrade_share = int(round(amount * upgrade_ratio))
        profit_share = amount - upgrade_share
        # Only credit if the recipient has activated this level
        recipient = await db.users.find_one({"id": user_id}, {"_id": 0, "max_level": 1})
        if not recipient or recipient.get("max_level", 0) < level:
            # they don't qualify for level-N commissions; skip (pending validation rule)
            log.info(f"Recipient {user_id} not at level {level}, commission skipped")
            continue
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
        downline_count = await db.matrix_placements.count_documents({"level": cur, "parent_id": user_id})
        # use BFS-aware count: count all descendants under user_id at level=cur
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
    # For level >= 2, deduct from balance_upgrade
    if level >= 2:
        if user.get("balance_upgrade", 0) < lv["price"]:
            raise ValueError("Réserve de mise à niveau insuffisante")
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
