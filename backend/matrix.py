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
    """Credit level-N commission to the proper ancestor(s) — official SPILOVEURE
    compensation plan (2026-07-30).

    Trigger — a level-N commission is emitted **only** when a descendant
    activates level N. The eligible recipient is the ancestor exactly N hops
    up the sponsor chain (i.e. the N-th generation ancestor). If that ancestor
    has NOT itself reached level N, the commission is skipped (not paid
    retroactively when they later upgrade — that's the official spec).

    ▸ Direct placement (1st or 2nd direct invitee of the sponsor)
        100 % of `commission_per_invite` → direct ancestor (N-th hop up).

    ▸ Spillover placement (3rd+ direct invitee — placed under the sponsor's
      weakest leg by `place_in_matrix`)
        50 % → direct-sponsor ancestor (N-th hop up the SPONSOR chain).
        50 % → spillover beneficiary  (N-th hop up the MATRIX chain).

    ▸ Reserve/profit split — SAME UNIFORM RULE for every recipient regardless
      of kind (direct, spillover_sponsor, spillover_beneficiary):
        need = max(0, price_of_recipient_next_level − recipient.balance_upgrade)
        upgrade_share = min(amount // 2, need)   # never over-fill
        profit_share  = amount − upgrade_share
      Once the reserve is full (or the recipient is at max level 12) → 100 %
      goes straight into `balance_profit`.

    ▸ Additional guards (spec §10):
        - Recipient user must exist and be at level ≥ N.
        - No commission for max_level == 12 (already at top).
        - Same person on both chains (spillover collapses to direct) → treat
          as a single direct credit (no double-payment).
    """
    if not sponsor_id:
        return []
    lv = LEVELS_BY_NUM.get(level)
    if not lv:
        return []
    commission = lv["commission_per_invite"]

    direct_ancestor = await _walk_up_sponsors(db, sponsor_id, level - 1)

    credits: list[dict] = []
    is_spill = bool(is_spillover and parent_id and parent_id != sponsor_id)

    # Build the list of (recipient_id, amount, kind) tuples.
    if is_spill:
        spillover_ancestor = await _walk_up_sponsors(db, parent_id, level - 1)
        if spillover_ancestor and direct_ancestor and spillover_ancestor == direct_ancestor:
            # Same ancestor on both chains — collapse to a single direct credit
            # so we never double-pay the same person.
            recipients = [(direct_ancestor, commission, "direct")]
        else:
            half = commission // 2
            other_half = commission - half
            recipients = []
            if direct_ancestor:
                recipients.append((direct_ancestor, half, "spillover_sponsor"))
            if spillover_ancestor:
                recipients.append((spillover_ancestor, other_half, "spillover_beneficiary"))
    else:
        recipients = []
        if direct_ancestor:
            recipients.append((direct_ancestor, commission, "direct"))

    for user_id, amount, kind in recipients:
        recipient = await db.users.find_one(
            {"id": user_id},
            {"_id": 0, "max_level": 1, "balance_upgrade": 1},
        )
        # Guard: must be at level N (spec §10).
        if not recipient or recipient.get("max_level", 0) < level:
            log.info(f"Recipient {user_id} not at level {level} — commission skipped (spec §10).")
            continue

        # ── Uniform 50/50-with-cap split (spec §2 + §9) ─────────────────
        current_max = recipient.get("max_level", 0) or 0
        current_upgrade = recipient.get("balance_upgrade", 0) or 0
        if current_max >= 12:
            upgrade_share = 0  # top level — no further upgrade path.
        else:
            next_price = LEVELS_BY_NUM[current_max + 1]["price"]
            need = max(0, next_price - current_upgrade)
            half_amount = amount // 2
            upgrade_share = min(half_amount, need)
        profit_share = amount - upgrade_share

        commission_doc = {
            "user_id": user_id, "from_user_id": new_user_id,
            "level": level, "kind": kind,
            "amount": amount,
            "upgrade_share": upgrade_share,
            "profit_share": profit_share,
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
    """Activate `level` for user: place in matrix, deduct upgrade balance if level>1, distribute commission to sponsor.

    SECURITY: `source` MUST belong to one of the whitelisted origins. Any
    other value → raises immediately, closing the "activation without payment"
    loophole once and for all.
      - AUTOMATED PAID sources (must have matching db.payments/db.activations):
            soleaspay, ashtecpay, sendavapay, gateway_return, manual_reprocess
      - ADMIN OVERRIDE sources (authoritative — no payment lookup):
            admin_validate  → admin has reconciled payment on gateway
            admin_manual    → complimentary L1 grant
      - INTERNAL RESERVE sources (upgrades funded by previously-earned reserve):
            auto_upgrade, manual
    """
    ALLOWED_SOURCES = {
        # External payments — must reference a settled db.payments/db.activations row
        "soleaspay", "ashtecpay", "sendavapay", "biz_transpay", "gateway_return",
        "admin_validate", "manual_reprocess",
        # Internal / operator overrides
        "auto_upgrade", "manual", "admin_manual",
    }
    if source not in ALLOWED_SOURCES:
        raise ValueError(f"Source d'activation invalide : {source!r}. Activation refusée.")
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise ValueError("Utilisateur introuvable")
    if user.get("max_level", 0) >= level:
        return level  # already activated
    if level != user.get("max_level", 0) + 1:
        raise ValueError("Vous devez activer les niveaux dans l'ordre")

    # ────────────────────────────────────────────────────────────────────
    # SECURITY GUARD — "Sans paiement valide = aucune activation".
    # For AUTOMATED external-payment sources (SoleasPay / AshtecPay / etc.)
    # we require a matching payment or activation record in DB. This closes
    # the theoretical bug where a caller invokes activate_level(..., source=
    # "soleaspay") without an actual paid transaction.
    #
    # `admin_validate` is deliberately EXEMPT (2026-07-29): when an admin
    # clicks the "Valider" button, they have already personally reconciled
    # the payment on the gateway (Wave, MTN, Moov, …) — their decision is
    # the source of truth and the system MUST NOT second-guess it. Same
    # rationale applies to `admin_manual` for complimentary L1 activations.
    # ────────────────────────────────────────────────────────────────────
    _PAID_EXTERNAL = {"soleaspay", "ashtecpay", "sendavapay", "biz_transpay",
                      "gateway_return", "manual_reprocess"}
    if source in _PAID_EXTERNAL:
        pay = await db.payments.find_one({
            "user_id": user_id, "level": level,
            "status": {"$in": ["paid", "validated"]},
        }, {"_id": 0, "reference": 1})
        act = await db.activations.find_one({
            "user_id": user_id, "level": level,
            "status": {"$in": ["pending", "validated"]},
        }, {"_id": 0, "id": 1})
        if not pay and not act:
            raise ValueError(
                f"Activation refusée : aucun paiement ou demande d'activation "
                f"trouvé pour l'utilisateur au niveau {level} (source={source})."
            )
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
    # ALL three internal sources (auto_upgrade, manual, admin_manual) are now
    # STRICT: they refuse activation if `balance_upgrade < price` and they
    # ALWAYS debit the reserve on success. The previous "admin override"
    # behaviour caused inconsistencies where users were upgraded to level 2+
    # without ever paying the upgrade fee — confusing the cascade logic and
    # the commission distribution downstream.
    if level >= 2 and source in ("auto_upgrade", "manual", "admin_manual"):
        if user.get("balance_upgrade", 0) < lv["price"]:
            raise ValueError(
                f"Réserve de mise à niveau insuffisante : "
                f"{user.get('balance_upgrade', 0):.0f} FCFA disponible, "
                f"{lv['price']} FCFA requis pour le niveau {level}."
            )
        await db.users.update_one(
            {"id": user_id}, {"$inc": {"balance_upgrade": -lv["price"]}},
        )
    placement = await place_in_matrix(db, user_id, sponsor_id, level)
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"max_level": level, "status": "active", f"level_activated_at.{level}": datetime.now(timezone.utc)}},
    )
    # Persist a full audit trail for every activation so operators can trace
    # back "how" and "when" any user reached a given level. Sources ending in
    # {soleaspay, ashtecpay, gateway_return, admin_validate, manual_reprocess}
    # correspond to real external payments; auto_upgrade/manual/admin_manual
    # come from the internal reserve; source=admin_manual for L1 is the only
    # "no-payment-required" path documented in the business spec.
    try:
        await db.activation_events.insert_one({
            "user_id": user_id,
            "level": level,
            "source": source,
            "requires_payment": bool(level >= 2 or source not in ("admin_manual",)),
            "created_at": datetime.now(timezone.utc),
        })
    except Exception as _e:
        log.warning(f"activation_events insert failed for {user_id} L{level}: {_e}")
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
