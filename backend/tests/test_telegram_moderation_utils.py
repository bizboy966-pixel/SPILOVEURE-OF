from datetime import datetime, timezone

import pytest
from mongomock_motor import AsyncMongoMockClient
from special_tasks import decide_paid_task
from telegram_moderation import _collect_media, _public_url, _safe_media_url, _summary, _utc_datetime


def test_telegram_public_url_prefers_dedicated_setting(monkeypatch):
    monkeypatch.setenv("TELEGRAM_PUBLIC_URL", "https://spiloveure.org/")
    monkeypatch.setenv("PUBLIC_APP_URL", "https://payments.example.org")
    assert _public_url() == "https://spiloveure.org"


def test_telegram_public_url_falls_back_to_shared_site_url(monkeypatch):
    monkeypatch.delenv("TELEGRAM_PUBLIC_URL", raising=False)
    monkeypatch.delenv("PUBLIC_APP_URL", raising=False)
    monkeypatch.setenv("SITE_URL", "https://spiloveure.org/")
    assert _public_url() == "https://spiloveure.org"


def test_collects_image_video_and_pdf_attachments(monkeypatch):
    monkeypatch.setenv("SITE_URL", "https://spiloveure.org")
    files = _collect_media({
        "images": ["/api/uploads/product.jpg"],
        "video_url": "https://cdn.example.org/promo.mp4",
        "documents": [{"url": "https://cdn.example.org/rules.pdf", "mime_type": "application/pdf"}],
    })
    assert files == [
        ("photo", "https://spiloveure.org/api/uploads/product.jpg"),
        ("video", "https://cdn.example.org/promo.mp4"),
        ("document", "https://cdn.example.org/rules.pdf"),
    ]


def test_media_urls_must_be_public_https(monkeypatch):
    monkeypatch.delenv("SITE_URL", raising=False)
    assert _safe_media_url("/api/uploads/private.jpg") is None
    assert _safe_media_url("http://cdn.example.org/image.jpg") is None
    assert _safe_media_url("https://127.0.0.1/private.jpg") is None
    assert _safe_media_url("https://cdn.example.org/image.jpg") == "https://cdn.example.org/image.jpg"


def test_config_expiry_accepts_mongo_naive_datetime():
    value = _utc_datetime(datetime(2026, 11, 15, 12, 0))
    assert value is not None
    assert value.tzinfo == timezone.utc


def test_moderation_summary_does_not_share_seller_phone():
    message = _summary("marketplace", {
        "name": "Produit", "seller_username": "vendeur", "category": "Maison",
        "price": 2500, "city": "Lomé", "whatsapp": "+22890000000",
        "description": "Annonce publique",
    })
    assert "Produit" in message
    assert "Nouvelle soumission — Marketplace" in message
    assert "vendeur" in message
    assert "+22890000000" not in message


def test_moderation_summary_uses_french_advertising_label():
    message = _summary("ads", {
        "title": "Annonce sponsorisée", "username": "annonceur",
        "duration_days": 7, "video_url": "",
    })
    assert "Nouvelle soumission — Publicité" in message
    assert "Nouvelle soumission — Ads" not in message


@pytest.mark.asyncio
async def test_rejected_paid_task_is_flagged_for_manual_refund():
    db = AsyncMongoMockClient().spiloveure_test
    await db.special_tasks.insert_one({
        "id": "paid-task", "user_id": "creator", "status": "pending_admin_review",
        "payment_confirmed_at": datetime.now(timezone.utc),
    })
    result = await decide_paid_task(db, "paid-task", "reject", "telegram:42")
    assert result["status"] == "rejected"
    assert result["refund_status"] == "manual_review_required"
    notice = await db.notifications.find_one({"user_id": "creator"})
    assert notice["kind"] == "special_task_rejected_refund_review"
