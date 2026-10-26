# Special task "new task" notifications + availability endpoint (iteration 62)
import os
import time
import uuid
import asyncio
import pytest
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}
ACTIF = {"email": "testactif@spilovere.com", "password": "TestActif2026!"}

FORCE_TASK = "56cc47b9-5cfb-4587-9a2e-616502300c71"   # pending_payment → force-activate
WATCH_TASK = "2f831f4b-04d9-4afa-b135-1c31df1bcee0"   # pending_payment → DB flip + watcher
DRAFT_TASK = "d88d6df7-8a3f-4936-ac6c-490593eb0e29"
PENDING_TASK = "ba13bc2f-44aa-4589-b287-b9b91cb5b6b1"
BACKFILL_TASK = "a806b47a-28f3-4bfd-8d1f-47697ba3336e"
BANNED_ID = "TEST_banned_" + uuid.uuid4().hex[:8]


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


async def _db_op(fn):
    c = AsyncIOMotorClient(os.environ["MONGO_URL"])
    try:
        return await fn(c[os.environ["DB_NAME"]])
    finally:
        c.close()


def db(fn):
    return asyncio.run(_db_op(fn))


def login(creds):
    r = requests.post(f"{API}/auth/login", json=creds, timeout=20)
    assert r.status_code == 200, r.text
    b = r.json()
    return b["access_token"], b["user"]


@pytest.fixture(scope="module")
def admin_h():
    t, _ = login(ADMIN)
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def actif():
    t, u = login(ACTIF)
    return {"Authorization": f"Bearer {t}"}, u


@pytest.fixture(scope="module", autouse=True)
def banned_user():
    db(lambda d: d.users.insert_one({"id": BANNED_ID, "email": f"{BANNED_ID}@x.com", "username": BANNED_ID,
                                      "status": "banned", "role": "user", "created_at": datetime.now(timezone.utc)}))
    yield
    db(lambda d: d.users.delete_one({"id": BANNED_ID}))
    db(lambda d: d.notifications.delete_many({"user_id": BANNED_ID}))


def count_notifs(task_id, **extra):
    q = {"meta.task_id": task_id, "kind": "special_task_new", **extra}
    return db(lambda d: d.notifications.count_documents(q))


def eligible_count(creator_id):
    return db(lambda d: d.users.count_documents({"id": {"$ne": creator_id}, "status": {"$ne": "banned"}}))


# --- Force-activate path ---
class TestForceActivate:
    def test_force_activate_notifies_once(self, admin_h):
        t = db(lambda d: d.special_tasks.find_one({"id": FORCE_TASK}))
        assert t["status"] == "pending_payment"
        assert count_notifs(FORCE_TASK) == 0
        r = requests.post(f"{API}/admin/special-tasks/{FORCE_TASK}/force-activate", headers=admin_h, timeout=60)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "active"
        n = count_notifs(FORCE_TASK)
        assert n == eligible_count(t["user_id"]), n
        assert count_notifs(FORCE_TASK, user_id=t["user_id"]) == 0  # creator excluded
        assert count_notifs(FORCE_TASK, user_id=BANNED_ID) == 0     # banned excluded
        # one per user
        dup = db(lambda d: d.notifications.aggregate([
            {"$match": {"meta.task_id": FORCE_TASK, "kind": "special_task_new"}},
            {"$group": {"_id": "$user_id", "c": {"$sum": 1}}}, {"$match": {"c": {"$gt": 1}}}]).to_list(10))
        assert dup == []
        sample = db(lambda d: d.notifications.find_one({"meta.task_id": FORCE_TASK}, {"_id": 0}))
        assert sample["title"] == "⚡ Nouvelle tâche spéciale disponible"
        assert sample["link"] == f"/tasks-more?task={FORCE_TASK}"
        assert sample["read"] is False

    def test_force_activate_again_400_no_dup(self, admin_h):
        before = count_notifs(FORCE_TASK)
        r = requests.post(f"{API}/admin/special-tasks/{FORCE_TASK}/force-activate", headers=admin_h, timeout=30)
        assert r.status_code == 400
        time.sleep(25)  # watcher tick must not duplicate either
        assert count_notifs(FORCE_TASK) == before

    def test_user_sees_notification_in_feed(self, actif):
        h, _ = actif
        r = requests.get(f"{API}/me/notifications?limit=50", headers=h, timeout=20)
        assert r.status_code == 200
        body = r.json()
        items = body.get("items", body) if isinstance(body, dict) else body
        assert any((i.get("link") or "") == f"/tasks-more?task={FORCE_TASK}" for i in items)


# --- Watcher path (status flipped directly in DB) ---
class TestWatcher:
    def test_db_flip_notified_by_watcher(self):
        t = db(lambda d: d.special_tasks.find_one({"id": WATCH_TASK}))
        assert t["status"] == "pending_payment"
        db(lambda d: d.special_tasks.update_one({"id": WATCH_TASK}, {"$set": {"status": "active",
                                                  "activated_at": datetime.now(timezone.utc)}}))
        deadline = time.time() + 50
        n = 0
        while time.time() < deadline:
            time.sleep(5)
            n = count_notifs(WATCH_TASK)
            if n >= eligible_count(t["user_id"]):
                break
        assert n == eligible_count(t["user_id"]), n
        time.sleep(25)
        assert count_notifs(WATCH_TASK) == n  # never duplicated
        assert db(lambda d: d.special_tasks.find_one({"id": WATCH_TASK}))["notified_at"] is not None

    def test_backfilled_task_has_no_notifications(self):
        t = db(lambda d: d.special_tasks.find_one({"id": BACKFILL_TASK}))
        assert t.get("notified_skipped") == "backfill"
        assert count_notifs(BACKFILL_TASK) == 0
        total_backfill = db(lambda d: d.special_tasks.distinct("id", {"notified_skipped": "backfill"}))
        assert db(lambda d: d.notifications.count_documents({"meta.task_id": {"$in": total_backfill}, "kind": "special_task_new"})) == 0


# --- Availability endpoint ---
class TestAvailability:
    def _get(self, h, tid):
        r = requests.get(f"{API}/special-tasks/{tid}/availability", headers=h, timeout=20)
        assert r.status_code == 200, r.text
        return r.json()

    def test_active_available(self, actif):
        d = self._get(actif[0], FORCE_TASK)
        assert d["available"] is True and d["status"] == "active"

    def test_draft_pending_unknown(self, actif):
        for tid in (DRAFT_TASK, PENDING_TASK, "nope-" + uuid.uuid4().hex):
            d = self._get(actif[0], tid)
            assert d["available"] is False and d["status"] == "unavailable", (tid, d)
            assert d["message"]

    def test_completed_and_full(self, actif):
        db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"status": "completed"}}))
        try:
            d = self._get(actif[0], FORCE_TASK)
            assert d["status"] == "completed" and d["message"] == "Toutes les places de cette tâche ont été prises."
        finally:
            db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"status": "active"}}))
        db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"quantity_completed": 10}}))
        try:
            assert self._get(actif[0], FORCE_TASK)["status"] == "completed"
        finally:
            db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"quantity_completed": 0}}))

    def test_paused_deactivated(self, actif):
        db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"status": "paused"}}))
        try:
            d = self._get(actif[0], FORCE_TASK)
            assert d["available"] is False and d["message"] == "Cette tâche a été désactivée."
        finally:
            db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"status": "active"}}))

    def test_own_task(self, actif):
        h, u = actif
        orig = db(lambda d: d.special_tasks.find_one({"id": FORCE_TASK}))["user_id"]
        db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"user_id": u["id"]}}))
        try:
            assert self._get(h, FORCE_TASK)["status"] == "own"
        finally:
            db(lambda d: d.special_tasks.update_one({"id": FORCE_TASK}, {"$set": {"user_id": orig}}))

    def test_done_by_user(self, actif):
        h, u = actif
        cid = "TEST_" + uuid.uuid4().hex
        db(lambda d: d.special_task_completions.insert_one({"id": cid, "task_id": FORCE_TASK, "user_id": u["id"], "status": "approved"}))
        try:
            assert self._get(h, FORCE_TASK)["status"] == "done"
        finally:
            db(lambda d: d.special_task_completions.delete_one({"id": cid}))

    def test_requires_auth(self):
        r = requests.get(f"{API}/special-tasks/{FORCE_TASK}/availability", timeout=20)
        assert r.status_code in (401, 403)
