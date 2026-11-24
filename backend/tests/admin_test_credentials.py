"""Credentials for optional live-admin integration tests.

Set SPILOVEURE_TEST_ADMIN_EMAIL and SPILOVEURE_TEST_ADMIN_PASSWORD in the
test environment. Never store production credentials in the test sources.
"""
import os

import pytest


def get_admin_credentials():
    email = os.getenv("SPILOVEURE_TEST_ADMIN_EMAIL")
    password = os.getenv("SPILOVEURE_TEST_ADMIN_PASSWORD")
    if not email or not password:
        pytest.skip(
            "Set SPILOVEURE_TEST_ADMIN_EMAIL and SPILOVEURE_TEST_ADMIN_PASSWORD "
            "to run live-admin integration tests.",
            allow_module_level=True,
        )
    return email, password
