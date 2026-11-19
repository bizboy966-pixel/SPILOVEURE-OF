FROM python:3.11-slim

ARG ANDROID_BUILD_TOOLS_VERSION=35.0.0
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_APKSIGNER=/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS_VERSION}/apksigner \
    ANDROID_AAPT=/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS_VERSION}/aapt \
    PATH=/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS_VERSION}:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl openjdk-21-jre-headless unzip \
    && rm -rf /var/lib/apt/lists/*

# Include Google's official Android Build Tools in the backend image because
# APK publication validates signatures inside this container, not on the host.
# Pin and verify the archive so production rebuilds use identical tools.
RUN mkdir -p /tmp/android-build-tools /opt/android-sdk/build-tools \
    && curl --fail --location --silent --show-error --retry 3 \
        https://dl.google.com/android/repository/build-tools_r35_linux.zip \
        -o /tmp/android-build-tools.zip \
    && echo "bd3a4966912eb8b30ed0d00b0cda6b6543b949d5ffe00bea54c04c81e1561d88  /tmp/android-build-tools.zip" \
        | sha256sum --check --status \
    && unzip -q /tmp/android-build-tools.zip -d /tmp/android-build-tools \
    && mv /tmp/android-build-tools/android-15 \
        "/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS_VERSION}" \
    && rm -rf /tmp/android-build-tools /tmp/android-build-tools.zip \
    && test -x "$ANDROID_APKSIGNER" \
    && test -x "$ANDROID_AAPT" \
    && "$ANDROID_APKSIGNER" version \
    && "$ANDROID_AAPT" version

WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/

COPY backend/ /app/backend/
COPY frontend/app.json /app/frontend/app.json

EXPOSE 8001
# 1 worker only: background loops (payment polling, notifications) must not run twice.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
