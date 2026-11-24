"""Native Resend transport checks, without real credentials or deliveries."""
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

import email_delivery
from email_delivery import MailUnavailable, VerificationEmailSender


def configure(monkeypatch):
    monkeypatch.setenv("MAIL_PROVIDER", "resend")
    monkeypatch.setenv("MAIL_FROM", "SPILOVEURE <no-reply@spiloveure.org>")
    monkeypatch.setenv("MAIL_DOMAIN_VERIFIED", "1")
    monkeypatch.setenv("RESEND_API_KEY", "not-a-real-test-key")


def test_native_resend_uses_compatible_user_agent(monkeypatch):
    configure(monkeypatch)
    calls = []

    def post(url, *, json, headers):
        calls.append(url)
        assert url == "https://api.resend.com/emails"
        assert headers["User-Agent"] == "Replit"
        assert headers["Authorization"] == "Bearer not-a-real-test-key"
        assert json["from"] == "SPILOVEURE <no-reply@spiloveure.org>"
        assert json["to"] == ["recipient@example.invalid"]
        assert "123456" in json["text"]
        return SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: {"id": "test-message"}
        )

    @contextmanager
    def client(**kwargs):
        yield SimpleNamespace(post=post)

    monkeypatch.setattr(email_delivery.httpx, "Client", client)
    VerificationEmailSender().send_verification("recipient@example.invalid", "123456")
    assert len(calls) == 1


def test_native_resend_requires_domain_confirmation(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv("MAIL_DOMAIN_VERIFIED", "0")
    sender = VerificationEmailSender()
    assert not sender.configured()
    with pytest.raises(MailUnavailable):
        sender.send_verification("recipient@example.invalid", "123456")


def test_native_resend_does_not_expose_provider_errors(monkeypatch, capsys):
    configure(monkeypatch)

    def post(*args, **kwargs):
        raise RuntimeError("private-provider-response-not-for-the-browser")

    @contextmanager
    def client(**kwargs):
        yield SimpleNamespace(post=post)

    monkeypatch.setattr(email_delivery.httpx, "Client", client)
    with pytest.raises(MailUnavailable) as error:
        VerificationEmailSender().send_verification("recipient@example.invalid", "123456")
    assert str(error.value) == ""
    assert capsys.readouterr() == ("", "")


def test_native_resend_classifies_authorization_failure_without_provider_body(monkeypatch):
    configure(monkeypatch)

    def post(url, *, json, headers):
        request = email_delivery.httpx.Request("POST", url)
        response = email_delivery.httpx.Response(
            401, request=request, text="private response with sensitive details",
        )
        raise email_delivery.httpx.HTTPStatusError(
            "private provider error", request=request, response=response,
        )

    @contextmanager
    def client(**kwargs):
        yield SimpleNamespace(post=post)

    monkeypatch.setattr(email_delivery.httpx, "Client", client)
    with pytest.raises(MailUnavailable) as error:
        VerificationEmailSender().send_password_reset("recipient@example.invalid", "123456")
    assert error.value.category == "resend_authorization_rejected"
    assert "private" not in str(error.value)
