# Helper: snapshot challenges + special_tasks feed comparison for /tasks-more testing
import os, sys, json, requests
from pymongo import MongoClient
from dotenv import dotenv_values

env = dotenv_values("/app/backend/.env")
db = MongoClient(env["MONGO_URL"])[env["DB_NAME"]]
BASE = dotenv_values("/app/frontend/.env")["REACT_APP_BACKEND_URL"].rstrip("/")

def login(e, p):
    r = requests.post(f"{BASE}/api/auth/login", json={"email": e, "password": p}, timeout=30)
    r.raise_for_status()
    d = r.json()
    return d.get("token") or d.get("access_token")

cmd = sys.argv[1]
if cmd == "snapshot":
    for c in db.challenges.find({}, {"_id": 0}):
        print("CH", {k: str(v) for k, v in c.items()})
    u = db.users.find_one({"email": "testactif@spilovere.com"}, {"id": 1})
    comp = db.special_task_completions.distinct("task_id", {"user_id": u["id"], "status": {"$ne": "rejected"}})
    exp = [t["id"] for t in db.special_tasks.find({"status": "active", "user_id": {"$ne": u["id"]}, "id": {"$nin": comp}})]
    print("STATUSES", {s: db.special_tasks.count_documents({"status": s}) for s in db.special_tasks.distinct("status")})
    print("EXPECTED_FEED", len(exp), exp)
    tok = login("testactif@spilovere.com", "TestActif2026!")
    h = {"Authorization": f"Bearer {tok}"}
    f = requests.get(f"{BASE}/api/special-tasks", headers=h).json()
    print("API_FEED", len(f["items"]), [i["id"] for i in f["items"]], [i["status"] for i in f["items"]])
    print("CURRENT", requests.get(f"{BASE}/api/challenges/current", headers=h).json())
elif cmd == "create":
    # create active challenge; mode = now | expired
    from datetime import datetime, timedelta, timezone
    mode = sys.argv[2]
    now = datetime.now(timezone.utc)
    if mode == "now":
        s, e = now - timedelta(days=1), now + timedelta(days=10)
    else:
        s, e = now - timedelta(days=10), now - timedelta(days=1)
    tok = login("kossikotokou4@gmail.com", "@Emma91972006")
    r = requests.post(f"{BASE}/api/admin/challenges", headers={"Authorization": f"Bearer {tok}"},
                      json={"name": f"TEST_Challenge_{mode}", "target": 5, "reward_amount": 2500,
                            "reward_currency": "FCFA", "start_at": s.isoformat(), "end_at": e.isoformat(), "active": True})
    print(r.status_code, r.json())
elif cmd == "cleanup":
    tok = login("kossikotokou4@gmail.com", "@Emma91972006")
    for c in db.challenges.find({"name": {"$regex": "^TEST_Challenge_"}}):
        r = requests.delete(f"{BASE}/api/admin/challenges/{c['id']}", headers={"Authorization": f"Bearer {tok}"})
        print("deleted", c["id"], r.status_code)
    r = db.challenges.update_one({"name": "Challenge 100 invites"}, {"$set": {"active": False}})
    print("restored", r.matched_count)
