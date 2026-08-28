"""Helper: send a real (valid) 1-second WAV voice note as the admin user via the
public API so the frontend custom VoiceMessage player can be exercised in E2E."""
import base64
import io
import os
import struct
import sys
import wave

import requests
from dotenv import dotenv_values

BASE_URL = (dotenv_values("/app/frontend/.env").get("REACT_APP_BACKEND_URL") or "").rstrip("/")
EMAIL = "kossikotokou4@gmail.com"
PASSWORD = "@Emma91972006"


def wav_data_url(seconds=2, rate=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", 0) for _ in range(rate * seconds)))
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    r.raise_for_status()
    tok = r.json()["access_token"]
    r = s.post(f"{BASE_URL}/api/chat/me/messages",
               json={"audio": wav_data_url()}, headers={"Authorization": f"Bearer {tok}"}, timeout=60)
    print(r.status_code, r.text[:200])
    if r.status_code != 200:
        sys.exit(1)
    print("MSG_ID=" + r.json()["id"])


if __name__ == "__main__":
    main()
