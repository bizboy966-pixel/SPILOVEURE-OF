FROM node:22-trixie-slim

ARG ANDROID_CMDLINE_TOOLS_VERSION=16111833
ARG ANDROID_CMDLINE_TOOLS_SHA1=e025545c62a8e64c7559119566a569fb1dec5f60

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0:/usr/lib/jvm/java-21-openjdk-amd64/bin:${PATH} \
    CI=1 \
    EXPO_NO_TELEMETRY=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl openjdk-21-jdk-headless unzip libc++1 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" /root/.android \
    && touch /root/.android/repositories.cfg \
    && curl --fail --location --silent --show-error --retry 3 \
        "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" \
        -o /tmp/android-commandline-tools.zip \
    && echo "${ANDROID_CMDLINE_TOOLS_SHA1}  /tmp/android-commandline-tools.zip" | sha1sum --check --status \
    && unzip -q /tmp/android-commandline-tools.zip -d /tmp/android-commandline-tools \
    && mv /tmp/android-commandline-tools/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm -rf /tmp/android-commandline-tools /tmp/android-commandline-tools.zip \
    && yes | sdkmanager --sdk_root="${ANDROID_HOME}" --licenses >/dev/null \
    && sdkmanager --sdk_root="${ANDROID_HOME}" --install \
        "platform-tools" "platforms;android-35" "build-tools;35.0.0" "build-tools;34.0.0"

RUN corepack enable \
    && corepack prepare pnpm@10.26.1 --activate

WORKDIR /workspace
COPY . /workspace
RUN pnpm install --frozen-lockfile \
        --filter @workspace/capacitor-android... \
        --filter frontend...

CMD ["pnpm", "--filter", "@workspace/capacitor-android", "run", "apk:build"]
