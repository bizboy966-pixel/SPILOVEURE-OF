"""Iteration 33 extras: /verify 403 cross-user, /v1/webhooks/{id} alias
signature enforcement + payment.failed → rejected + payment.completed reset,
and admin activations enrichment for crypto_auto."""
from __future__ import annotations
import hashlib, hmac, json, os, time, uuid
from datetime import datetime, timezone

import pytest, requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "spilivere")
SECRET = os.environ.get("BIZ_TRANSPAY_WEBHOOK_SECRET",
                        "sk_live_u0AYopb6VDIwhTT-jx-7VyX9znCpjrlobxY_BvwzxFc")
WEBHOOK_ID = os.environ.get("BIZ_TRANSPAY_WEBHOOK_ID",
                            "4055dfdd-33f2-43d4-ab7e-58a9c6c6810b")
ADMIN = ("kossikotokou4@gmail.com", "@Emma91972006")


def _sign(raw: bytes, ts: str) -> str:
    return hmac.new(SECRET.encode(), f"{ts}.{raw.decode()}".encode(),
                    hashlib.sha256).hexdigest()


def _register(s, tag):
    suffix = uuid.uuid4().hex[:8]
    email = f"{tag}_{suffix}@example.com"
    pw = "Passw0rd!"
    r = s.post(f"{BASE_URL}/api/auth/register", json={
        "username": f"{tag}_{suffix}", "email": email, "password": pw,
        "password_confirm": pw, "sponsor_username": "admin",
        "country": "TG", "phone": f"+228900{suffix[:5]}", "accept_terms": True,
    }, timeout=15)
    assert r.status_code in (200, 201), r.text
    lg = s.post(f"{BASE_URL}/api/auth/login",
                json={"email": email, "password": pw}, timeout=15).json()
    tok = lg.get("access_token") or lg.get("token")
    return {"email": email, "id": lg["user"]["id"],
            "headers": {"Authorization": f"Bearer {tok}"}}


@pytest.fixture(scope="module")
def admin_headers():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN[0], "password": ADMIN[1]}, timeout=15)
    j = r.json()
    tok = j.get("access_token") or j.get("token")
    # ensure flag on
    s.put(f"{BASE_URL}/api/admin/feature-flags/crypto_auto",
          headers={"Authorization": f"Bearer {tok}"},
          json={"enabled": True}, timeout=10)
    return {"Authorization": f"Bearer {tok}"}


def test_verify_403_cross_user(admin_headers):
    """User A creates a charge; User B tries to /verify it → 403."""
    s = requests.Session()
    ua = _register(s, "vfy_a")
    ub = _register(s, "vfy_b")
    cr = s.post(f"{BASE_URL}/api/activations/crypto-auto/create",
                headers=ua["headers"], json={"level": 1}, timeout=45)
    if cr.status_code != 200:
        pytest.skip(f"gateway unavailable ({cr.status_code})")
    ref = cr.json()["reference"]
    r = s.post(f"{BASE_URL}/api/activations/crypto-auto/verify",
               headers=ub["headers"],
               json={"reference": ref, "tx_hash": "0x" + "b" * 64}, timeout=15)
    assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"


def test_new_webhook_alias_missing_signature_401():
    """New /api/v1/webhooks/{webhook_id} alias must enforce signature."""
    s = requests.Session()
    url = f"{BASE_URL}/api/v1/webhooks/{WEBHOOK_ID}"
    r = s.post(url, data="{}", headers={"Content-Type": "application/json"}, timeout=10)
    assert r.status_code == 401, f"expected 401 on new alias, got {r.status_code} {r.text}"


def test_new_webhook_alias_invalid_signature_401():
    s = requests.Session()
    url = f"{BASE_URL}/api/v1/webhooks/{WEBHOOK_ID}"
    ts = str(int(time.time()))
    r = s.post(url, data="{}", headers={
        "Content-Type": "application/json",
        "X-BizTransPay-Timestamp": ts,
        "X-BizTransPay-Signature": "sha256=deadbeef"}, timeout=10)
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_new_webhook_alias_payment_failed_then_completed(admin_headers):
    """Full flow through the NEW /api/v1/webhooks/{id} URL:
       1) seed pending payment + activation
       2) payment.failed → activation rejected, user max_level still 0
       3) payment.completed → activation validated, max_level=1"""
    s = requests.Session()
    u = _register(s, "vfy_hook")
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    url = f"{BASE_URL}/api/v1/webhooks/{WEBHOOK_ID}"
    try:
        ref = f"SPLV_ITER33_{uuid.uuid4().hex[:8]}"
        now = datetime.now(timezone.utc)
        await db.payments.insert_one({
            "reference": ref, "provider": "biz_transpay",
            "user_id": u["id"], "level": 1,
            "amount": 5, "currency": "USDT", "network": "BEP20",
            "status": "pending", "created_at": now, "updated_at": now,
        })
        await db.activations.insert_one({
            "id": str(uuid.uuid4()), "user_id": u["id"],
            "level": 1, "status": "pending",
            "payment_method": "crypto_auto", "reference": ref,
            "amount": 5, "currency": "USDT", "created_at": now,
        })

        # 2) payment.failed
        body = json.dumps({
            "event_type": "payment.failed",
            "payload": {"reference": ref, "status": "failed",
                        "tx_hash": "0x" + "d" * 64, "network": "BEP20"}
        }).encode()
        ts = str(int(time.time()))
        r = s.post(url, data=body, headers={
            "Content-Type": "application/json",
            "X-BizTransPay-Timestamp": ts,
            "X-BizTransPay-Signature": f"sha256={_sign(body, ts)}",
            "X-BizTransPay-Event-Id": f"evt_{uuid.uuid4().hex}"}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get("rejected") is True

        act = await db.activations.find_one({"reference": ref})
        assert act["status"] == "rejected", act
        usr = await db.users.find_one({"id": u["id"]}, {"_id": 0, "max_level": 1})
        assert usr.get("max_level", 0) == 0

        # 3) Reset: manually put activation back to pending, then send completed
        await db.activations.update_one({"reference": ref},
                                        {"$set": {"status": "pending"}})
        await db.payments.update_one({"reference": ref},
                                     {"$set": {"status": "pending",
                                               "activation_done": False}})
        body2 = json.dumps({
            "event_type": "payment.completed",
            "payload": {"reference": ref, "status": "completed",
                        "amount_paid": 5, "tx_hash": "0x" + "e" * 64,
                        "network": "BEP20"}
        }).encode()
        ts2 = str(int(time.time()))
        r2 = s.post(url, data=body2, headers={
            "Content-Type": "application/json",
            "X-BizTransPay-Timestamp": ts2,
            "X-BizTransPay-Signature": f"sha256={_sign(body2, ts2)}",
            "X-BizTransPay-Event-Id": f"evt_{uuid.uuid4().hex}"}, timeout=15)
        assert r2.status_code == 200, r2.text
        assert r2.json().get("activated") is True, r2.json()

        act2 = await db.activations.find_one({"reference": ref})
        assert act2["status"] == "validated", act2
        usr2 = await db.users.find_one({"id": u["id"]}, {"_id": 0, "max_level": 1, "status": 1})
        assert usr2.get("max_level", 0) >= 1
        assert usr2.get("status") == "active"
    finally:
        client.close()


def test_admin_activations_enriches_crypto_auto(admin_headers):
    """After a user creates a crypto_auto charge, admin_list_activations must
    return deposit_address + network for that pending row."""
    s = requests.Session()
    u = _register(s, "adm_enrich")
    cr = s.post(f"{BASE_URL}/api/activations/crypto-auto/create",
                headers=u["headers"], json={"level": 1}, timeout=45)
    if cr.status_code != 200:
        pytest.skip("gateway unavailable")
    ref = cr.json()["reference"]
    addr = cr.json()["deposit_address"]

    r = s.get(f"{BASE_URL}/api/admin/activations?status=pending&limit=100",
              headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    items = body if isinstance(body, list) else (body.get("items") or body.get("activations") or [])
    match = next((a for a in items if a.get("reference") == ref), None)
    assert match is not None, f"reference {ref} not found in admin list"
    assert match.get("payment_method") == "crypto_auto"
    assert match.get("deposit_address") == addr, f"missing/incorrect deposit_address: {match}"
    assert (match.get("network") or "").upper() == "BEP20"
