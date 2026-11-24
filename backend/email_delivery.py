"""Replaceable transactional mail adapters. Never log verification codes."""
from __future__ import annotations

import os
import json
import smtplib
import ssl
import subprocess
import time
from pathlib import Path
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import parsedate_to_datetime

import httpx


class MailUnavailable(Exception):
    def __init__(self, category="mail_unavailable", retry_after_seconds=None):
        self.category = category
        self.retry_after_seconds = retry_after_seconds
        super().__init__()


def _retry_after_seconds(response):
    value = response.headers.get("Retry-After", "").strip()
    if value:
        try:
            return min(max(int(float(value)), 1), 3600)
        except (TypeError, ValueError):
            try:
                retry_at = parsedate_to_datetime(value)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                seconds = int((retry_at - datetime.now(timezone.utc)).total_seconds())
                return min(max(seconds, 1), 3600)
            except (TypeError, ValueError, OverflowError):
                pass
    return 60


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
        subject = "Votre code de vérification SPILOVEURE"
        text = (
            f"Votre code SPILOVEURE est : {code}\n\n"
            "Il expire dans 10 minutes et ne peut être utilisé qu’une fois.\n"
            "Ne communiquez jamais ce code à une autre personne.\n"
            "Si vous n’avez pas demandé ce code, ignorez ce message."
        )
        self._send_message(recipient, subject, text)

    def send_password_reset(self, recipient, code):
        self._send_message(recipient, "Réinitialisation de votre mot de passe SPILOVEURE", (
            f"Votre code de réinitialisation SPILOVEURE est : {code}\n\n"
            "Saisissez-le sur la page « Mot de passe oublié », puis choisissez un nouveau mot de passe.\n"
            "Ce code expire dans 10 minutes et ne peut être utilisé qu’une fois.\n"
            "Ne partagez jamais ce code. L’équipe SPILOVEURE ne vous le demandera pas.\n"
            "Si vous n’avez pas demandé cette réinitialisation, ignorez ce message : votre mot de passe ne sera pas modifié."
        ))

    def _send_message(self, recipient, subject, text):
        if not self.configured():
            raise MailUnavailable("mailer_not_configured")
        provider = os.getenv("MAIL_PROVIDER", "").lower()
        try:
            if provider in ("resend", "resend_connector"):
                body = {"from": os.environ["MAIL_FROM"], "to": [recipient], "subject": subject, "text": text}
                if provider == "resend_connector":
                    if not connector_call("send", body):
                        raise MailUnavailable("resend_connector_failed")
                    return
                with httpx.Client(timeout=15) as client:
                    response = client.post(
                        "https://api.resend.com/emails", json=body,
                        headers={"Authorization": "Bearer " + os.environ["RESEND_API_KEY"],
                                 "User-Agent": "Replit"},
                    )
                    response.raise_for_status()
                    if not response.json().get("id"):
                        raise MailUnavailable("resend_invalid_response")
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
        except MailUnavailable:
            raise
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in (401, 403):
                category = "resend_authorization_rejected"
            elif status == 422:
                category = "resend_request_rejected"
            elif status == 429:
                raise MailUnavailable(
                    "resend_rate_limited", _retry_after_seconds(exc.response)
                ) from None
            elif status >= 500:
                category = "resend_unavailable"
            else:
                category = "resend_rejected"
            raise MailUnavailable(category) from None
        except (httpx.TimeoutException, httpx.TransportError):
            raise MailUnavailable("mail_provider_unreachable") from None
        except smtplib.SMTPAuthenticationError:
            raise MailUnavailable("smtp_authentication_rejected") from None
        except smtplib.SMTPRecipientsRefused:
            raise MailUnavailable("smtp_recipient_rejected") from None
        except smtplib.SMTPResponseException:
            raise MailUnavailable("smtp_request_rejected") from None
        except (KeyError, ValueError):
            raise MailUnavailable("mail_configuration_invalid") from None
        except Exception:
            # Provider responses may include addresses or credentials. Never
            # propagate their content to logs or the browser.
            raise MailUnavailable("mail_provider_error") from None
