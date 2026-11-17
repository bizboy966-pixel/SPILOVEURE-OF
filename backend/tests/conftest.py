"""Shared pytest configuration for the backend test-suite.

Python 3.11 removed the implicit main-thread event loop and pytest-asyncio
unsets/closes the current loop after each async test.  Several legacy test
modules use a synchronous `_run(...)` helper together with a module-scoped
Motor client, which resolves `asyncio.get_event_loop()` eagerly.  When such a
module runs *after* an async (pytest-asyncio) module, `get_event_loop()` raises
`RuntimeError: There is no current event loop`.

To keep the suite runnable as a whole (and mirror the pre-3.10 behaviour) we
install a tolerant event-loop policy that lazily (re)creates a loop instead of
raising.  This only affects the test process, never application code.
"""
import asyncio
import io
from botocore.exceptions import ClientError
import pytest
from starlette.responses import Response


class _FakeR2Body(io.BytesIO):
    def iter_chunks(self, chunk_size=64 * 1024):
        while chunk := self.read(chunk_size):
            yield chunk


@pytest.fixture
def fake_r2_storage(monkeypatch):
    """Isolated in-memory R2 for API tests; never contacts a Cloudflare account."""
    import messenger_r2

    for key, value in {
        "R2_ACCOUNT_ID": "pytest-account",
        "R2_BUCKET_NAME": "pytest-chat",
        "R2_ACCESS_KEY_ID": "pytest-access",
        "R2_SECRET_ACCESS_KEY": "pytest-secret",
    }.items():
        monkeypatch.setenv(key, value)

    objects = {}

    def put_upload(file_id, body, content_type, size):
        content = body.read() if hasattr(body, "read") else bytes(body)
        objects[file_id] = {"body": content, "mime": content_type, "size": size}

    def head_upload(file_id):
        if file_id not in objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "HeadObject")
        item = objects[file_id]
        return {"ContentLength": item["size"], "ContentType": item["mime"]}

    def get_upload(file_id):
        if file_id not in objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        item = objects[file_id]
        return {"Body": _FakeR2Body(item["body"]), "ContentType": item["mime"]}

    monkeypatch.setattr(messenger_r2, "put_upload", put_upload)
    monkeypatch.setattr(messenger_r2, "head_upload", head_upload)
    monkeypatch.setattr(messenger_r2, "get_upload", get_upload)
    monkeypatch.setattr(messenger_r2, "delete_upload", lambda fid: objects.pop(fid, None))
    monkeypatch.setattr(messenger_r2, "create_upload_url", lambda fid, *_args: f"https://r2.test/{fid}")
    monkeypatch.setattr(messenger_r2, "create_download_url", lambda fid, *_args: f"/__test_r2/{fid}")
    monkeypatch.setattr(messenger_r2, "configure_bucket_cors", lambda _origins: None)

    def mount(app):
        @app.get("/__test_r2/{file_id}")
        async def serve_fake_r2_object(file_id: str):
            item = objects.get(file_id)
            if item is None:
                return Response(status_code=404)
            return Response(item["body"], media_type=item["mime"], headers={
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
            })

    return mount


class _TolerantEventLoopPolicy(asyncio.DefaultEventLoopPolicy):
    def get_event_loop(self):
        try:
            loop = super().get_event_loop()
        except RuntimeError:
            loop = None
        if loop is None or loop.is_closed():
            loop = self.new_event_loop()
            self.set_event_loop(loop)
        return loop


asyncio.set_event_loop_policy(_TolerantEventLoopPolicy())
