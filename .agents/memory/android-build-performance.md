---
name: Android build performance
description: Handling long Expo and Gradle build startup in this Replit workspace.
---

Metro web export and the first Gradle release build can appear idle for more than 15 minutes while reading project or Nix-store files.

**Why:** A Capacitor test build on 2026-11-19 spent extended periods in filesystem waits before emitting build output; stopping it at a short timeout would have interrupted a still-running process.

**How to apply:** Run Metro export and Gradle release assembly as background tasks, monitor their actual output and process state, avoid duplicate exports, and verify the final APK metadata and signature before delivery.
