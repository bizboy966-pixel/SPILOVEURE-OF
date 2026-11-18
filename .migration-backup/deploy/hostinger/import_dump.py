"""Import an Emergent 'Dump DB' JSON zip into the VPS MongoDB (replaces collections)."""
import json
import os
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime

from bson import ObjectId
from pymongo import MongoClient

NAIVE_DATE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$")
HEX24 = re.compile(r"^[0-9a-f]{24}$")


def convert(v):
    if isinstance(v, dict):
        return {k: convert(x) for k, x in v.items()}
    if isinstance(v, list):
        return [convert(x) for x in v]
    if isinstance(v, str) and NAIVE_DATE.match(v):
        return datetime.fromisoformat(v)
    return v


def main(path):
    db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
    z = zipfile.ZipFile(path)
    groups = defaultdict(list)
    for name in sorted(z.namelist()):
        if name.endswith(".json"):
            groups[re.sub(r"_part\d+$", "", name[:-5])].append(name)
    total = 0
    for coll, files in sorted(groups.items()):
        db[coll].drop()
        count = 0
        for f in files:
            docs = []
            for d in json.loads(z.read(f)):
                d = convert(d)
                if isinstance(d.get("_id"), str) and HEX24.match(d["_id"]):
                    d["_id"] = ObjectId(d["_id"])
                docs.append(d)
            for i in range(0, len(docs), 1000):
                db[coll].insert_many(docs[i:i + 1000], ordered=False)
            count += len(docs)
        total += count
        print(f"{coll}: {count}")
    print(f"TERMINE: {len(groups)} collections, {total} documents importes")


if __name__ == "__main__":
    main(sys.argv[1])
