const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const root = path.resolve(__dirname, "../../..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

function loadTypeScript(relative) {
  const module = { exports: {} };
  const code = transformSync(read(relative), { loader: "ts", format: "cjs", target: "es2020" }).code;
  vm.runInNewContext(code, { module, exports: module.exports, URL, setTimeout });
  return module.exports;
}

test("mandatory update detection compares the installed app to the published minimum", () => {
  const { requiresMandatoryApkUpdate } = loadTypeScript("frontend/src/utils/androidApkRelease.ts");
  const release = {
    apk_url: "https://spiloveure.org/api/uploads/spiloveure-1.1.16.apk",
    apk_version: "1.1.16",
    apk_minimum_supported_version: "1.1.16",
    apk_mandatory: true,
  };

  assert.equal(requiresMandatoryApkUpdate("1.1.15", release), true);
  assert.equal(requiresMandatoryApkUpdate("1.1.16", release), false);
  assert.equal(requiresMandatoryApkUpdate("1.1.17", release), false);
  assert.equal(requiresMandatoryApkUpdate("1.1.15", { ...release, apk_mandatory: false }), false);
});

test("Capacitor update manager checks on startup and blocks until the required update", () => {
  const component = read("frontend/src/components/AndroidApkUpdateManager.tsx");
  assert.match(component, /getNativeInstaller\(\)/);
  assert.match(component, /void checkRelease\(\)/);
  assert.match(component, /spv-capacitor-app-state/);
  assert.match(component, /Mise à jour disponible/);
  assert.match(component, /Une mise à jour est disponible\. Veuillez mettre votre application à jour pour continuer\./);
  assert.match(component, /onRequestClose=\{\(\) =>/);
  assert.match(component, /android-apk-update-start/);
  assert.match(component, /await installDownloadedApk\(\)/);
});

test("native download reports measured byte progress and requests installation", async () => {
  const { downloadApkWithProgress, requestApkInstall } =
    loadTypeScript("frontend/src/utils/capacitorApkUpdate.ts");
  const seen = [];
  const calls = [];
  const statuses = [
    { status: "running", bytesDownloaded: 3, totalBytes: 10 },
    { status: "success", bytesDownloaded: 10, totalBytes: 10 },
  ];
  const bridge = {
    async startDownload(options) {
      calls.push(["start", options]);
      return { downloadId: 42 };
    },
    async getDownloadStatus(options) {
      calls.push(["status", options]);
      return statuses.shift();
    },
    async installDownloadedApk(options) {
      calls.push(["install", options]);
      return { status: "installing" };
    },
  };
  const id = await downloadApkWithProgress(
    bridge,
    "https://spiloveure.org/api/uploads/spiloveure-1.1.16.apk",
    "1.1.16",
    progress => seen.push(progress),
    async () => {},
  );
  const install = await requestApkInstall(bridge, id);

  assert.equal(id, 42);
  assert.equal(calls[0][1].fileName, "SPILOVEURE-1.1.16.apk");
  assert.ok(seen.some(progress => progress.percent === 30));
  assert.equal(seen.at(-1).percent, 100);
  assert.deepEqual(install, { status: "installing" });
  assert.equal(calls.at(-1)[0], "install");
  assert.equal(calls.at(-1)[1].downloadId, 42);
});

test("failed native download never opens the Android installer", async () => {
  const { downloadApkWithProgress } = loadTypeScript("frontend/src/utils/capacitorApkUpdate.ts");
  let installCalls = 0;
  const bridge = {
    async startDownload() { return { downloadId: 7 }; },
    async getDownloadStatus() {
      return { status: "failed", bytesDownloaded: 0, totalBytes: 8, error: "network error" };
    },
    async installDownloadedApk() { installCalls += 1; return { status: "installing" }; },
  };
  await assert.rejects(
    downloadApkWithProgress(bridge, "https://spiloveure.org/a.apk", "1.1.16", () => {}, async () => {}),
    /network error/,
  );
  assert.equal(installCalls, 0);
});

test("native installer reports Android's required confirmation path", async () => {
  const { requestApkInstall } = loadTypeScript("frontend/src/utils/capacitorApkUpdate.ts");
  const result = await requestApkInstall({
    async startDownload() { return { downloadId: 1 }; },
    async getDownloadStatus() { return { status: "success", bytesDownloaded: 1, totalBytes: 1 }; },
    async installDownloadedApk() { return { status: "permission_required" }; },
  }, 1);
  assert.equal(result.status, "permission_required");
});

test("Android installer handles confirmation and relaunches after successful replacement", () => {
  const plugin = read("tools/capacitor-android/android/app/src/main/java/com/spilivere/app/ApkInstallerPlugin.java");
  const receiver = read("tools/capacitor-android/android/app/src/main/java/com/spilivere/app/ApkInstallResultReceiver.java");
  const manifest = read("tools/capacitor-android/android/app/src/main/AndroidManifest.xml");

  assert.match(plugin, /getDownloadStatus/);
  assert.match(plugin, /PackageInstaller\.Session/);
  assert.match(plugin, /USER_ACTION_REQUIRED/);
  assert.match(plugin, /permission_required/);
  assert.match(plugin, /session\.commit/);
  assert.match(receiver, /STATUS_PENDING_USER_ACTION/);
  assert.match(receiver, /startActivity\(confirmation\)/);
  assert.match(receiver, /STATUS_SUCCESS/);
  assert.match(receiver, /getLaunchIntentForPackage/);
  assert.match(receiver, /shouldRelaunchApp/);
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(manifest, /android:name="\.ApkInstallResultReceiver"[\s\S]*android:exported="false"/);
});
