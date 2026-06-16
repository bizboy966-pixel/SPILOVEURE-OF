"""Regression: SoleasPay normalize_status accepts various 'success' textual forms."""
import sys; sys.path.insert(0, '/app/backend')
from soleaspay import normalize_status


def test_known_success_keywords_paid():
    for s in ("SUCCESS", "success", "Success", "SUCCÈS", "SUCCES",
              "VALIDATED", "VALIDÉ", "COMPLETED", "CONFIRMED",
              "APPROVED", "PAID", "PAYE"):
        assert normalize_status(s) == "paid", f"{s!r} must be paid"


def test_known_failure_keywords_failed():
    for s in ("FAILED", "ECHEC", "ÉCHEC", "CANCELLED", "REFUSED",
              "REJECTED", "DECLINED", "EXPIRED"):
        assert normalize_status(s) == "failed", f"{s!r} must be failed"


def test_unknown_status_with_success_flag_paid():
    """If textual status is unknown but `success=true`, treat as paid (permissive)."""
    assert normalize_status("PROCESSED_OK", success_flag=True, code=200) == "paid"
    assert normalize_status("DONE", success_flag=True, code=201) == "paid"


def test_unknown_status_without_success_flag_pending():
    """Unknown status with no success flag remains pending."""
    assert normalize_status("PROCESSING") == "pending"
    assert normalize_status("RECEIVED") == "pending"
    assert normalize_status("") == "pending"


def test_unknown_status_with_failure_code_pending():
    """Unknown status with code >= 400 should not be auto-paid."""
    assert normalize_status("UNKNOWN", success_flag=True, code=500) == "pending"


def test_user_account_activated_via_soleaspay_source():
    """Direct activate_level(source='soleaspay') must update status to 'active'."""
    import asyncio, os, uuid
    from datetime import datetime, timezone
    from motor.motor_asyncio import AsyncIOMotorClient
    from matrix import activate_level
    import auth as _auth

    async def run():
        cli = AsyncIOMotorClient(os.environ.get('MONGO_URL', 'mongodb://localhost:27017'))
        db = cli[os.environ.get('DB_NAME', 'spilivere')]
        admin = await db.users.find_one({'role': 'admin'}, {'_id': 0})
        uid = str(uuid.uuid4())
        await db.users.insert_one({
            'id': uid, 'username': f'spt_{uid[:6]}', 'email': f'spt_{uid[:6]}@x.com',
            'phone': '+228x', 'country': 'TG',
            'password_hash': _auth.hash_password('x'),
            'role': 'user', 'status': 'pending', 'max_level': 0,
            'sponsor_id': admin['id'], 'sponsor_username': 'admin',
            'balance_profit': 0, 'balance_upgrade': 0,
            'commission_direct': 0, 'commission_spillover': 0,
            'total_earned': 0, 'total_withdrawn': 0,
            'created_at': datetime.now(timezone.utc),
        })
        try:
            await activate_level(db, uid, 1, source="soleaspay")
            u = await db.users.find_one({'id': uid}, {'_id': 0})
            assert u['status'] == 'active', f"status must be 'active', got {u['status']!r}"
            assert u['max_level'] == 1, f"max_level must be 1, got {u['max_level']}"
        finally:
            await db.users.delete_one({'id': uid})
            await db.matrix_placements.delete_many({'user_id': uid})
            await db.commissions.delete_many({'$or': [{'user_id': uid}, {'from_user_id': uid}]})
        cli.close()

    asyncio.get_event_loop().run_until_complete(run())
