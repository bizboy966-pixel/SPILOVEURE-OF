// Build the existing Expo app for Android; do not fork accounts or the backend.
const base = require("./app.json").expo;

module.exports = () => {
  const androidRelease = process.env.SPV_ANDROID_RELEASE === "1";
  const backend = process.env.EXPO_PUBLIC_BACKEND_URL || "";
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
    name: "SPILOVEURE",
    plugins: [...base.plugins, "./plugins/withAndroidSecurity"],
    android: {
      ...base.android,
      versionCode: Number(process.env.ANDROID_VERSION_CODE || 1),
      // Internet is inherent to the platform. Request mic only when voice is used.
      permissions: ["android.permission.RECORD_AUDIO", "android.permission.POST_NOTIFICATIONS"],
      blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE"],
      allowBackup: false,
    },
  };
};
