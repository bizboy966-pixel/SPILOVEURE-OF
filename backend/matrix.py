"""Binary forced matrix + spillover + commission distribution + auto-upgrade."""
from __future__ import annotations
import logging
import uuid
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


async def _walk_up_matrix_tree(db, user_id: Optional[str], hops: int) -> Optional[str]:
    """Walk `hops` steps up the LEVEL-1 placement chain (`parent_id`).
    Returns the ancestor at the target depth (i.e. the owner of that
    generation), or None if the chain hits root or a broken link.

    ⚠️ Le "parent" de niveau 1 est le VRAI parent dans l'arbre binaire —
    c'est lui qui détermine la génération à laquelle appartient le membre.
    Les placements de niveau 2+ historiques ne servent PAS à déterminer
    la génération (cf. spec 2026-08-27).
    """
    if hops <= 0 or not user_id:
        return user_id
    current = user_id
    for _ in range(hops):
        p = await db.matrix_placements.find_one(
            {"user_id": current, "level": 1}, {"_id": 0, "parent_id": 1}
        )
        if not p or not p.get("parent_id"):
            return None
        current = p["parent_id"]
    return current


async def distribute_commission(db, new_user_id: str, sponsor_id: Optional[str], parent_id: Optional[str], level: int, is_spillover: bool) -> list:
    """Credit level-N commission per SPILOVEURE compensation plan.

    ⚠️ Spec finale 2026-08-27 : le Spillover N'INTERVIENT QUE sur l'événement
    d'inscription/placement L1. Pour tous les niveaux ≥ 2, la commission va
    intégralement à l'ancêtre de génération N — c.-à-d. la personne exactement
    N sauts en amont dans l'arbre binaire (chaîne `parent_id` du placement L1
    de l'activateur), quel que soit le mode d'arrivée du membre.

    ▸ Level 1 (placement initial du nouveau membre) :
        - Non-spillover : 100 % → direct sponsor (arg `sponsor_id`).
        - Spillover (parent_id ≠ sponsor_id) : 50 % → sponsor, 50 % → parent
          (bénéficiaire du spillover). C'est le SEUL moment où le split
          50/50 s'applique.

    ▸ Level ≥ 2 (upgrade) :
        - 100 % → ancêtre à `level` sauts au-dessus dans l'arbre L1.
        - Aucun split spillover. Le spillover n'est plus regardé.
        - Si l'ancêtre n'existe pas (racine atteinte) → aucune commission.

    ▸ Guards §10 (recipient existe + max_level ≥ N) — inchangés.
    ▸ Reserve/profit split 50/50 côté crédit — inchangé.
    """
    lv = LEVELS_BY_NUM.get(level)
    if not lv:
        return []
    commission = lv["commission_per_invite"]

    credits: list[dict] = []

    if level == 1:
        # Placement initial — spillover 50/50 possible ici SEULEMENT.
        if not sponsor_id:
            return []
        is_spill = bool(is_spillover and parent_id and parent_id != sponsor_id)
        if is_spill:
            half = commission // 2
            other_half = commission - half
            recipients = [
                (sponsor_id, half, "spillover_sponsor"),
                (parent_id, other_half, "spillover_beneficiary"),
            ]
        else:
            recipients = [(sponsor_id, commission, "direct")]
    else:
        # Level ≥ 2 : ancêtre par génération dans l'arbre L1, jamais de split.
        ancestor = await _walk_up_matrix_tree(db, new_user_id, level)
        if not ancestor:
            log.warning(
                f"distribute_commission L{level}: L1 tree too shallow from "
                f"activator={new_user_id}; commission of {commission} dropped "
                f"(no ancestor at depth {level})."
            )
            return []
        recipients = [(ancestor, commission, "direct")]

    for user_id, amount, kind in recipients:
        recipient = await db.users.find_one(
            {"id": user_id},
            {"_id": 0, "max_level": 1, "balance_upgrade": 1},
        )
        # Guard: must be at level N (spec §10).
        if not recipient or recipient.get("max_level", 0) < level:
            log.warning(
                f"distribute_commission L{level}: recipient={user_id} kind={kind} "
                f"skipped (max_level={recipient.get('max_level', 0) if recipient else 'N/A'} "
                f"< {level}); {amount} FCFA burned per spec §10."
            )
            continue

        # ── Reserve/profit split ────────────────────────────────────────
        # Spec 2026-02: only DIRECT commissions and the SPILLOVER-BENEFICIARY
        # share feed the upgrade reserve. The SPILLOVER-SPONSOR share (paid
        # when a sponsor invites a downline placed via spillover, from the
        # 3rd direct invitee onwards) goes 100 % to profit — no split.
        current_max = recipient.get("max_level", 0) or 0
        current_upgrade = recipient.get("balance_upgrade", 0) or 0
        if kind == "spillover_sponsor":
            upgrade_share = 0
        elif current_max >= 12:
            upgrade_share = 0  # top level — no further upgrade path.
        else:
            next_price = LEVELS_BY_NUM[current_max + 1]["price"]
            need = max(0, next_price - current_upgrade)
            half_amount = amount // 2
            upgrade_share = min(half_amount, need)
        profit_share = amount - upgrade_share

        commission_doc = {
            "id": str(uuid.uuid4()),
            "user_id": user_id, "from_user_id": new_user_id,
            "level": level, "kind": kind,
            "amount": amount,
            "upgrade_share": upgrade_share,
            "profit_share": profit_share,
            "created_at": datetime.now(timezone.utc),
        }
        await db.commissions.insert_one(commission_doc)
        # v27v (2026-02-24) — fine-grained counters :
        #   • direct                → commission_direct
        #   • spillover_sponsor     → commission_spillover_sponsor
        #   • spillover_beneficiary → commission_spillover_beneficiary
        #   • generation (L≥2)      → commission_generation
        # Ancienne clé fusionnée `commission_spillover` gardée pour rétro-
        # compatibilité côté frontend.
        counter_field = {
            "direct":                  "commission_direct",
            "spillover_sponsor":       "commission_spillover_sponsor",
            "spillover_beneficiary":   "commission_spillover_beneficiary",
        }.get(kind, "commission_generation")
        legacy_bump: dict = {}
        if kind in ("spillover_sponsor", "spillover_beneficiary"):
            # keep legacy total for old dashboards / API consumers.
            legacy_bump = {"commission_spillover": amount}
        await db.users.update_one(
            {"id": user_id},
            {"$inc": {
                "balance_profit": profit_share,
                "balance_upgrade": upgrade_share,
                f"earnings_per_level.{level}": amount,
                "total_earned": amount,
                counter_field: amount,
                **legacy_bump,
            }},
        )
        log.info(
            "commission user=%s from=%s level=%s kind=%s amount=%s "
            "profit=%s upgrade=%s",
            user_id, new_user_id, level, kind, amount, profit_share, upgrade_share,
        )
        credits.append(commission_doc)

        # 🔔 Push notification to the recipient (fire-and-forget).
        try:
            from push_helper import push_to_user
            from levels import LEVELS_BY_NUM as _LVL
            src_name = _LVL.get(level, {}).get("name", f"Niveau {level}")
            # v27 (2026-02-14) — also persist to `db.notifications` so the
            # in-app bell / notifications center picks up every commission
            # credit (previously only Firebase push, which meant the bell
            # never showed commissions).
            kind_label = {
                "direct": "Commission directe",
                "spillover_sponsor": "Commission spillover (sponsor)",
                "spillover_beneficiary": "Commission spillover",
            }.get(kind, "Commission")
            notif_title = f"💰 {kind_label} — Niveau {level}"
            notif_body = (
                f"Vous venez de recevoir {int(amount):,} FCFA — source : {src_name}."
                .replace(",", " ")
            )
            try:
                await db.notifications.insert_one({
                    "id": str(uuid.uuid4()),
                    "user_id": user_id,
                    "kind": "commission",
                    "sub_kind": kind,
                    "title": notif_title,
                    "body": notif_body,
                    "meta": {
                        "level": level,
                        "amount": int(amount),
                        "commission_kind": kind,
                        "from_user_id": new_user_id,
                        "source_name": src_name,
                    },
                    "read": False,
                    "created_at": datetime.now(timezone.utc),
                })
            except Exception as e:
                log.warning(f"notification insert failed for commission {commission_doc['id']}: {e}")
            await push_to_user(
                db, user_id,
                title=notif_title,
                body=notif_body,
                link="/(app)/withdrawal",
                data={"kind": "commission", "level": str(level), "amount": str(int(amount))},
                tag=f"commission-{commission_doc['id']}",
            )
        except Exception:
            pass

        # Trigger auto-upgrade cascade if the recipient now has enough reserve.
        try:
            for _ in range(12):
                upgraded_to = await try_auto_upgrade(db, user_id)
                if not upgraded_to:
                    break
                log.info(f"Auto-upgrade: user {user_id} → level {upgraded_to}")
                # 🔔 Notify user of level-up (persistent + push).
                try:
                    lvl_title = "🎉 Félicitations — Niveau supérieur !"
                    lvl_body = f"Votre compte vient de passer automatiquement au Niveau {upgraded_to}."
                    try:
                        await db.notifications.insert_one({
                            "id": str(uuid.uuid4()),
                            "user_id": user_id,
                            "kind": "level_up",
                            "title": lvl_title,
                            "body": lvl_body,
                            "meta": {"level": upgraded_to},
                            "read": False,
                            "created_at": datetime.now(timezone.utc),
                        })
                    except Exception as e:
                        log.warning(f"notification insert failed for level_up {user_id}→{upgraded_to}: {e}")
                    from push_helper import push_to_user as _pu
                    await _pu(
                        db, user_id,
                        title=lvl_title,
                        body=lvl_body,
                        link="/(app)/dashboard",
                        data={"kind": "level_up", "level": str(upgraded_to)},
                        tag=f"levelup-{user_id}-{upgraded_to}",
                    )
                except Exception:
                    pass
        except Exception as e:
            log.exception(f"try_auto_upgrade failed for {user_id}: {e}")

    return credits


async def try_auto_upgrade(db, user_id: str) -> Optional[int]:
    """If user has enough in balance_upgrade, auto-activate next level.

    v27v (2026-02-24) — conforme spec SPILOVEURE §5 & §27 : l'upgrade doit
    se déclencher DÈS QUE la réserve est complète, sans condition sur le
    nombre de descendants matriciels. La condition `descendants >=
    invites_required` a été supprimée : elle empêchait à tort un utilisateur
    ayant rempli sa réserve avec une seule commission de passer au niveau
    suivant automatiquement (blocage jusqu'à ce qu'il ait ses 2 filleuls).
    """
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        return None
    cur = user.get("max_level", 0)
    if cur >= 12:
        return None
    next_lv = LEVELS_BY_NUM[cur + 1]
    if user.get("balance_upgrade", 0) < next_lv["price"]:
        return None
    # v27v — la condition descendants >= invites_required a été supprimée.
    # Activate next level immediately once the reserve is funded.
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
        "soleaspay", "ashtecpay", "sendavapay", "izichange", "biztranspay", "gateway_return",
        "admin_validate", "manual_reprocess",
        # Internal / operator overrides
        "auto_upgrade", "manual", "admin_manual", "manual_review",
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
    _PAID_EXTERNAL = {"soleaspay", "ashtecpay", "sendavapay", "izichange", "biztranspay",
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
