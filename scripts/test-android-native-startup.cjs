const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const indexSource = fs.readFileSync("frontend/app/index.tsx", "utf8");
const layoutSource = fs.readFileSync("frontend/app/_layout.tsx", "utf8");
const managerSource = fs.readFileSync("frontend/src/components/AndroidApkUpdateManager.android.tsx", "utf8");
const packageJson = JSON.parse(fs.readFileSync("frontend/package.json", "utf8"));

function loadReleaseUtils() {
  const source = fs.readFileSync("frontend/src/utils/androidApkRelease.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL });
  return exports;
}

test("Android launches Expo routes instead of a WebView", () => {
  assert.doesNotMatch(indexSource, /AndroidWebApp|react-native-webview/);
  assert.match(indexSource, /return\s*<ExpoIndex\s*\/>/);
  assert.match(layoutSource, /<AndroidApkUpdateManager\s*\/>/);
  assert.doesNotMatch(managerSource, /WebView|ReactNativeWebView/);
  assert.equal(packageJson.dependencies["react-native-webview"], undefined);
});

test("native updater retains secure APK download and install flow", () => {
  assert.match(managerSource, /expo-file-system\/legacy/);
  assert.match(managerSource, /expo-intent-launcher/);
  assert.match(managerSource, /application\/vnd\.android\.package-archive/);
  assert.match(managerSource, /android\.settings\.MANAGE_UNKNOWN_APP_SOURCES/);
  assert.match(managerSource, /totalBytesWritten/);
  assert.match(managerSource, /onRequestClose/);
});

test("mandatory update honors the minimum supported APK version", () => {
  const { compareAppVersions, requiresMandatoryApkUpdate } = loadReleaseUtils();
  assert.equal(compareAppVersions("1.1.5", "1.1.4"), 1);
  assert.equal(requiresMandatoryApkUpdate("1.1.4", {
    apk_url: "/api/releases/spiloveure.apk",
    apk_version: "1.1.5",
    apk_minimum_supported_version: "1.1.5",
    apk_mandatory: true,
  }), true);
  assert.equal(requiresMandatoryApkUpdate("1.1.5", {
    apk_url: "/api/releases/spiloveure.apk",
    apk_version: "1.1.5",
    apk_minimum_supported_version: "1.1.5",
    apk_mandatory: true,
  }), false);
  assert.equal(requiresMandatoryApkUpdate("1.1.4", {
    apk_url: "/api/releases/spiloveure.apk",
    apk_version: "1.1.5",
    apk_minimum_supported_version: "1.1.5",
    apk_mandatory: false,
  }), false);
});

test("APK update links must be HTTPS APKs from the configured backend", () => {
  const { validateApkUrl } = loadReleaseUtils();
  assert.equal(
    validateApkUrl("/api/uploads/release.apk", "https://spiloveure.org"),
    "https://spiloveure.org/api/uploads/release.apk",
  );
  assert.throws(
    () => validateApkUrl("https://attacker.invalid/release.apk", "https://spiloveure.org"),
    /domaine HTTPS/,
  );
  assert.throws(
    () => validateApkUrl("https://spiloveure.org/release.zip", "https://spiloveure.org"),
    /fichier APK/,
  );
});
