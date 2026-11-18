// Build the existing Expo app for Android; do not fork accounts or the backend.
const base = require("./app.json").expo;

module.exports = () => {
  const androidRelease = process.env.SPV_ANDROID_RELEASE === "1";
  const androidTest = process.env.SPV_ANDROID_TEST === "1";
  const backend = process.env.EXPO_PUBLIC_BACKEND_URL || "";
  if (androidRelease && androidTest) {
    throw new Error("A build cannot be both a production release and an isolated test.");
  }
  if (androidTest) {
    let url;
    try { url = new URL(backend); } catch { throw new Error("The isolated Android test requires its Replit HTTPS backend."); }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".replit.dev") ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Isolated Android test refused: only a Replit development origin is allowed.");
    }
    if (process.env.EXPO_PUBLIC_TEST_BUILD !== "1") {
      throw new Error("The isolated Android build must enable its test-only client safeguards.");
    }
  }
  if (androidRelease) {
    let url;
    try { url = new URL(backend); } catch { throw new Error("EXPO_PUBLIC_BACKEND_URL must be the official HTTPS origin for an Android release."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        /(^localhost$|127\.0\.0\.1|\.replit\.dev$|\.preview\.)/i.test(url.hostname)) {
      throw new Error("Android release refused: configure the official HTTPS backend, not a preview or local server.");
    }
    if (!/^[1-9]\d*$/.test(process.env.ANDROID_VERSION_CODE || "")) {
      throw new Error("ANDROID_VERSION_CODE must be an explicit positive integer for an Android release.");
    }
  }
  return {
    ...base,
    name: androidTest ? "SPILOVEURE TEST" : "SPILOVEURE",
    scheme: androidTest ? "spiloveure-test" : base.scheme,
    ...(androidTest ? {
      ios: { ...base.ios, bundleIdentifier: `${base.ios.bundleIdentifier}.preview` },
      updates: { enabled: false },
    } : {}),
    plugins: [...base.plugins, "./plugins/withAndroidSecurity"],
    android: {
      ...base.android,
      package: androidTest ? `${base.android.package}.preview` : base.android.package,
      versionCode: Number(process.env.ANDROID_VERSION_CODE || 1),
      // Web media capture asks for mic/camera only when the site uses them.
      permissions: [
        "android.permission.RECORD_AUDIO",
        "android.permission.CAMERA",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.REQUEST_INSTALL_PACKAGES",
      ],
      blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE"],
      allowBackup: false,
    },
  };
};
