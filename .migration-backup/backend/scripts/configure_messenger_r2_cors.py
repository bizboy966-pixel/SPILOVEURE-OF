"""Show or apply the browser CORS policy required by Chat direct uploads."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import messenger_r2 as r2  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply the CORS policy to the configured private R2 bucket.",
    )
    args = parser.parse_args()
    origins = sorted({
        value.strip().rstrip("/")
        for value in os.environ.get("R2_ALLOWED_ORIGINS", "").split(",")
        if value.strip()
    })
    if not origins:
        parser.error("Set R2_ALLOWED_ORIGINS to comma-separated HTTPS origins first.")
    policy = {
        "CORSRules": [{
            "AllowedOrigins": origins,
            "AllowedMethods": ["GET", "HEAD", "PUT"],
            "AllowedHeaders": ["Content-Type", "Content-Length", "Range"],
            "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
            "MaxAgeSeconds": 3600,
        }],
    }
    if not args.apply:
        print(json.dumps(policy, indent=2))
        print("No changes made. Re-run with --apply to update the R2 bucket.")
        return 0
    r2.configure_bucket_cors(origins)
    print("R2 CORS policy applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
