import pytest

import backend.messenger_r2 as r2


class Presigner:
    def __init__(self):
        self.calls = []

    def generate_presigned_url(self, operation, **kwargs):
        self.calls.append((operation, kwargs))
        return "https://r2.example/signed"


def _configured(monkeypatch):
    for key, value in {
        "R2_ACCOUNT_ID": "test-account",
        "R2_BUCKET_NAME": "chat-files",
        "R2_ACCESS_KEY_ID": "test-access",
        "R2_SECRET_ACCESS_KEY": "test-secret",
    }.items():
        monkeypatch.setenv(key, value)


def test_unconfigured_storage_fails_explicitly(monkeypatch):
    for key in ("R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(r2.R2NotConfigured):
        r2.create_upload_url("file-1", "image/png", 10)


def test_object_keys_are_scoped_and_reject_path_input():
    assert r2.object_key("file-1") == "messenger/file-1"
    with pytest.raises(ValueError):
        r2.object_key("../outside")


def test_upload_signature_is_bound_to_key_type_and_size(monkeypatch):
    _configured(monkeypatch)
    fake = Presigner()
    monkeypatch.setattr(r2, "_client", lambda: fake)

    url = r2.create_upload_url("file-1", "image/png", 1234, expires=900)

    operation, options = fake.calls[0]
    assert url == "https://r2.example/signed"
    assert operation == "put_object"
    assert options["Params"] == {
        "Bucket": "chat-files",
        "Key": "messenger/file-1",
        "ContentType": "image/png",
        "ContentLength": 1234,
    }
    assert options["ExpiresIn"] == 900
    assert options["HttpMethod"] == "PUT"


def test_download_signature_is_private_and_sets_safe_disposition(monkeypatch):
    _configured(monkeypatch)
    fake = Presigner()
    monkeypatch.setattr(r2, "_client", lambda: fake)

    r2.create_download_url("file-1", "application/pdf", 'rapport "final".pdf', download=True)

    operation, options = fake.calls[0]
    assert operation == "get_object"
    params = options["Params"]
    assert params["Bucket"] == "chat-files"
    assert params["Key"] == "messenger/file-1"
    assert params["ResponseContentType"] == "application/pdf"
    assert params["ResponseCacheControl"] == "private, no-store, max-age=0"
    assert params["ResponseContentDisposition"].startswith("attachment;")
    assert "filename*=UTF-8''rapport%20%27final%27.pdf" in params["ResponseContentDisposition"]
