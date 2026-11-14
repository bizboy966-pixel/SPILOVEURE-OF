"""Replaceable transactional mail adapters. Never log verification codes."""
from __future__ import annotations

import os
import json
import smtplib
import ssl
import subprocess
import time
from pathlib import Path
from email.message import EmailMessage

import httpx


class MailUnavailable(Exception):
    pass


_connector_ready = (0, False)


def connector_call(mode, body=None):
    try:
        process = subprocess.run(
            ["node", str(Path(__file__).with_name("resend_connector.mjs")), mode],
            input=json.dumps(body) if body else "", text=True, capture_output=True,
            timeout=20, check=False,
        )
        return process.returncode == 0 and json.loads(process.stdout).get("ok") is True
    except Exception:
        return False


class VerificationEmailSender:
    def configured(self):
        provider = os.getenv("MAIL_PROVIDER", "").lower()
        sender = os.getenv("MAIL_FROM", "")
        if not sender or "\n" in sender or "\r" in sender:
            return False
        if provider == "smtp":
            return bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_USERNAME") and os.getenv("SMTP_PASSWORD"))
        if provider == "resend":
            return bool(os.getenv("RESEND_API_KEY")) and os.getenv("MAIL_DOMAIN_VERIFIED") == "1"
        if provider == "resend_connector" and os.getenv("MAIL_RESEND_DOMAIN_ID"):
            global _connector_ready
            checked, ready = _connector_ready
            if time.monotonic() - checked > 60:
                ready = connector_call("ready")
                _connector_ready = (time.monotonic(), ready)
            return ready
        return False

    def send_verification(self, recipient, code):
        if not self.configured():
            raise MailUnavailable()
        subject = "Votre code de vérification SPILOVEURE"
        text = (
            f"Votre code SPILOVEURE est : {code}\n\n"
            "Il expire dans 10 minutes et ne peut être utilisé qu’une fois.\n"
            "Ne communiquez jamais ce code à une autre personne.\n"
            "Si vous n’avez pas demandé ce code, ignorez ce message."
        )
        provider = os.getenv("MAIL_PROVIDER", "").lower()
        try:
            if provider in ("resend", "resend_connector"):
                body = {"from": os.environ["MAIL_FROM"], "to": [recipient], "subject": subject, "text": text}
                if provider == "resend_connector":
                    if not connector_call("send", body):
                        raise MailUnavailable()
                    return
                with httpx.Client(timeout=15) as client:
                    response = client.post(
                        "https://api.resend.com/emails", json=body,
                        headers={"Authorization": "Bearer " + os.environ["RESEND_API_KEY"],
                                 "User-Agent": "SPILOVEURE"},
                    )
                    response.raise_for_status()
                    if not response.json().get("id"):
                        raise MailUnavailable()
            else:
                msg = EmailMessage()
                msg["From"], msg["To"], msg["Subject"] = os.environ["MAIL_FROM"], recipient, subject
                msg.set_content(text)
                port = int(os.getenv("SMTP_PORT", "587"))
                context = ssl.create_default_context()
                factory = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
                kwargs = {"context": context} if port == 465 else {}
                with factory(os.environ["SMTP_HOST"], port, timeout=15, **kwargs) as client:
                    if port != 465:
                        client.starttls(context=context)
                    client.login(os.environ["SMTP_USERNAME"], os.environ["SMTP_PASSWORD"])
                    client.send_message(msg)
        except Exception:
            # Provider responses may include addresses or credentials. Never
            # propagate their content to logs or the browser.
            raise MailUnavailable() from None
