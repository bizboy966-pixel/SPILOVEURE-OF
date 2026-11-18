"""Narrow access rules for new onboarding accounts; legacy accounts are unchanged."""
import os
import re


def activated(user):
    return user.get("role") == "admin" or (
        user.get("status") == "active" and int(user.get("max_level") or 0) >= 1
    )


def password_created(user):
    return bool(user.get("main_password_created", bool(user.get("password_hash"))))


def email_verified(user):
    # Changing an address must never inherit ownership of the previous one.
    return bool(user.get("email_verified")) and (
        user.get("email_verified_address") == str(user.get("email", "")).lower()
    )


def isolated_chat_preview_enabled():
    return (
        os.environ.get("SPV_ISOLATED_CHAT_PREVIEW") == "1"
        and os.environ.get("SPV_PREVIEW_MODE") == "isolated"
        and os.environ.get("DB_NAME") == "spiloveure_local_development"
        and os.environ.get("MONGO_URL") == "mongodb://127.0.0.1:27017"
    )


def chat_access_allowed(user):
    """Allow only the seeded preview account to bypass email verification in isolated dev."""
    return email_verified(user) or (
        isolated_chat_preview_enabled()
        and user.get("preview_test_account") is True
        and str(user.get("username", "")).casefold() == "preview_test_b02606"
    )


def onboarding_path_allowed(path, method="GET"):
    # Existing payment handlers still authenticate normally. This list never
    # exposes marketplace, balances, transfers, withdrawals or admin APIs.
    if path in ("/api/auth/me", "/api/config", "/api/settings/activation-videos"):
        return method == "GET"
    if method == "GET" and re.fullmatch(r"/api/payments/[^/]+/status", path):
        return True
    return path.startswith((
        "/api/identity/", "/api/payments/activation-catalog",
        "/api/payments/activate", "/api/payments/activation/",
        "/api/payments/ashtec/", "/api/activations/",
        "/api/payments/moneyfusion/",
    ))


def main_ready(user):
    # Email ownership gates SPILOVEURE Chat only. Main-platform access is
    # granted after payment activation and password creation.
    return activated(user) and password_created(user)
