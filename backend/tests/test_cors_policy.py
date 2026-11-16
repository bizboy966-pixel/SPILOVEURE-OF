import pytest

from cors_policy import DEFAULT_CORS_ORIGIN, cors_origins


def test_cors_origins_defaults_to_the_public_site(monkeypatch):
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    assert cors_origins() == [DEFAULT_CORS_ORIGIN]


def test_cors_origins_accepts_only_explicit_origins():
    assert cors_origins("https://spiloveure.org, https://test.spiloveure.org") == [
        "https://spiloveure.org",
        "https://test.spiloveure.org",
    ]
    assert cors_origins("https://spiloveure.org:443/") == ["https://spiloveure.org"]


@pytest.mark.parametrize(
    "value",
    [
        "*",
        "https://*.spiloveure.org",
        "https://spiloveure.org/api",
        "https://user:password@spiloveure.org",
        "javascript://spiloveure.org",
    ],
)
def test_cors_origins_rejects_wildcards_and_non_origins(value):
    with pytest.raises(ValueError):
        cors_origins(value)
