#!/usr/bin/env python3
"""Verify an already signed/tested production APK, retain versions, stage atomically.

Does not build, sign, scan or attest that physical device tests were performed.
Those must happen first; this command requires the corresponding evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timezone


CHECKS = ("registration", "login", "email_verification", "activation_payment",
          "chat", "notifications", "navigation", "performance")


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def stage(args):
    apk, root = args.apk.resolve(), args.directory.resolve()
    evidence = json.loads(args.validation_report.read_text())
    actual_hash = digest(apk)
    if evidence.get("apk_sha256") != actual_hash:
        raise ValueError("Le rapport doit concerner exactement l’APK fourni (SHA-256).")
    devices = evidence.get("physical_devices", [])
    if len(devices) < 2 or len({(d.get("model"), d.get("android_version")) for d in devices}) < 2:
        raise ValueError("Deux appareils physiques compatibles et distincts doivent être documentés.")
    for device in devices:
        if device.get("physical") is not True or not device.get("model") or not device.get("android_version"):
            raise ValueError("Chaque appareil réel doit être identifié.")
        if not all(device.get("checks", {}).get(check) == "passed" for check in CHECKS):
            raise ValueError("Tous les parcours exigés doivent réussir sur chaque appareil.")
    scan = evidence.get("security_scan", {})
    if (not scan.get("tool") or not scan.get("report_path") or scan.get("result") != "passed"
            or not Path(scan["report_path"]).is_file()):
        raise ValueError("Rapport réel d’analyse de sécurité requis.")
    if evidence.get("play_protect") != "verified_on_devices":
        raise ValueError("Vérification Play Protect sur les appareils requise, sans contournement.")
    signature = subprocess.run(["apksigner", "verify", "--verbose", "--print-certs", str(apk)],
                               check=True, capture_output=True, text=True).stdout
    certs = re.findall(r"certificate SHA-256 digest:\s*([a-fA-F0-9]+)", signature)
    expected = args.expected_signer_sha256.lower().replace(":", "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or not certs or any(c.lower() != expected for c in certs):
        raise ValueError("La signature ne correspond pas au certificat officiel attendu.")
    if re.search(r"android debug", signature, re.I):
        raise ValueError("Une signature Android de débogage n’est pas autorisée.")
    metadata = subprocess.run(["aapt", "dump", "badging", str(apk)], check=True,
                              capture_output=True, text=True).stdout
    match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", metadata)
    if not match or match[1] != "com.spilivere.app" or "application-debuggable" in metadata:
        raise ValueError("Identifiant Android invalide ou application débogable.")
    version, code = match[3], int(match[2])
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Version stable x.y.z requise.")
    min_sdk = re.search(r"sdkVersion:'(\d+)'", metadata)
    if not min_sdk:
        raise ValueError("Version Android minimale introuvable.")
    manifest = root / "releases.json"
    history = json.loads(manifest.read_text()) if manifest.exists() else []
    if any(r["version"] == version or r["version_code"] >= code for r in history):
        raise ValueError("Chaque version et code Android doit être nouveau et croissant.")
    if any(r["signer_sha256"] != expected for r in history):
        raise ValueError("La clé doit rester identique aux versions précédentes.")
    root.mkdir(parents=True, exist_ok=True)
    destination = root / f"spiloveure-{version}.apk"
    if destination.exists():
        raise ValueError("Ne pas écraser un APK archivé.")
    temporary = root / f".spiloveure-{version}.apk.tmp"
    shutil.copyfile(apk, temporary)
    if digest(temporary) != actual_hash:
        temporary.unlink()
        raise ValueError("Copie corrompue.")
    os.replace(temporary, destination)
    record = {"version": version, "version_code": code, "package": match[1],
              "size_bytes": destination.stat().st_size, "published_at": datetime.now(timezone.utc).isoformat(),
              "sha256": actual_hash, "signer_sha256": expected, "validated": True,
              "min_android": f"API {min_sdk[1]}"}
    # Retain evidence outside public download routes.
    (root / f"validation-{version}.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    temp_manifest = root / ".releases.json.tmp"
    temp_manifest.write_text(json.dumps([record, *history], ensure_ascii=False, indent=2))
    os.replace(temp_manifest, manifest)
    print(f"APK vérifié et préparé : {version} ; SHA-256 : {actual_hash}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--validation-report", type=Path, required=True)
    parser.add_argument("--expected-signer-sha256", required=True, help="Public certificate fingerprint, not a private key")
    arguments = parser.parse_args()
    try:
        stage(arguments)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Publication refusée : {error}\n")
