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


def test_video_size_limit_is_preserved(chat):
    cid = conversation(chat)
    response = call(chat, "post", f"/conversations/{cid}/files",
                    files={"file": ("too-big.mp4", b"x" * (20 * 1024 * 1024 + 1), "video/mp4")})
    assert response.status_code == 413
    assert "20 Mo" in response.json()["detail"]
