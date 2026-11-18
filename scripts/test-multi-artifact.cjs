const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const read = file => fs.readFileSync(file, "utf8");
const config = require("../frontend/app.config.js");
const app = require("../frontend/app.json").expo;
const eas = require("../frontend/eas.json");
const pkg = require("../frontend/package.json");
const root = require("../package.json");

// No credentials, database, EAS account or network requests are needed.
assert.equal(app.android.package, "com.spilivere.app");
assert.equal(app.ios.bundleIdentifier, "com.spilivere.app");
assert.equal(app.extra.eas.projectId, "1e5fdbe4-3e45-4d2b-9918-e6c8c7dfe877");
assert.equal(pkg.main, "expo-router/entry");
assert.equal(pkg.dependencies.expo, "~54.0.35");
assert.equal(pkg.dependencies["react-native"], "0.81.5");
assert.equal(root.packageManager, "pnpm@10.26.1");
assert.match(root.scripts["eas-build-pre-install"], /eas-test-lockfile/);
assert.match(pkg.scripts["eas-build-pre-install"], /eas-test-lockfile/);
assert.ok(!root.scripts.preinstall.includes("rm "));

for (const key of ["SPV_ANDROID_TEST", "SPV_ANDROID_RELEASE", "EXPO_PUBLIC_TEST_BUILD",
  "EXPO_PUBLIC_BACKEND_URL", "ANDROID_VERSION_CODE"]) delete process.env[key];
assert.equal(config().android.package, app.android.package);
Object.assign(process.env, eas.build["production-apk"].env);
const release = config();
assert.equal(release.android.package, app.android.package);
assert.equal(release.android.versionCode, Number(eas.build["production-apk"].env.ANDROID_VERSION_CODE));
assert.equal(release.version, app.version);
assert.equal(eas.build["production-apk"].env.EXPO_PUBLIC_BACKEND_URL, "https://spiloveure.org");
assert.equal(eas.build["production-apk"].credentialsSource, "remote");
assert.equal(eas.build["production-apk"].android.buildType, "apk");
delete process.env.SPV_ANDROID_RELEASE;
Object.assign(process.env, eas.build["test-apk"].env);
assert.equal(config().android.package, `${app.android.package}.preview`);
assert.equal(config().extra.eas.projectId, app.extra.eas.projectId);

for (const profile of ["test-apk", "production-apk"]) {
  execFileSync(process.execPath, ["scripts/eas-test-lockfile.cjs"], {
    env: { ...process.env, EAS_BUILD_PROFILE: profile, EAS_BUILD_PLATFORM: "android" },
    stdio: "pipe",
  });
}

for (const entry of [app.icon, app.web.favicon, app.android.adaptiveIcon.foregroundImage,
  "./plugins/withAndroidSecurity.js"]) {
  assert.ok(fs.existsSync(path.join("frontend", entry)), entry);
}
const command = require("../artifacts/spiloveure-web/package.json").scripts.dev;
assert.match(command, /SPV_PREVIEW_MODE=vps/);
assert.match(command, /SPV_PREVIEW_API_UPSTREAM=https:\/\/spiloveure\.org/);
assert.match(command, /bash scripts\/start-dev.sh/);
assert.match(read("scripts/start-dev.sh"), /pnpm exec expo start --web/);
assert.doesNotMatch(read("scripts/post-merge.sh"), /(?:db push|drizzle|seed|ssh|rsync)/);
const firebaseCredentialPath = "backend/secrets/firebase-service-account.json";
let firebaseCredentialIsTracked = true;
try {
  execFileSync("git", ["ls-files", "--error-unmatch", firebaseCredentialPath], { stdio: "ignore" });
} catch {
  firebaseCredentialIsTracked = false;
}
assert.equal(firebaseCredentialIsTracked, false,
  "Firebase service-account credentials must not be committed to source");
assert.doesNotThrow(() => {
  execFileSync("git", ["check-ignore", "--quiet", firebaseCredentialPath], { stdio: "ignore" });
}, "Local Firebase service-account credentials must remain ignored");
assert.match(read(".gitignore"), /\*\*\/\*service-account\*\.json/);
assert.match(read(".replitignore"), /\*\*\/\*service-account\*\.json/);

// Explicit opt-in only: future changes must not match an obsolete snapshot.
const backup = ".migration-backup";
if (process.argv.includes("--check-backup-parity")) {
  assert.ok(fs.existsSync(`${backup}/frontend`), "Migration backup required for the one-time parity check");
  for (const file of ["frontend/app.json", "frontend/eas.json", "frontend/app.config.js",
    "frontend/yarn.lock", "yarn.lock", "backend/android_releases.py"]) {
    assert.equal(read(file), read(`${backup}/${file}`), `Unchanged: ${file}`);
  }
  for (const dir of ["frontend/app", "frontend/src", "frontend/assets", "frontend/plugins", "backend"]) {
    for (const file of fs.readdirSync(`${backup}/${dir}`, { recursive: true })) {
      const source = path.join(backup, dir, file);
      if (!fs.statSync(source).isFile() || file.includes("__pycache__") || file.endsWith(".pyc")) continue;
      // Ignore untracked runtime/generated files in the backup.
      if (!/\.(tsx?|jsx?|cjs|mjs|py|json|png|jpg|jpeg|svg|webp|ttf|otf|txt)$/.test(file)) continue;
      assert.deepEqual(fs.readFileSync(path.join(dir, file)), fs.readFileSync(source), `Unchanged: ${dir}/${file}`);
    }
  }
}
console.log("Multi-artifact compatibility: Expo identity, EAS profiles and safe VPS startup passed.");
