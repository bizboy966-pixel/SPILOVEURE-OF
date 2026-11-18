"""Conversation video uploads remain private and retain trusted media types."""
import pytest
from test_messenger import chat, call, conversation, message, auth


@pytest.mark.parametrize("filename,mime", [
    ("clip.mp4", "video/mp4"), ("clip.MOV", "video/quicktime"),
    ("clip.webm", "video/webm"), ("clip.M4V", "video/mp4"),
    ("clip.3gp", "video/3gpp"), ("clip.3g2", "video/3gpp2"),
])
def test_mobile_video_formats_upload_send_and_download_privately(chat, filename, mime):
    cid = conversation(chat)
    data = b"synthetic-video-container-for-upload-test"
    result = call(chat, "post", f"/conversations/{cid}/files",
                  files={"file": (filename, data, "application/octet-stream")})
    assert result.status_code == 200
    attached = result.json()
    assert attached["mime"] == mime
    assert chat[0].get(attached["url"], headers=auth("bob")).status_code == 404
    assert chat[0].get(attached["url"]).status_code == 401
    assert message(chat, cid, attachments=[attached]).status_code == 200
    response = chat[0].get(attached["url"], headers=auth("bob"))
    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-type"] == mime
    assert response.headers["x-content-type-options"] == "nosniff"


def test_video_support_does_not_reclassify_voice_recordings(chat):
    cid = conversation(chat)
    response = call(chat, "post", f"/conversations/{cid}/files",
                    files={"file": ("voice.webm", b"synthetic-voice", "audio/webm;codecs=opus")})
    assert response.status_code == 200
    assert response.json()["mime"] == "audio/webm"


def test_view_once_voice_is_consumed_per_recipient(chat):
    cid = conversation(chat, "group")
    uploaded = call(
        chat, "post", f"/conversations/{cid}/files",
        files={"file": ("voice.webm", b"synthetic-voice", "audio/webm")},
        data={"duration_seconds": "2.4", "view_once": "true"},
    )
    assert uploaded.status_code == 200, uploaded.text
    attachment = uploaded.json()
    assert attachment["view_once"] is True
    sent = message(chat, cid, attachments=[attachment])
    assert sent.status_code == 200, sent.text

    first_open = chat[0].get(attachment["url"], headers=auth("bob"))
    assert first_open.status_code == 200
    assert first_open.content == b"synthetic-voice"
    assert chat[0].get(attachment["url"], headers=auth("bob")).status_code == 410
    assert chat[0].get(attachment["url"], headers=auth("alice")).status_code == 200

    bob_messages = call(chat, "get", f"/conversations/{cid}/messages", "bob").json()["items"]
    bob_attachment = bob_messages[-1]["attachments"][0]
    assert bob_attachment["view_once"] is True
    assert bob_attachment["view_once_opened"] is True

    joined = call(chat, "post", f"/conversations/{cid}/members", json={"user_id": "eve", "action": "add"})
    assert joined.status_code == 200
    assert chat[0].get(attachment["url"], headers=auth("eve")).status_code == 200
    assert chat[0].get(attachment["url"], headers=auth("eve")).status_code == 410


def test_view_once_rejects_non_audio_uploads(chat):
    cid = conversation(chat)
    response = call(
        chat, "post", f"/conversations/{cid}/files",
        files={"file": ("photo.jpg", b"not-a-real-image", "image/jpeg")},
        data={"view_once": "true"},
    )
    assert response.status_code == 400


def test_video_size_limit_is_preserved(chat):
    cid = conversation(chat)
    response = call(chat, "post", f"/conversations/{cid}/files",
                    files={"file": ("too-big.mp4", b"x" * (20 * 1024 * 1024 + 1), "video/mp4")})
    assert response.status_code == 413
    assert "20 Mo" in response.json()["detail"]
