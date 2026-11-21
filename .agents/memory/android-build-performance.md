---
name: Android build performance
description: Android SDK layout and long builds in this Replit workspace.
---

Metro web export and the first Gradle release build can appear idle for more than 15 minutes while reading project or Nix-store files.

The Nix Android SDK package exposes the SDK under `libexec/android-sdk` inside its output. This app’s release build needs platform 35 and Build Tools 34.0.0 as well as 35.0.0; Gradle’s release lint may fail if 34.0.0 is missing.

The temporary SDK link under `/tmp` can disappear after a Replit environment refresh, even while the Nix package remains cached.

**Why:** A previous Capacitor build failed when Gradle was pointed at the package root, when only Build Tools 35.0.0 was present, and when a refreshed environment removed the temporary SDK link. The first Gradle release build can also spend more than 15 minutes reading project or Nix-store files.

**How to apply:** Recreate and verify the SDK link after environment refresh. Point `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and Gradle’s `sdk.dir` at the nested SDK root; include platform 35 and Build Tools 34.0.0/35.0.0. Run Gradle assembly in the background, monitor actual output, avoid duplicate builds, and verify final APK metadata and signature.
